/**
 * Context assembly for the two agent modes, built on the user's base system
 * prompt file:
 *
 * - Planning: campaign background + running story + the session's draft notes.
 * - Report: the same background + story, framed as "the user just played
 *   session N" so the agent records what happened via append_campaign_summary.
 */
import { basename } from "node:path";
import type { Campaign } from "../store/campaigns.ts";
import { readSessionNotes, type Session } from "../store/sessions.ts";
import { listSources } from "../store/sources.ts";
import { loadOneshotPrompt, loadSystemPrompt } from "../store/system-prompt.ts";

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
  sourcesDir?: string,
): Promise<string> {
  const base = await loadSystemPrompt();
  const notes = await readSessionNotes(session);
  const sources = await sourcesSection(sourcesDir);

  return `${base}${campaignSection(campaign)}${sources}

# Current Session

You are planning session ${session.number} — "${session.title}".
Its notes file is ${basename(session.path)}.

Current notes:
${notes.trim() || "(empty)"}
`;
}

export async function buildReportSystemPrompt(campaign: Campaign, session: Session): Promise<string> {
  const base = await loadSystemPrompt();

  return `${base}${campaignSection(campaign)}

# Session Report

The user just played session ${session.number} — "${session.title}".
Ask what happened (they can give you the highlights), then append a concise
summary of the session's events to the campaign's story so far using the
append_campaign_summary tool. The summary should record what the party did and
anything that will matter for future sessions.
`;
}

/**
 * One-shot mode ("Drafting Table"): standalone planning with no campaign context —
 * just the user's one-shot prompt file.
 */
export async function buildOneshotSystemPrompt(sourcesDir?: string): Promise<string> {
  const base = await loadOneshotPrompt();
  const sources = await sourcesSection(sourcesDir);
  return `${base}${sources}`;
}
