// Explicit registration keeps tool names type-checked. Grants live in ../agents.ts.
import { appendCampaignSummaryTool } from "./append-campaign-summary.ts";
import { askUserTool } from "./ask-user.ts";
import { listSessionsTool } from "./list-sessions.ts";
import { listOneshotsTool } from "./list-oneshots.ts";
import { listSourcesTool } from "./list-sources.ts";
import { readCampaignSummaryTool } from "./read-campaign-summary.ts";
import { readOneshotTool } from "./read-oneshot.ts";
import { readSessionNotesTool } from "./read-session-notes.ts";
import { readSourcePagesTool } from "./read-source-pages.ts";
import { saveSessionTool } from "./save-session.ts";
import { searchSourcesTool } from "./search-sources.ts";
import { updateSessionNotesTool } from "./update-session-notes.ts";
import { updateOneshotTool } from "./update-oneshot.ts";
import type { AgentTool, ToolContext, ToolSpec } from "./types.ts";

export const registry = {
  list_sessions: listSessionsTool,
  read_campaign_summary: readCampaignSummaryTool,
  read_session_notes: readSessionNotesTool,
  update_session_notes: updateSessionNotesTool,
  append_campaign_summary: appendCampaignSummaryTool,
  save_session: saveSessionTool,
  list_oneshots: listOneshotsTool,
  read_oneshot: readOneshotTool,
  update_oneshot: updateOneshotTool,
  ask_user: askUserTool,
  list_sources: listSourcesTool,
  search_sources: searchSourcesTool,
  read_source_pages: readSourcePagesTool,
} as const satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof registry;

export const toolNames = Object.keys(registry) as ToolName[];

export function toolLabel(name: string): string {
  return (registry as Record<string, ToolSpec | undefined>)[name]?.label ?? name;
}

export function toolPastLabel(name: string): string {
  return (registry as Record<string, ToolSpec | undefined>)[name]?.pastLabel ?? name;
}

export function resolveTools(names: readonly ToolName[], ctx: ToolContext): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const name of names) {
    const tool = registry[name].create(ctx);
    if (tool) tools.push(tool);
  }
  return tools;
}

export type { ToolContext, ToolSpec };
