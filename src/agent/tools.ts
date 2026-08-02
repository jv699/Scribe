/**
 * Campaign-scoped tools for the agent. Every path the agent can touch stays
 * inside the campaign folder; session access happens by number, resolved via
 * the store (never from raw user-supplied paths).
 */
import { appendStorySoFar, loadCampaign } from "../store/campaigns.ts";
import { listSessions, readSessionNotes, writeSessionNotes } from "../store/sessions.ts";
import type { AgentTool } from "./loop.ts";

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  return typeof value === "number" ? value : NaN;
}

export interface CampaignToolsOptions {
  /** Report mode: also expose `append_campaign_summary`. */
  report?: boolean;
}

export async function makeCampaignTools(campaignDir: string, options: CampaignToolsOptions = {}): Promise<AgentTool[]> {
  const campaign = await loadCampaign(campaignDir);
  if (!campaign) return [];

  const tools: AgentTool[] = [
    {
      definition: {
        type: "function",
        function: {
          name: "list_sessions",
          description: "List the campaign's sessions with their numbers, titles, and statuses.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () => {
        const sessions = await listSessions(campaign);
        return sessions
          .map((s) => `${s.number}. "${s.title}" [${s.status}]`)
          .join("\n") || "(no sessions yet)";
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_campaign_summary",
          description:
            "Read the campaign's running summary ('The Story So Far') — the accumulated record of what has happened in previous sessions.",
          parameters: { type: "object", properties: {} },
        },
      },
      execute: async () =>
        (await loadCampaign(campaign.dir))?.storySoFar || "(no story yet)",
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_session_notes",
          description: "Read the planning notes (markdown body) of a session by its number.",
          parameters: {
            type: "object",
            properties: { number: { type: "number", description: "Session number (e.g. 1)" } },
            required: ["number"],
          },
        },
      },
      execute: async (args) => {
        const session = await findSession(campaign.dir, numberArg(args, "number"));
        return session ? await readSessionNotes(session) : "(session not found)";
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "update_session_notes",
          description:
            "Replace the planning notes (markdown body) of a session by its number. Use this to draft or refine the session plan the user will run at the table.",
          parameters: {
            type: "object",
            properties: {
              number: { type: "number", description: "Session number (e.g. 1)" },
              content: { type: "string", description: "The full new markdown body of the session notes" },
            },
            required: ["number", "content"],
          },
        },
      },
      execute: async (args) => {
        const session = await findSession(campaign.dir, numberArg(args, "number"));
        if (!session) return "(session not found)";
        await writeSessionNotes(session, stringArg(args, "content"));
        return `Updated notes for session ${session.number} ("${session.title}").`;
      },
    },
  ];

  if (options.report) {
    tools.push({
      definition: {
        type: "function",
        function: {
          name: "append_campaign_summary",
          description:
            "Append an entry to the campaign's running summary ('The Story So Far'), recording what happened in the session that was just played. Use this after the user reports the session outcome.",
          parameters: {
            type: "object",
            properties: { entry: { type: "string", description: "The concise summary entry to append" } },
            required: ["entry"],
          },
        },
      },
      execute: async (args) => {
        const entry = stringArg(args, "entry").trim();
        if (entry === "") return "(entry cannot be empty)";
        await appendStorySoFar(campaign, entry);
        return "Appended to the campaign's story so far.";
      },
    });
  }

  return tools;
}

async function findSession(campaignDir: string, number: number) {
  if (!Number.isInteger(number) || number <= 0) return null;
  const campaign = await loadCampaign(campaignDir);
  if (!campaign) return null;
  const sessions = await listSessions(campaign);
  return sessions.find((s) => s.number === number) ?? null;
}
