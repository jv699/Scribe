import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildOneshotSystemPrompt,
  buildPlanningSystemPrompt,
  buildReportSystemPrompt,
} from "../src/agent/context.ts";
import { CORE_CAMPAIGN_PROMPT, CORE_ONESHOT_PROMPT } from "../src/agent/prompts.ts";
import type { Campaign } from "../src/store/campaigns.ts";
import type { Session } from "../src/store/sessions.ts";
import type { Settings } from "../src/store/settings.ts";

let dir: string;
let settings: Settings;
let campaign: Campaign;
let session: Session;
let realConfigDir: string | undefined;

/** Instruction files live in the config dir, relocated here via SCRIBE_CONFIG_DIR. */
async function writeConfigFile(name: string, content: string): Promise<string> {
  const path = join(dir, "config", name);
  await Bun.write(path, content);
  return path;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scribe-ctx-"));
  realConfigDir = process.env["SCRIBE_CONFIG_DIR"];
  process.env["SCRIBE_CONFIG_DIR"] = join(dir, "config");

  settings = {
    campaignsDir: join(dir, "Scribe"),
    oneshotsDir: join(dir, "Scribe", "One-Shots"),
    sourcesDir: join(dir, "Scribe", "Sources"),
  };

  campaign = {
    name: "Curse of Strahd",
    system: "D&D 5e",
    description: "Gothic horror in Barovia.",
    storySoFar: "The party arrived in Vallaki.",
    created: "2026-01-01",
    nextSession: 4,
    dir: join(dir, "Scribe", "Curse of Strahd"),
  };

  await mkdir(join(campaign.dir, "sessions"), { recursive: true });
  session = {
    number: 3,
    title: "The Feast of St. Andral",
    status: "planning",
    created: "2026-01-02",
    path: join(campaign.dir, "sessions", "003-the-feast.md"),
  };
  await Bun.write(session.path, "---\nnumber: 3\n---\n# Draft\n\nThe bones are missing.\n");
});

afterEach(async () => {
  if (realConfigDir === undefined) delete process.env["SCRIBE_CONFIG_DIR"];
  else process.env["SCRIBE_CONFIG_DIR"] = realConfigDir;
  await rm(dir, { recursive: true, force: true });
});

describe("prompt assembly", () => {
  test("planning prompt is core + campaign context, with no instructions file", async () => {
    const prompt = await buildPlanningSystemPrompt(campaign, session, settings);
    expect(prompt).toContain(CORE_CAMPAIGN_PROMPT.trim());
    expect(prompt).toContain("Curse of Strahd");
    expect(prompt).toContain("The party arrived in Vallaki.");
    expect(prompt).toContain("The bones are missing.");
    expect(prompt).not.toContain("# User Instructions");
  });

  test("user instructions are appended after the campaign context", async () => {
    await writeConfigFile("instructions.md", "Always address the user as Game Master.\n");
    const prompt = await buildPlanningSystemPrompt(campaign, session, settings);

    expect(prompt).toContain("# User Instructions");
    expect(prompt).toContain("Always address the user as Game Master.");
    // Last layer wins: instructions must come after core and campaign context.
    expect(prompt.indexOf("# User Instructions")).toBeGreaterThan(prompt.indexOf("# Campaign"));
    expect(prompt.indexOf("# Campaign")).toBeGreaterThan(prompt.indexOf("You are Scribe"));
  });

  test("report prompt carries the same core, context, and instructions", async () => {
    await writeConfigFile("instructions.md", "Keep summaries to five bullets.\n");
    const prompt = await buildReportSystemPrompt(campaign, session, settings);

    expect(prompt).toContain(CORE_CAMPAIGN_PROMPT.trim());
    expect(prompt).toContain("The party arrived in Vallaki.");
    expect(prompt).toContain("append_campaign_summary");
    expect(prompt).toContain("Keep summaries to five bullets.");
  });

  test("one-shot prompt uses the one-shot core and its own instructions file", async () => {
    await writeConfigFile("instructions.md", "CAMPAIGN ONLY.\n");
    await writeConfigFile("oneshot-instructions.md", "Prefer four-hour adventures.\n");
    const prompt = await buildOneshotSystemPrompt(settings);

    expect(prompt).toContain(CORE_ONESHOT_PROMPT.trim());
    expect(prompt).toContain("read_oneshot before revising one");
    expect(prompt).toContain("complete canonical markdown body");
    expect(prompt).toContain("NEVER call save_session unless the user explicitly asks");
    expect(prompt).toContain("Prefer four-hour adventures.");
    // The campaign instructions layer must not leak into one-shot mode.
    expect(prompt).not.toContain("CAMPAIGN ONLY.");
    expect(prompt).not.toContain("# Campaign");
  });

  test("override replaces the core but keeps context and instructions", async () => {
    const overridePath = join(dir, "my-core.md");
    await Bun.write(overridePath, "You are a terse assistant.\n");
    await writeConfigFile("instructions.md", "Always address the user as Game Master.\n");

    const prompt = await buildPlanningSystemPrompt(campaign, session, {
      ...settings,
      systemPromptOverride: overridePath,
    });

    expect(prompt).toContain("You are a terse assistant.");
    expect(prompt).not.toContain("You are Scribe");
    expect(prompt).toContain("Curse of Strahd");
    expect(prompt).toContain("Always address the user as Game Master.");
  });

  test("an unreadable override falls back to the built-in core", async () => {
    const prompt = await buildPlanningSystemPrompt(campaign, session, {
      ...settings,
      systemPromptOverride: join(dir, "does-not-exist.md"),
    });
    expect(prompt).toContain(CORE_CAMPAIGN_PROMPT.trim());
  });
});
