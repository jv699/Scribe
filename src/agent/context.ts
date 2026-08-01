/**
 * Context assembly for planning mode: the user's base system prompt file plus
 * the campaign's background, running story, and the current session's draft
 * notes, so the agent plans with full knowledge of where the story stands.
 */
import { basename } from "node:path";
import { loadCampaign, type Campaign } from "../store/campaigns.ts";
import { readSessionNotes, type Session } from "../store/sessions.ts";
import { loadSystemPrompt } from "../store/system-prompt.ts";

export async function buildPlanningSystemPrompt(campaign: Campaign, session: Session): Promise<string> {
  const base = await loadSystemPrompt();
  const notes = await readSessionNotes(session);

  return `${base}

# Campaign

Name: ${campaign.name}
System: ${campaign.system || "(not set)"}

## Background

${campaign.description.trim() || "(none)"}

## The Story So Far

${campaign.storySoFar.trim() || "(nothing yet)"}

# Current Session

You are planning session ${session.number} — "${session.title}".
Its notes file is ${basename(session.path)}.

Current notes:
${notes.trim() || "(empty)"}
`;
}
