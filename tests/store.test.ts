import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter, serializeFrontmatter, updateFrontmatterFile } from "../src/store/frontmatter.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { createCampaign, listCampaigns, loadCampaign, updateCampaignMeta, appendStorySoFar } from "../src/store/campaigns.ts";
import { createSession, listSessions, setSessionStatus, trashSession } from "../src/store/sessions.ts";
import { loadChatLog, saveChatLog, clearChatLog, chatLogPath } from "../src/store/chat-log.ts";
import { loadInstructions, loadOneshotInstructions, loadPromptOverride } from "../src/store/instructions.ts";
import { saveOneshot } from "../src/store/oneshots.ts";
import { sanitizeFolderName, today, uniqueName } from "../src/store/naming.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scribe-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("frontmatter", () => {
  test("round-trips flat key:value data", () => {
    const doc = serializeFrontmatter({ name: "Strahd", system: "D&D 5e" }, "## Background\n\nhi\n");
    const { data, body } = parseFrontmatter(doc);
    expect(data["name"]).toBe("Strahd");
    expect(data["system"]).toBe("D&D 5e");
    expect(body).toBe("## Background\n\nhi\n");
  });

  test("parses values containing colons", () => {
    const { data } = parseFrontmatter("---\nurl: http://x:8080/y\n---\nbody");
    expect(data["url"]).toBe("http://x:8080/y");
  });

  test("no frontmatter returns empty data and full body", () => {
    const { data, body } = parseFrontmatter("just text\nmore");
    expect(data).toEqual({});
    expect(body).toBe("just text\nmore");
  });

  test("unclosed frontmatter treated as body", () => {
    const { data, body } = parseFrontmatter("---\nname: x\nno fence");
    expect(data).toEqual({});
    expect(body).toBe("---\nname: x\nno fence");
  });

  test("updateFrontmatterFile reads, transforms, and writes back", async () => {
    const path = join(dir, "doc.md");
    await Bun.write(path, serializeFrontmatter({ name: "Strahd", status: "planning" }, "## Body\n\nhi\n"));

    const result = await updateFrontmatterFile(path, (data, body) => ({
      data: { ...data, status: "ready" },
      body: body + "more\n",
    }));
    expect(result.data["status"]).toBe("ready");
    expect(result.data["name"]).toBe("Strahd");
    expect(result.body).toBe("## Body\n\nhi\nmore\n");

    const raw = await readFile(path, "utf8");
    const reparsed = parseFrontmatter(raw);
    expect(reparsed.data["status"]).toBe("ready");
    expect(reparsed.data["name"]).toBe("Strahd");
    expect(reparsed.body).toBe("## Body\n\nhi\nmore\n");
  });
});

describe("settings", () => {
  test("creates config with defaults when missing", async () => {
    const configPath = join(dir, "cfg", "config.json");
    const settings = await loadSettings(configPath);
    expect(settings.campaignsDir.endsWith("Scribe")).toBe(true);

    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.campaignsDir).toBeDefined();
  });

  test("reads existing config and expands ~", async () => {
    const configPath = join(dir, "config.json");
    const settings = await loadSettings(configPath); // creates defaults
    const again = await loadSettings(configPath);
    expect(again.campaignsDir).toBe(settings.campaignsDir);
    expect(again.campaignsDir.startsWith("~")).toBe(false);
  });

  test("corrupt config falls back to defaults", async () => {
    const configPath = join(dir, "config.json");
    await Bun.write(configPath, "{not json");
    const settings = await loadSettings(configPath);
    expect(settings.campaignsDir.endsWith("Scribe")).toBe(true);
  });

  test("saveSettings persists and round-trips", async () => {
    const configPath = join(dir, "config.json");
    const settings = await loadSettings(configPath);
    await saveSettings(
      { ...settings, baseUrl: "http://localhost:1234/v1", model: "my-model", apiKeyEnv: "MY_KEY" },
      configPath,
    );
    const reloaded = await loadSettings(configPath);
    expect(reloaded.baseUrl).toBe("http://localhost:1234/v1");
    expect(reloaded.model).toBe("my-model");
    expect(reloaded.apiKeyEnv).toBe("MY_KEY");
    expect(reloaded.campaignsDir).toBe(settings.campaignsDir);
  });

  test("prompt overrides round-trip and expand ~", async () => {
    const configPath = join(dir, "config.json");
    const settings = await loadSettings(configPath);
    await saveSettings(
      { ...settings, systemPromptOverride: "~/my-core.md", oneshotPromptOverride: "/abs/oneshot.md" },
      configPath,
    );
    const reloaded = await loadSettings(configPath);
    expect(reloaded.systemPromptOverride?.startsWith("~")).toBe(false);
    expect(reloaded.systemPromptOverride?.endsWith("/my-core.md")).toBe(true);
    expect(reloaded.oneshotPromptOverride).toBe("/abs/oneshot.md");
  });
});

describe("user instructions", () => {
  test("missing instructions read as empty and are never created", async () => {
    const path = join(dir, "instructions.md");
    expect(await loadInstructions(path)).toBe("");
    // The whole point of the rework: no file is written, so nothing can go stale.
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("missing one-shot instructions read as empty and are never created", async () => {
    const path = join(dir, "oneshot-instructions.md");
    expect(await loadOneshotInstructions(path)).toBe("");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("reads an existing instructions file verbatim", async () => {
    const path = join(dir, "instructions.md");
    await Bun.write(path, "Always speak like a pirate.\n");
    expect(await loadInstructions(path)).toBe("Always speak like a pirate.\n");
  });

  test("prompt override reads the file, or null when unset/missing/blank", async () => {
    const path = join(dir, "core.md");
    await Bun.write(path, "You are a minimal assistant.\n");
    expect(await loadPromptOverride(path)).toBe("You are a minimal assistant.\n");

    expect(await loadPromptOverride(undefined)).toBeNull();
    expect(await loadPromptOverride(join(dir, "nope.md"))).toBeNull();

    const blank = join(dir, "blank.md");
    await Bun.write(blank, "   \n");
    expect(await loadPromptOverride(blank)).toBeNull();
  });
});

describe("campaigns", () => {
  const input = { name: "Curse of Strahd", system: "D&D 5e", description: "Gothic horror." };

  test("createCampaign writes campaign.md with frontmatter and body", async () => {
    const campaign = await createCampaign(dir, input);
    const raw = await readFile(join(campaign.dir, "campaign.md"), "utf8");

    expect(raw).toContain("name: Curse of Strahd");
    expect(raw).toContain("system: D&D 5e");
    expect(raw).toContain("nextSession: 1");
    expect(raw).toContain("## Background");
    expect(raw).toContain("Gothic horror.");
    expect(raw).toContain("## The Story So Far");
    expect(campaign.nextSession).toBe(1);
  });

  test("campaign folder keeps the human name", async () => {
    const campaign = await createCampaign(dir, input);
    expect(campaign.dir).toBe(join(dir, "Curse of Strahd"));
  });

  test("duplicate names get a unique folder", async () => {
    await createCampaign(dir, input);
    const second = await createCampaign(dir, input);
    expect(second.dir).toBe(join(dir, "Curse of Strahd 2"));
  });

  test("listCampaigns round-trips data and sections", async () => {
    await createCampaign(dir, input);
    await createCampaign(dir, { name: "ToA", system: "D&D 5e", description: "Dinosaurs." });

    const campaigns = await listCampaigns(dir);
    expect(campaigns).toHaveLength(2);
    const strahd = campaigns.find((c) => c.name === "Curse of Strahd")!;
    expect(strahd.system).toBe("D&D 5e");
    expect(strahd.description).toBe("Gothic horror.");
    expect(strahd.storySoFar).toBe("");
    expect(strahd.nextSession).toBe(1);
  });

  test("folders without campaign.md are ignored", async () => {
    await createCampaign(dir, input);
    await Bun.write(join(dir, "random-file.txt"), "hi");
    await Bun.write(join(dir, "random-folder", "x.txt"), "hi");
    expect(await listCampaigns(dir)).toHaveLength(1);
  });

  test("updateCampaignMeta bumps nextSession without touching body", async () => {
    const campaign = await createCampaign(dir, input);
    await updateCampaignMeta(campaign, { nextSession: 3 });
    const reloaded = await loadCampaign(campaign.dir);
    expect(reloaded?.nextSession).toBe(3);
    expect(reloaded?.description).toBe("Gothic horror.");
  });

  test("appendStorySoFar appends to the summary and updates in-memory state", async () => {
    const campaign = await createCampaign(dir, input);
    await appendStorySoFar(campaign, "The party met Strahd at the gates.");
    await appendStorySoFar(campaign, "They escaped the manor alive.");

    const reloaded = (await loadCampaign(campaign.dir))!;
    expect(reloaded.storySoFar).toContain("The party met Strahd at the gates.");
    expect(reloaded.storySoFar).toContain("They escaped the manor alive.");
    // both entries present in order, section preserved
    const idx1 = reloaded.storySoFar.indexOf("Strahd");
    const idx2 = reloaded.storySoFar.indexOf("escaped");
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    // background section untouched
    expect(reloaded.description).toBe("Gothic horror.");
  });
});

describe("naming", () => {
  test("sanitizeFolderName replaces dot-only names that would escape the folder", () => {
    expect(sanitizeFolderName(".")).toBe("Campaign");
    expect(sanitizeFolderName("..")).toBe("Campaign");
    expect(sanitizeFolderName("  ..  ")).toBe("Campaign");
    expect(sanitizeFolderName("")).toBe("Campaign");
    // ordinary names, including ones merely containing dots, are untouched
    expect(sanitizeFolderName("Curse of Strahd")).toBe("Curse of Strahd");
    expect(sanitizeFolderName("Vol. 2")).toBe("Vol. 2");
  });

  test("uniqueName keeps the extension last when disambiguating", () => {
    expect(uniqueName("001-a", ["001-a.md"], { ext: ".md", separator: "-" })).toBe("001-a-2.md");
    expect(uniqueName("Strahd", ["Strahd"])).toBe("Strahd 2");
  });

  test("uniqueName returns the desired name untouched when there is no collision", () => {
    expect(uniqueName("rules", [])).toBe("rules");
    expect(uniqueName("rules", ["other.md"], { ext: ".md" })).toBe("rules.md");
  });

  test("uniqueName walks past multiple collisions to find a free slot", () => {
    expect(
      uniqueName("rules", ["rules", "rules-2", "rules-3"], { separator: "-" }),
    ).toBe("rules-4");
  });

  test("uniqueName with a bare separator (no ext) matches the sources.ts slug behavior", () => {
    // Two docs that would slugify identically get "-2", "-3", ... suffixes,
    // same as the old private uniqueSlug() in sources.ts.
    expect(uniqueName("rules", ["rules"], { separator: "-" })).toBe("rules-2");
    expect(uniqueName("rules", ["rules", "rules-2"], { separator: "-" })).toBe("rules-3");
  });

  test("today returns an ISO date string", () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("a campaign named '..' stays inside the campaigns folder", async () => {
    const campaign = await createCampaign(dir, { name: "..", system: "5e", description: "" });
    // The campaign dir must be a child of `dir`, not `dir` itself or its parent.
    expect(campaign.dir.startsWith(dir + "/")).toBe(true);
    expect(await readdir(dir)).toEqual(["Campaign"]);
  });
});

describe("sessions", () => {
  test("a colliding session file keeps its .md extension and stays listable", async () => {
    const campaign = await createCampaign(dir, { name: "CoS", system: "5e", description: "" });
    await createSession(campaign, "Death House");
    // Rewind the counter so the next create collides on both number and slug.
    await updateCampaignMeta(campaign, { nextSession: 1 });
    campaign.nextSession = 1;
    const dup = await createSession(campaign, "Death House");

    expect(dup.path.endsWith(".md")).toBe(true);
    const sessions = await listSessions(campaign);
    expect(sessions.map((s) => s.path)).toContain(dup.path);
  });

  test("createSession writes 001-slug.md and bumps nextSession", async () => {
    const campaign = await createCampaign(dir, { name: "CoS", system: "5e", description: "" });
    const session = await createSession(campaign, "Death House");

    expect(session.number).toBe(1);
    expect(session.status).toBe("planning");
    expect(session.path.endsWith(join("sessions", "001-death-house.md"))).toBe(true);

    const raw = await readFile(session.path, "utf8");
    expect(raw).toContain("title: Death House");
    expect(raw).toContain("status: planning");
    expect(raw).toContain("## Plan");
    expect(raw).toContain("## Outcome");

    expect((await loadCampaign(campaign.dir))?.nextSession).toBe(2);
  });

  test("listSessions sorts by number", async () => {
    const campaign = await createCampaign(dir, { name: "CoS", system: "5e", description: "" });
    await createSession(campaign, "One");
    await createSession(campaign, "Two");
    const sessions = await listSessions(campaign);
    expect(sessions.map((s) => s.title)).toEqual(["One", "Two"]);
    expect(sessions.map((s) => s.number)).toEqual([1, 2]);
  });

  test("setSessionStatus updates frontmatter and stamps dates", async () => {
    const campaign = await createCampaign(dir, { name: "CoS", system: "5e", description: "" });
    const session = await createSession(campaign, "One");

    await setSessionStatus(session, "ready");
    let raw = await readFile(session.path, "utf8");
    expect(raw).toContain("status: ready");
    expect(raw).toContain("ready: ");

    await setSessionStatus(session, "played");
    raw = await readFile(session.path, "utf8");
    expect(raw).toContain("status: played");
    expect(raw).toContain("played: ");
    expect(session.status).toBe("played");
  });

  test("trashSession moves the file into .scribe/trash", async () => {
    const campaign = await createCampaign(dir, { name: "CoS", system: "5e", description: "" });
    const session = await createSession(campaign, "One");

    await trashSession(campaign, session);
    expect(await listSessions(campaign)).toHaveLength(0);

    const trashed = await readdir(join(campaign.dir, ".scribe", "trash"));
    expect(trashed).toEqual(["001-one.md"]);
  });
});

describe("chat log", () => {
  async function setup() {
    return createCampaign(dir, { name: "CoS", system: "5e", description: "" });
  }

  test("append/load round-trips messages", async () => {
    const campaign = await setup();
    await saveChatLog(campaign.dir, 1, "plan", [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);

    const loaded = await loadChatLog(campaign.dir, 1, "plan");
    expect(loaded).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  test("loads empty when no log exists", async () => {
    const campaign = await setup();
    expect(await loadChatLog(campaign.dir, 1, "report")).toEqual([]);
  });

  test("skips corrupt lines", async () => {
    const campaign = await setup();
    const path = chatLogPath(campaign.dir, 1, "plan");
    await Bun.write(path, '{"role":"user","content":"ok"}\nnot json\n');
    const loaded = await loadChatLog(campaign.dir, 1, "plan");
    expect(loaded).toEqual([{ role: "user", content: "ok" }]);
  });

  test("save replaces the whole log; clear deletes it", async () => {
    const campaign = await setup();
    await saveChatLog(campaign.dir, 2, "report", [{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
    expect(await loadChatLog(campaign.dir, 2, "report")).toHaveLength(2);

    await clearChatLog(campaign.dir, 2, "report");
    expect(await loadChatLog(campaign.dir, 2, "report")).toEqual([]);
  });

  test("logs are separate per session and mode", async () => {
    const campaign = await setup();
    await saveChatLog(campaign.dir, 1, "plan", [{ role: "user", content: "plan msg" }]);
    await saveChatLog(campaign.dir, 2, "report", [{ role: "user", content: "report msg" }]);

    expect(await loadChatLog(campaign.dir, 1, "plan")).toHaveLength(1);
    expect(await loadChatLog(campaign.dir, 2, "plan")).toEqual([]);
    expect(await loadChatLog(campaign.dir, 2, "report")).toHaveLength(1);
  });
});

describe("saveOneshot", () => {
  test("writes a markdown file with frontmatter and body", async () => {
    const path = await saveOneshot(dir, {
      title: "Lighthouse Siege",
      system: "D&D 5e",
      content: "## Plan\n\nThe keep burns at dawn.",
    });

    expect(path).toBe(join(dir, "lighthouse-siege.md"));
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("title: Lighthouse Siege");
    expect(raw).toContain("system: D&D 5e");
    expect(raw).toContain("created: ");
    expect(raw).toContain("## Plan");
    expect(raw).toContain("The keep burns at dawn.");
  });

  test("slugifies the filename", async () => {
    const path = await saveOneshot(dir, { title: "Lighthouse Siege!", content: "boom" });
    expect(path).toBe(join(dir, "lighthouse-siege.md"));
  });

  test("a second save with the same title writes to -2, leaving the original untouched", async () => {
    const first = await saveOneshot(dir, { title: "Lighthouse Siege", content: "original plan" });
    const second = await saveOneshot(dir, { title: "Lighthouse Siege", content: "second plan" });

    expect(first).toBe(join(dir, "lighthouse-siege.md"));
    expect(second).toBe(join(dir, "lighthouse-siege-2.md"));
    expect(await readFile(first, "utf8")).toContain("original plan");
    expect(await readFile(second, "utf8")).toContain("second plan");
  });

  test("creates a missing target directory", async () => {
    const target = join(dir, "nested", "plans");
    const path = await saveOneshot(target, { title: "Ritual", content: "x" });
    expect(path).toBe(join(target, "ritual.md"));
    expect(await readFile(path, "utf8")).toContain("title: Ritual");
  });

  test("punctuation-only title falls back to oneshot.md", async () => {
    const path = await saveOneshot(dir, { title: "!!!", content: "x" });
    expect(path).toBe(join(dir, "oneshot.md"));
  });
});
