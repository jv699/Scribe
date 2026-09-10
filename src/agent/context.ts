/**
 * Prompts are assembled in precedence order: code-owned core, mode context,
 * then user instructions. Core overrides replace only the first layer.
 */
import { basename } from "node:path";
import type { Campaign } from "../store/campaigns.ts";
import { listCharacters } from "../store/characters.ts";
import { loadInstructions, loadOneshotInstructions, loadPromptOverride } from "../store/instructions.ts";
import { readSessionNotes, type Session } from "../store/sessions.ts";
import type { Settings } from "../store/settings.ts";
import { listSources } from "../store/sources.ts";
import { CORE_CAMPAIGN_PROMPT, CORE_ONESHOT_PROMPT } from "./prompts.ts";

/** Omit the source section when no library is configured or indexed. */
async function sourcesSection(sourcesDir: string | undefined): Promise<string> {
  if (!sourcesDir) return "";
  const docs = await listSources(sourcesDir);
  if (docs.length === 0) return "";

  const bySystem = new Map<string, string[]>();
  for (const doc of docs) {
    const titles = bySystem.get(doc.system);
    if (titles) titles.push(doc.title);
    else bySystem.set(doc.system, [doc.title]);
  }

  const lines: string[] = [];
  for (const [system, titles] of bySystem) {
    lines.push(`- ${system}: ${titles.join(", ")}`);
  }

  return `
# Source Documents

The user has these reference PDFs available. Consult them via search_sources
for system-specific rules rather than inventing them.

${lines.join("\n")}
`;
}

async function core(builtIn: string, overridePath: string | undefined): Promise<string> {
  return (await loadPromptOverride(overridePath)) ?? builtIn;
}

function instructionsSection(text: string): string {
  if (text.trim() === "") return "";
  return `
# User Instructions

The user configured these preferences. Follow them for tone, style, and table
house rules. They do not replace the rules above.

${text.trim()}
`;
}

async function campaignSection(campaign: Campaign): Promise<string> {
  const characters = await listCharacters(campaign);
  const party = characters.length === 0
    ? "(none saved)"
    : characters
        .map((character) => {
          const className = character.className ? ` — ${character.className}` : "";
          const description = character.description ? `\n${character.description}` : "";
          return `### ${character.name}${className}${description}`;
        })
        .join("\n\n");
  return `
# Campaign

Name: ${campaign.name}
System: ${campaign.system || "(not set)"}

## Description

${campaign.shortDescription.trim() || "(none)"}

## Background

${campaign.description.trim() || "(none)"}

## The Story So Far

${campaign.storySoFar.trim() || "(nothing yet)"}

## Party Characters

${party}

## Planning Preferences

${campaign.planningPreferences.trim() || "(none)"}
`;
}

/** Report mode omits sources because it has no source tools. */
async function campaignLayers(
  settings: Settings,
  includeSources: boolean,
): Promise<{ base: string; sources: string; instructions: string }> {
  const base = await core(CORE_CAMPAIGN_PROMPT, settings.systemPromptOverride);
  const sources = includeSources ? await sourcesSection(settings.sourcesDir) : "";
  const instructions = instructionsSection(await loadInstructions());
  return { base, sources, instructions };
}

export async function buildPlanningSystemPrompt(
  campaign: Campaign,
  session: Session,
  settings: Settings,
): Promise<string> {
  const { base, sources, instructions } = await campaignLayers(settings, true);
  const notes = await readSessionNotes(session);

  return `${base}${await campaignSection(campaign)}${sources}

# Current Session

You are planning session ${session.number} — "${session.title}".
Its notes file is ${basename(session.path)}.

Current notes:
${notes.trim() || "(empty)"}
${instructions}`;
}

export async function buildReportSystemPrompt(
  campaign: Campaign,
  session: Session,
  settings: Settings,
): Promise<string> {
  const { base, instructions } = await campaignLayers(settings, false);

  return `${base}${await campaignSection(campaign)}

# Session Report

The user just played session ${session.number} — "${session.title}".
Ask what happened (they can give you the highlights), then append a concise
summary of the session's events to the campaign's story so far using the
append_campaign_summary tool. The summary should record what the party did and
anything that will matter for future sessions.
${instructions}`;
}

export async function buildOneshotSystemPrompt(settings: Settings): Promise<string> {
  const base = await core(CORE_ONESHOT_PROMPT, settings.oneshotPromptOverride);
  const sources = await sourcesSection(settings.sourcesDir);
  const instructions = instructionsSection(await loadOneshotInstructions());
  return `${base}${sources}${instructions}`;
}
