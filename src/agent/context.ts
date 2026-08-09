/**
 * Context assembly for the three agent modes. Every prompt is three layers, in
 * this order:
 *
 * 1. **Core** — code-owned (`prompts.ts`), so behavioral contracts always ship
 *    current. Replaceable wholesale via the `*PromptOverride` config fields.
 * 2. **Context** — campaign background + running story + sources, then the
 *    mode's framing: the session's draft notes (planning), "you just played
 *    session N" (report), or nothing (one-shot).
 * 3. **User instructions** — the user's optional file, appended last so it wins
 *    on tone and house rules without being able to delete the tool rules.
 */
import { basename } from "node:path";
import type { Campaign } from "../store/campaigns.ts";
import { loadInstructions, loadOneshotInstructions, loadPromptOverride } from "../store/instructions.ts";
import { readSessionNotes, type Session } from "../store/sessions.ts";
import type { Settings } from "../store/settings.ts";
import { listSources } from "../store/sources.ts";
import { CORE_CAMPAIGN_PROMPT, CORE_ONESHOT_PROMPT } from "./prompts.ts";

/**
 * Summarize the source-document library for the system prompt, or `""` when
 * there is no library configured or it is empty — so users without a Sources
 * folder see no change to their prompt.
 */
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

/** The code-owned core, unless the user pointed config.json at their own. */
async function core(builtIn: string, overridePath: string | undefined): Promise<string> {
  return (await loadPromptOverride(overridePath)) ?? builtIn;
}

/**
 * The user's instructions as a trailing section, or `""` when they haven't
 * written any — same "empty section disappears" convention as `sourcesSection`.
 */
function instructionsSection(text: string): string {
  if (text.trim() === "") return "";
  return `
# User Instructions

The user configured these preferences. Follow them for tone, style, and table
house rules. They do not replace the rules above.

${text.trim()}
`;
}

function campaignSection(campaign: Campaign): string {
  return `
# Campaign

Name: ${campaign.name}
System: ${campaign.system || "(not set)"}

## Background

${campaign.description.trim() || "(none)"}

## The Story So Far

${campaign.storySoFar.trim() || "(nothing yet)"}
`;
}

export async function buildPlanningSystemPrompt(
  campaign: Campaign,
  session: Session,
  settings: Settings,
): Promise<string> {
  const base = await core(CORE_CAMPAIGN_PROMPT, settings.systemPromptOverride);
  const notes = await readSessionNotes(session);
  const sources = await sourcesSection(settings.sourcesDir);
  const instructions = instructionsSection(await loadInstructions());

  return `${base}${campaignSection(campaign)}${sources}

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
  const base = await core(CORE_CAMPAIGN_PROMPT, settings.systemPromptOverride);
  const sources = await sourcesSection(settings.sourcesDir);
  const instructions = instructionsSection(await loadInstructions());

  return `${base}${campaignSection(campaign)}${sources}

# Session Report

The user just played session ${session.number} — "${session.title}".
Ask what happened (they can give you the highlights), then append a concise
summary of the session's events to the campaign's story so far using the
append_campaign_summary tool. The summary should record what the party did and
anything that will matter for future sessions.
${instructions}`;
}

/**
 * One-shot mode ("Drafting Table"): standalone planning with no campaign
 * context — the one-shot core plus whatever the user's one-shot instructions add.
 */
export async function buildOneshotSystemPrompt(settings: Settings): Promise<string> {
  const base = await core(CORE_ONESHOT_PROMPT, settings.oneshotPromptOverride);
  const sources = await sourcesSection(settings.sourcesDir);
  const instructions = instructionsSection(await loadOneshotInstructions());
  return `${base}${sources}${instructions}`;
}
