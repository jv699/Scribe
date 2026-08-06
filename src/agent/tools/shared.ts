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

export function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  return typeof value === "number" ? value : NaN;
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
