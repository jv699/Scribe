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
import { loadSystemPrompt } from "../store/system-prompt.ts";

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

export async function buildPlanningSystemPrompt(campaign: Campaign, session: Session): Promise<string> {
  const base = await loadSystemPrompt();
  const notes = await readSessionNotes(session);

  return `${base}${campaignSection(campaign)}

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
