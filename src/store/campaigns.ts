import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { parseFrontmatter, serializeFrontmatter, updateFrontmatterFile } from "./frontmatter.ts";
import { sanitizeFolderName, today, uniqueName } from "./naming.ts";

export interface Campaign {
  name: string;
  system: string;
  /** A short premise used in listings and agent context. */
  shortDescription: string;
  /** The longer campaign background/backstory. */
  description: string;
  storySoFar: string;
  planningPreferences: string;
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
const DESCRIPTION_HEADING = "## Description";
const BACKGROUND_HEADING = "## Background";
const STORY_HEADING = "## The Story So Far";
const PREFERENCES_HEADING = "## Planning Preferences";

function validateSectionContent(content: string): void {
  // H2 headings delimit campaign fields, including user-owned custom sections.
  if (/^## /m.test(content.trim())) {
    throw new Error("Use ### or deeper headings within campaign content; ## headings separate campaign sections.");
  }
}

function buildCampaignMarkdown(campaign: NewCampaign & { created: string; nextSession: number }): string {
  const body = `${DESCRIPTION_HEADING}\n\n\n${BACKGROUND_HEADING}\n\n${campaign.description.trim()}\n\n${STORY_HEADING}\n\n\n${PREFERENCES_HEADING}\n`;
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

interface SectionBounds {
  headingStart: number;
  contentStart: number;
  contentEnd: number;
}

function sectionBounds(body: string, heading: string): SectionBounds | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingStart = new RegExp(`^${escaped}[ \\t]*$`, "m").exec(body)?.index;
  if (headingStart === undefined) return null;

  const contentStart = headingStart + heading.length;
  const nextHeadingOffset = body.slice(contentStart).search(/^## /m);
  return {
    headingStart,
    contentStart,
    contentEnd: nextHeadingOffset === -1 ? body.length : contentStart + nextHeadingOffset,
  };
}

function extractSection(body: string, heading: string): string {
  const bounds = sectionBounds(body, heading);
  return bounds ? body.slice(bounds.contentStart, bounds.contentEnd).trim() : "";
}

function campaignFromMarkdown(dir: string, content: string): Campaign {
  const { data, body } = parseFrontmatter(content);
  return {
    name: data["name"] ?? "(unnamed campaign)",
    system: data["system"] ?? "",
    shortDescription: extractSection(body, DESCRIPTION_HEADING),
    description: extractSection(body, BACKGROUND_HEADING),
    storySoFar: extractSection(body, STORY_HEADING),
    planningPreferences: extractSection(body, PREFERENCES_HEADING),
    created: data["created"] ?? "",
    nextSession: Math.max(1, Number.parseInt(data["nextSession"] ?? "1", 10) || 1),
    dir,
  };
}

export async function createCampaign(campaignsDir: string, input: NewCampaign): Promise<Campaign> {
  validateSectionContent(input.description);
  const existing = await readdir(campaignsDir);
  const folderName = uniqueName(sanitizeFolderName(input.name), existing);
  const dir = join(campaignsDir, folderName);

  await mkdir(join(dir, "sessions"), { recursive: true });
  await mkdir(join(dir, ".scribe"), { recursive: true });

  const created = today();
  const markdown = buildCampaignMarkdown({ ...input, created, nextSession: 1 });
  await writeFile(join(dir, CAMPAIGN_FILE), markdown, "utf8");

  return {
    ...input,
    shortDescription: "",
    storySoFar: "",
    planningPreferences: "",
    created,
    nextSession: 1,
    dir,
  };
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

/** Returns campaigns oldest first. */
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

export async function updateCampaignMeta(
  campaign: Campaign,
  patch: Partial<Pick<Campaign, "nextSession" | "name" | "system">>,
): Promise<void> {
  const filePath = join(campaign.dir, CAMPAIGN_FILE);
  await updateFrontmatterFile(filePath, (data, body) => ({
    data: { ...data, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v)])) },
    body,
  }));
}

function replaceSection(body: string, heading: string, content: string, beforeHeading?: string): string {
  const bounds = sectionBounds(body, heading);
  const section = `${heading}\n\n${content.trim()}\n`;
  if (!bounds) {
    const before = beforeHeading ? sectionBounds(body, beforeHeading) : null;
    if (before) {
      const prefix = body.slice(0, before.headingStart).trimEnd();
      return `${prefix ? `${prefix}\n\n` : ""}${section}\n${body.slice(before.headingStart).replace(/^\n+/, "")}`;
    }
    return `${body.trimEnd()}\n\n${section}`;
  }

  const following = body.slice(bounds.contentEnd).replace(/^\n+/, "");
  return `${body.slice(0, bounds.headingStart)}${section}${following ? `\n${following}` : ""}`;
}

export interface CampaignDetails {
  name: string;
  system: string;
  shortDescription: string;
  description: string;
  planningPreferences: string;
}

/** Replace user-editable campaign details while preserving all unrelated sections. */
export async function updateCampaignDetails(
  campaign: Campaign,
  details: CampaignDetails,
  expected?: CampaignDetails,
): Promise<void> {
  validateSectionContent(details.shortDescription);
  validateSectionContent(details.description);
  validateSectionContent(details.planningPreferences);
  const filePath = join(campaign.dir, CAMPAIGN_FILE);
  let nextBody = "";
  await updateFrontmatterFile(filePath, (data, body) => {
    const current = campaignFromMarkdown(campaign.dir, serializeFrontmatter(data, body));
    if (
      expected &&
      (current.name !== expected.name ||
        current.system !== expected.system ||
        current.shortDescription !== expected.shortDescription ||
        current.description !== expected.description ||
        current.planningPreferences !== expected.planningPreferences)
    ) {
      throw new Error("Campaign details changed on disk; reload before saving.");
    }
    nextBody = replaceSection(body, DESCRIPTION_HEADING, details.shortDescription, BACKGROUND_HEADING);
    nextBody = replaceSection(nextBody, BACKGROUND_HEADING, details.description);
    nextBody = replaceSection(nextBody, PREFERENCES_HEADING, details.planningPreferences);
    return { data: { ...data, name: details.name, system: details.system }, body: nextBody };
  });
  Object.assign(campaign, details);
}

/** Replace the running story without affecting the background or other sections. */
export async function replaceStorySoFar(
  campaign: Campaign,
  story: string,
  expected?: string,
): Promise<void> {
  validateSectionContent(story);
  const filePath = join(campaign.dir, CAMPAIGN_FILE);
  let nextBody = "";
  await updateFrontmatterFile(filePath, (data, body) => {
    const current = extractSection(body, STORY_HEADING);
    if (expected !== undefined && current !== expected) {
      throw new Error("The story changed on disk; reload before saving.");
    }
    nextBody = replaceSection(body, STORY_HEADING, story);
    return { data, body: nextBody };
  });
  campaign.storySoFar = extractSection(nextBody, STORY_HEADING);
}

/** Also updates the in-memory campaign. */
export async function appendStorySoFar(campaign: Campaign, entry: string): Promise<void> {
  validateSectionContent(entry);
  const filePath = join(campaign.dir, CAMPAIGN_FILE);
  let newBody = "";
  await updateFrontmatterFile(filePath, (data, body) => {
    const bounds = sectionBounds(body, STORY_HEADING);
    if (!bounds) {
      newBody = `${body.trimEnd()}\n\n${STORY_HEADING}\n\n${entry.trim()}\n`;
      return { data, body: newBody };
    }

    const currentStory = body.slice(bounds.contentStart, bounds.contentEnd).trim();
    const followingSections = body.slice(bounds.contentEnd).replace(/^\n+/, "");
    newBody = `${body.slice(0, bounds.contentStart)}\n\n${currentStory ? `${currentStory}\n\n` : ""}${entry.trim()}\n`;
    if (followingSections !== "") newBody += `\n${followingSections}`;
    return { data, body: newBody };
  });
  campaign.storySoFar = extractSection(newBody, STORY_HEADING);
}
