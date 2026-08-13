/**
 * The tool registry: the single list of every tool Scribe can expose to a
 * model. Agents don't import tools directly — they name them, and
 * `../agents.ts` resolves those names through here.
 *
 * Adding a tool: create the file, export its `ToolSpec`, add one line below.
 * Granting it to an agent: add its name to that agent's list in `../agents.ts`.
 *
 * The registry is an explicit object literal, not filesystem discovery, so
 * `ToolName` is a compile-time union — a typo in an agent's tool list is a
 * type error, not a silent no-op at runtime.
 */
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

/** Every registered tool name, for tests and diagnostics. */
export const toolNames = Object.keys(registry) as ToolName[];

/**
 * The human-readable present-tense phrase for a tool, for the transcript's
 * running activity row. Takes a plain string (tool names arrive from the model,
 * so they may be anything) and
 * falls back to the raw name for anything unregistered.
 */
export function toolLabel(name: string): string {
  return (registry as Record<string, ToolSpec | undefined>)[name]?.label ?? name;
}

/**
 * The past-tense counterpart of `toolLabel`, for the settled activity row a
 * finished tool leaves behind in the transcript. Same fallback.
 */
export function toolPastLabel(name: string): string {
  return (registry as Record<string, ToolSpec | undefined>)[name]?.pastLabel ?? name;
}

/**
 * Bind the named tools to a context, dropping any that can't operate in it
 * (e.g. campaign tools when there is no campaign).
 */
export function resolveTools(names: readonly ToolName[], ctx: ToolContext): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const name of names) {
    const tool = registry[name].create(ctx);
    if (tool) tools.push(tool);
  }
  return tools;
}

export type { ToolContext, ToolSpec };
