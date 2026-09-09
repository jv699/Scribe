import { loadCampaign, type Campaign } from "../../store/campaigns.ts";
import { listSessions, type Session } from "../../store/sessions.ts";

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

/** Accept numeric strings because models emit them despite the schema. */
export function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return NaN;
}

/** Accept "true"/"false" because models emit strings despite the schema. */
export function boolArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

/** Re-read from disk so the agent sees its own writes within a turn. */
export async function findSession(campaignDir: string, number: number): Promise<Session | null> {
  if (!Number.isInteger(number) || number <= 0) return null;
  const campaign = await loadCampaign(campaignDir);
  if (!campaign) return null;
  const sessions = await listSessions(campaign);
  return sessions.find((s) => s.number === number) ?? null;
}

export async function freshCampaign(campaign: Campaign): Promise<Campaign> {
  return (await loadCampaign(campaign.dir)) ?? campaign;
}
