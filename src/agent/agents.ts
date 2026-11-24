/** The auditable gateway from each agent to its compile-time-checked tools. */
import { resolveTools, type ToolContext, type ToolName } from "./tools/index.ts";
import type { AgentTool } from "./loop.ts";

export interface AgentDefinition {
  readonly tools: readonly ToolName[];
}

export const AGENTS = {
  planning: {
    tools: [
      "list_sessions",
      "read_campaign_summary",
      "read_session_notes",
      "update_session_notes",
      "ask_user",
      "list_sources",
      "search_sources",
      "read_source_pages",
      "generate_names",
    ],
  },
  report: {
    tools: [
      "list_sessions",
      "read_campaign_summary",
      "read_session_notes",
      "update_session_notes",
      "append_campaign_summary",
      "ask_user",
    ],
  },
  oneshot: {
    tools: [
      "save_session",
      "list_oneshots",
      "read_oneshot",
      "update_oneshot",
      "draw_map",
      "export_pdf",
      "ask_user",
      "list_sources",
      "search_sources",
      "read_source_pages",
      "generate_names",
    ],
  },
  // ScribeBench: one unattended reply per model, so nothing that asks or writes.
  // Its names service is offline-only (see bench/run.ts) so every model draws
  // from the same source, with no network or rate limit in the comparison.
  bench: {
    tools: ["list_sources", "search_sources", "read_source_pages", "generate_names"],
  },
} as const satisfies Record<string, AgentDefinition>;

export type AgentId = keyof typeof AGENTS;

export function toolsFor(agent: AgentId, ctx: ToolContext): AgentTool[] {
  return resolveTools(AGENTS[agent].tools, ctx);
}
