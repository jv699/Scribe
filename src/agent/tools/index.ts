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
import { listSessionsTool } from "./list-sessions.ts";
import { readCampaignSummaryTool } from "./read-campaign-summary.ts";
import { readSessionNotesTool } from "./read-session-notes.ts";
import { saveSessionTool } from "./save-session.ts";
import { updateSessionNotesTool } from "./update-session-notes.ts";
import type { AgentTool, ToolContext, ToolSpec } from "./types.ts";

export const registry = {
  list_sessions: listSessionsTool,
  read_campaign_summary: readCampaignSummaryTool,
  read_session_notes: readSessionNotesTool,
  update_session_notes: updateSessionNotesTool,
  append_campaign_summary: appendCampaignSummaryTool,
  save_session: saveSessionTool,
} as const satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof registry;

/** Every registered tool name, for tests and diagnostics. */
export const toolNames = Object.keys(registry) as ToolName[];

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
