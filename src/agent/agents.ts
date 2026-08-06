/**
 * The gateway: which agent gets which tools.
 *
 * This is the one place to read when auditing what a given agent can do.
 * Tool lists are written out in full rather than composed by spreading, so
 * each agent's capabilities are legible on their own line. Names are checked
 * against the registry at compile time.
 *
 * Adding an agent: add an entry here, then a system-prompt builder in
 * `context.ts` (prompts are deliberately not owned by the gateway).
 */
import { resolveTools, type ToolContext, type ToolName } from "./tools/index.ts";
import type { AgentTool } from "./loop.ts";

export interface AgentDefinition {
  /** Tools this agent may call. Empty means the model answers from context alone. */
  readonly tools: readonly ToolName[];
}

export const AGENTS = {
  /** Drafts and refines a single upcoming session's notes. */
  planning: {
    tools: [
      "list_sessions",
      "read_campaign_summary",
      "read_session_notes",
      "update_session_notes",
      "ask_user",
    ],
  },
  /** Records what actually happened after a session was played. */
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
  /** Drafting Table: standalone one-shots and ideas, no campaign to touch. */
  oneshot: {
    tools: ["save_session", "ask_user"],
  },
} as const satisfies Record<string, AgentDefinition>;

export type AgentId = keyof typeof AGENTS;

/** Resolve an agent's granted tools against a context. */
export function toolsFor(agent: AgentId, ctx: ToolContext): AgentTool[] {
  return resolveTools(AGENTS[agent].tools, ctx);
}
