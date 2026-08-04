import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter, serializeFrontmatter } from "../src/store/frontmatter.ts";
import { loadSettings, saveSettings } from "../src/store/settings.ts";
import { createCampaign, listCampaigns, loadCampaign, updateCampaignMeta, appendStorySoFar } from "../src/store/campaigns.ts";
import { createSession, listSessions, setSessionStatus, trashSession } from "../src/store/sessions.ts";
import { loadChatLog, appendChatMessage, saveChatLog, clearChatLog, chatLogPath } from "../src/store/chat-log.ts";
import { loadOneshotPrompt, loadSystemPrompt } from "../src/store/system-prompt.ts";

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
});

describe("system prompts", () => {
  test("creates the base system prompt file with the default when missing", async () => {
    const path = join(dir, "prompts", "system-prompt.md");
    const prompt = await loadSystemPrompt(path);
    expect(prompt).toContain("You are Scribe");
    expect(await readFile(path, "utf8")).toBe(prompt);
  });

  test("creates the oneshot prompt file with the default when missing", async () => {
    const path = join(dir, "prompts", "oneshot-prompt.md");
    const prompt = await loadOneshotPrompt(path);
    expect(prompt).toContain("one-shots");
    expect(await readFile(path, "utf8")).toBe(prompt);
  });

  test("reads an existing oneshot prompt file untouched", async () => {
    const path = join(dir, "oneshot-prompt.md");
    await Bun.write(path, "custom oneshot prompt");
    expect(await loadOneshotPrompt(path)).toBe("custom oneshot prompt");
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

describe("sessions", () => {
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
    await appendChatMessage(campaign.dir, 1, "plan", { role: "user", content: "hi" });
    await appendChatMessage(campaign.dir, 1, "plan", { role: "assistant", content: "hello" });

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
    await appendChatMessage(campaign.dir, 1, "plan", { role: "user", content: "plan msg" });
    await appendChatMessage(campaign.dir, 2, "report", { role: "user", content: "report msg" });

    expect(await loadChatLog(campaign.dir, 1, "plan")).toHaveLength(1);
    expect(await loadChatLog(campaign.dir, 2, "plan")).toEqual([]);
    expect(await loadChatLog(campaign.dir, 2, "report")).toHaveLength(1);
  });
});
