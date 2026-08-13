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
import type { SavedOneshot } from "../../store/oneshots.ts";
import type { AskChannel } from "../ask.ts";
import type { AgentTool } from "../loop.ts";

/** Re-exported so tool files import their whole contract from one module. */
export type { AgentTool, ToolDefinition };

/** Screen-local state shared by the one-shot read and update tools. */
export interface ActiveOneshot {
  current: SavedOneshot | null;
  /** Lets the owning Drafting Table reflect a successful read in its title. */
  onRead?: (oneshot: SavedOneshot) => void;
}

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
  /** The saved one-shot selected in this Drafting Table, if any. */
  activeOneshot?: ActiveOneshot;
  /** The source-document library (PDFs of rulebooks, bestiaries, etc.), when the app has one configured. */
  sourcesDir?: string;
  /** The campaign's game system, used to scope source-document searches by default. */
  defaultSystem?: string;
  /**
   * The seam back to the UI, for tools that need an answer from the person
   * rather than the disk. Absent in headless contexts, which is what makes
   * `ask_user` decline instead of blocking forever.
   */
  ask?: AskChannel;
}

export interface ToolSpec {
  /**
   * Canonical tool name. MUST equal `definition.function.name` and the key it
   * is registered under in `index.ts` — asserted by the registry integrity
   * test.
   */
  name: string;
  /**
   * Human-readable present-tense phrase shown on the transcript's activity row
   * while the tool runs ("Reading the session notes…"), so users never see the
   * snake_case wire name. Never sent to the model.
   */
  label: string;
  /**
   * Past-tense counterpart of `label`, shown once the tool returns and the row
   * settles ("Read the session notes · 3.2s"). Also UI-only.
   */
  pastLabel: string;
  /** The schema sent to the model. */
  definition: ToolDefinition;
  /**
   * Bind the tool to a context. Return `null` when this tool cannot operate in
   * the given context (e.g. a campaign tool with no campaign), in which case
   * it is silently omitted from the agent's tool list.
   */
  create(ctx: ToolContext): AgentTool | null;
}
