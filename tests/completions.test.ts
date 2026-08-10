import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { campaignCompletions, filterCompletions } from "../src/completions.ts";
import type { CompletionItem } from "../src/components/autocomplete.ts";
import { createCampaign, type Campaign } from "../src/store/campaigns.ts";
import { createSession, setSessionStatus } from "../src/store/sessions.ts";

let dir: string;
let campaign: Campaign;
/** No PDFs — source items are covered by tests/sources.test.ts. */
let sourcesDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scribe-completions-"));
  campaign = await createCampaign(dir, { name: "CoS", system: "5e", description: "Gothic horror." });
  sourcesDir = join(dir, "Sources");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const items: CompletionItem[] = [
  { label: "@background", description: "The campaign premise" },
  { label: "@session-3", description: "The Bell Tower · ready" },
  { label: "@phb", description: "D&D 5e · 320 pages" },
];

describe("filterCompletions", () => {
  test("an empty query returns everything, unfiltered", () => {
    expect(filterCompletions(items, "")).toEqual(items);
  });

  test("matches the label", () => {
    expect(filterCompletions(items, "session").map((i) => i.label)).toEqual(["@session-3"]);
  });

  // The whole reason description is searched: "@bell" should find the session
  // titled "The Bell Tower", whose label is just "@session-3".
  test("matches the description, not only the label", () => {
    expect(filterCompletions(items, "bell").map((i) => i.label)).toEqual(["@session-3"]);
  });

  test("is case-insensitive", () => {
    expect(filterCompletions(items, "BELL").map((i) => i.label)).toEqual(["@session-3"]);
  });

  test("a non-match returns nothing", () => {
    expect(filterCompletions(items, "zzz")).toEqual([]);
  });

  test("tolerates items with no description", () => {
    const sparse: CompletionItem[] = [{ label: "@x" }];
    expect(filterCompletions(sparse, "x").map((i) => i.label)).toEqual(["@x"]);
    expect(filterCompletions(sparse, "undefined")).toEqual([]);
  });
});

describe("campaignCompletions", () => {
  test("offers the two summary documents plus one item per session", async () => {
    await createSession(campaign, "Death House");
    const source = campaignCompletions(campaign, sourcesDir)[0]!;

    const all = await source.items("");
    expect(source.trigger).toBe("@");
    expect(all.map((i) => i.label)).toEqual(["@background", "@story-so-far", "@session-1"]);
  });

  test("inserts plain-language references the agent's tools can act on", async () => {
    await createSession(campaign, "Death House");
    const source = campaignCompletions(campaign, sourcesDir)[0]!;

    const all = await source.items("");
    expect(all.find((i) => i.label === "@session-1")?.insert).toBe('session 1 ("Death House")');
    expect(all.find((i) => i.label === "@background")?.insert).toBe("the campaign background");
    expect(all.find((i) => i.label === "@story-so-far")?.insert).toBe("the campaign's story so far");
  });

  test("describes each session with its title and status", async () => {
    const session = await createSession(campaign, "Death House");
    await setSessionStatus(session, "ready");
    const source = campaignCompletions(campaign, sourcesDir)[0]!;

    const [match] = await source.items("death");
    expect(match?.label).toBe("@session-1");
    expect(match?.description).toBe("Death House · ready");
  });

  // Resolved per keystroke rather than snapshotted, so sessions added while the
  // chat is open show up without reopening it.
  test("picks up sessions created after the source was built", async () => {
    const source = campaignCompletions(campaign, sourcesDir)[0]!;
    expect((await source.items("")).map((i) => i.label)).toEqual(["@background", "@story-so-far"]);

    await createSession(campaign, "Death House");
    expect((await source.items("")).map((i) => i.label)).toContain("@session-1");
  });
});
