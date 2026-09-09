/**
 * Tools combine a model-facing definition with a context-bound factory.
 * Model arguments must identify resources, never supply filesystem paths;
 * tools resolve paths through `src/store/`.
 */
import type { ToolDefinition } from "../../provider/types.ts";
import type { Campaign } from "../../store/campaigns.ts";
import type { Session } from "../../store/sessions.ts";
import type { SavedOneshot } from "../../store/oneshots.ts";
import type { AskChannel } from "../ask.ts";
import type { AgentTool } from "../loop.ts";

export type { AgentTool, ToolDefinition };

export interface ActiveOneshot {
  current: SavedOneshot | null;
  onRead?: (oneshot: SavedOneshot) => void;
}

/** Fields are optional so context-free tools can resolve without a campaign. */
export interface ToolContext {
  campaign?: Campaign;
  session?: Session;
  oneshotsDir?: string;
  activeOneshot?: ActiveOneshot;
  sourcesDir?: string;
  defaultSystem?: string;
  /** Without a channel, ask_user is omitted. */
  ask?: AskChannel;
}

export interface ToolSpec {
  /** Must match `definition.function.name` and the registry key. */
  name: string;
  /** Present-tense activity label; UI-only. */
  label: string;
  /** Past-tense activity label; UI-only. */
  pastLabel: string;
  definition: ToolDefinition;
  /** Return null to omit the tool when required context is missing. */
  create(ctx: ToolContext): AgentTool | null;
}
