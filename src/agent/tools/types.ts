/**
 * The tool contract.
 *
 * A tool is a static `definition` (what the model sees) plus a `create`
 * factory that binds it to a `ToolContext`. Tools live one-per-file in this
 * directory, are listed in `index.ts`, and are granted to agents by name in
 * `../agents.ts`.
 *
 * SECURITY INVARIANT: tools never accept filesystem paths from the model.
 * Resources are addressed by identity (a session *number*, the active
 * campaign) and resolved through `src/store/`, which is what confines every
 * read and write to the campaign folder. Any future tool that needs to touch
 * a path must resolve it here, not take it as an argument.
 */
import type { ToolDefinition } from "../../provider/types.ts";
import type { Campaign } from "../../store/campaigns.ts";
import type { Session } from "../../store/sessions.ts";
import type { AgentTool } from "../loop.ts";

/** Re-exported so tool files import their whole contract from one module. */
export type { AgentTool, ToolDefinition };

/**
 * Everything a tool factory may need, assembled once by the caller.
 *
 * Every field is optional on purpose: agents without a campaign (the Drafting
 * Table) must still be able to resolve context-free tools. Campaign-scoped
 * tools decline by returning `null` from `create`.
 */
export interface ToolContext {
  /** The active campaign, when the agent is scoped to one. */
  campaign?: Campaign;
  /** The session the agent is working on, when there is one. */
  session?: Session;
  /** Directory where saved one-shot plans are written, when the app has one configured. */
  oneshotsDir?: string;
}

export interface ToolSpec {
  /**
   * Canonical tool name. MUST equal `definition.function.name` and the key it
   * is registered under in `index.ts` — asserted by the registry integrity
   * test.
   */
  name: string;
  /** The schema sent to the model. */
  definition: ToolDefinition;
  /**
   * Bind the tool to a context. Return `null` when this tool cannot operate in
   * the given context (e.g. a campaign tool with no campaign), in which case
   * it is silently omitted from the agent's tool list.
   */
  create(ctx: ToolContext): AgentTool | null;
}
