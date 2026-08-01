import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter, serializeFrontmatter } from "../src/store/frontmatter.ts";
import { loadSettings } from "../src/store/settings.ts";
import { createCampaign, listCampaigns, loadCampaign, updateCampaignMeta } from "../src/store/campaigns.ts";
import { createSession, listSessions, setSessionStatus, trashSession } from "../src/store/sessions.ts";

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
    expect(data.name).toBe("Strahd");
    expect(data.system).toBe("D&D 5e");
    expect(body).toBe("## Background\n\nhi\n");
  });

  test("parses values containing colons", () => {
    const { data } = parseFrontmatter("---\nurl: http://x:8080/y\n---\nbody");
    expect(data.url).toBe("http://x:8080/y");
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
