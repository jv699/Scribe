/** Replaces a session's planning notes — the agent's main write path. */
import { writeSessionNotes } from "../../store/sessions.ts";
import { findSession, numberArg, stringArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const updateSessionNotesTool: ToolSpec = {
  name: "update_session_notes",
  label: "Writing the session notes",
  pastLabel: "Wrote the session notes",
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
  create({ campaign }) {
    if (!campaign) return null;
    return {
      definition: updateSessionNotesTool.definition,
      execute: async (args) => {
        const content = stringArg(args, "content");
        if (content.trim() === "") return "(content cannot be empty)";
        const session = await findSession(campaign.dir, numberArg(args, "number"));
        if (!session) return "(session not found)";
        await writeSessionNotes(session, content);
        return `Updated notes for session ${session.number} ("${session.title}").`;
      },
    };
  },
};
