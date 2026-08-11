/** Lists the campaign's sessions so the agent can orient itself. */
import { listSessions } from "../../store/sessions.ts";
import type { ToolSpec } from "./types.ts";

export const listSessionsTool: ToolSpec = {
  name: "list_sessions",
  label: "Looking over the sessions",
  definition: {
    type: "function",
    function: {
      name: "list_sessions",
      description: "List the campaign's sessions with their numbers, titles, and statuses.",
      parameters: { type: "object", properties: {} },
    },
  },
  create({ campaign }) {
    if (!campaign) return null;
    return {
      definition: listSessionsTool.definition,
      execute: async () => {
        const sessions = await listSessions(campaign);
        return sessions.map((s) => `${s.number}. "${s.title}" [${s.status}]`).join("\n") || "(no sessions yet)";
      },
    };
  },
};
