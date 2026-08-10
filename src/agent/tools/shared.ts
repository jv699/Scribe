/**
 * Argument coercion and resource lookup shared by the tool implementations.
 *
 * Tool arguments arrive as parsed JSON from the model, so nothing about their
 * shape is guaranteed. These helpers coerce defensively rather than throwing —
 * a tool returning "(session not found)" is a recoverable turn for the agent,
 * an exception is not.
 */
import { loadCampaign, type Campaign } from "../../store/campaigns.ts";
import { listSessions, type Session } from "../../store/sessions.ts";

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/**
 * Coerce a number, tolerating the string forms models often emit ("3" instead
 * of 3) for the same reason `boolArg` does. Anything else becomes NaN, which
 * callers treat as "not found" rather than throwing.
 */
export function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

/**
 * Coerce a flag, tolerating the string forms models often emit ("true"/"false")
 * instead of a JSON boolean. Anything unrecognized falls back to `fallback`.
 */
export function boolArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/**
 * Resolve a session by number, re-reading the campaign from disk so the agent
 * observes writes it made earlier in the same run.
 */
export async function findSession(campaignDir: string, number: number): Promise<Session | null> {
  if (!Number.isInteger(number) || number <= 0) return null;
  const campaign = await loadCampaign(campaignDir);
  if (!campaign) return null;
  const sessions = await listSessions(campaign);
  return sessions.find((s) => s.number === number) ?? null;
}

/** Re-read a campaign from disk, falling back to the context copy. */
export async function freshCampaign(campaign: Campaign): Promise<Campaign> {
  return (await loadCampaign(campaign.dir)) ?? campaign;
}
