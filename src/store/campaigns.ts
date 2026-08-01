/**
 * Markdown-first persistence for campaigns: each campaign is a folder in the
 * campaigns dir containing a `campaign.md` with flat frontmatter + a body of
 * "## Background" and "## The Story So Far" sections.
 */
import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.ts";
import { sanitizeFolderName, uniqueName } from "./naming.ts";

/**
 * A campaign is a folder containing `campaign.md`:
 *
 *   ---
 *   name: Curse of Strahd
 *   system: D&D 5e
 *   created: 2026-07-27
 *   nextSession: 1
 *   ---
 *   ## Background
 *   ...
 *   ## The Story So Far
 *   ...
 */
export interface Campaign {
  name: string;
  system: string;
  /** Campaign background (the "## Background" body section). */
  description: string;
  /** The "## The Story So Far" body section — the agent's running memory. */
  storySoFar: string;
  created: string;
  nextSession: number;
  /** Absolute path to the campaign folder (runtime only, not persisted). */
  dir: string;
}

export interface NewCampaign {
  name: string;
  system: string;
  description: string;
}

const CAMPAIGN_FILE = "campaign.md";
const BACKGROUND_HEADING = "## Background";
const STORY_HEADING = "## The Story So Far";

function buildCampaignMarkdown(campaign: NewCampaign & { created: string; nextSession: number }): string {
  const body = `${BACKGROUND_HEADING}\n\n${campaign.description.trim()}\n\n${STORY_HEADING}\n`;
  return serializeFrontmatter(
    {
      name: campaign.name,
      system: campaign.system,
      created: campaign.created,
      nextSession: String(campaign.nextSession),
    },
    body,
  );
}

/** Extract the text between `heading` and the next "## " heading. */
function extractSection(body: string, heading: string): string {
  const start = body.indexOf(heading);
  if (start === -1) return "";
  const afterHeading = body.slice(start + heading.length);
  const nextHeading = afterHeading.search(/^## /m);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);
  return section.trim();
}

function campaignFromMarkdown(dir: string, content: string): Campaign {
  const { data, body } = parseFrontmatter(content);
  return {
    name: data.name ?? "(unnamed campaign)",
    system: data.system ?? "",
    description: extractSection(body, BACKGROUND_HEADING),
    storySoFar: extractSection(body, STORY_HEADING),
    created: data.created ?? "",
    nextSession: Math.max(1, Number.parseInt(data.nextSession ?? "1", 10) || 1),
    dir,
  };
}

export async function createCampaign(campaignsDir: string, input: NewCampaign): Promise<Campaign> {
  const existing = await readdir(campaignsDir);
  const folderName = uniqueName(sanitizeFolderName(input.name), existing);
  const dir = join(campaignsDir, folderName);

  await mkdir(join(dir, "sessions"), { recursive: true });
  await mkdir(join(dir, ".scribe"), { recursive: true });

  const created = new Date().toISOString().slice(0, 10);
  const markdown = buildCampaignMarkdown({ ...input, created, nextSession: 1 });
  await writeFile(join(dir, CAMPAIGN_FILE), markdown, "utf8");

  return { ...input, storySoFar: "", created, nextSession: 1, dir };
}

export async function loadCampaign(dir: string): Promise<Campaign | null> {
  let content: string;
  try {
    content = await readFile(join(dir, CAMPAIGN_FILE), "utf8");
  } catch {
    return null;
  }
  return campaignFromMarkdown(dir, content);
}

/** List all campaigns (folders containing a campaign.md), oldest first. */
export async function listCampaigns(campaignsDir: string): Promise<Campaign[]> {
  const entries = await readdir(campaignsDir, { withFileTypes: true });
  const campaigns: Campaign[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const campaign = await loadCampaign(join(campaignsDir, entry.name));
    if (campaign) campaigns.push(campaign);
  }
  return campaigns.sort((a, b) => a.created.localeCompare(b.created));
}

/** Patch campaign.md frontmatter fields (e.g. bump nextSession). */
export async function updateCampaignMeta(
  campaign: Campaign,
  patch: Partial<Pick<Campaign, "nextSession" | "name" | "system">>,
): Promise<void> {
  const filePath = join(campaign.dir, CAMPAIGN_FILE);
  const { data, body } = parseFrontmatter(await readFile(filePath, "utf8"));
  const merged = { ...data, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)])) };
  await writeFile(filePath, serializeFrontmatter(merged, body), "utf8");
}
