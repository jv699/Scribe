/** Reads a session's planning notes, addressed by session number. */
import { readSessionNotes } from "../../store/sessions.ts";
import { findSession, numberArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const readSessionNotesTool: ToolSpec = {
  name: "read_session_notes",
  label: "Reading the session notes",
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
  create({ campaign }) {
    if (!campaign) return null;
    return {
      definition: readSessionNotesTool.definition,
      execute: async (args) => {
        const session = await findSession(campaign.dir, numberArg(args, "number"));
        return session ? await readSessionNotes(session) : "(session not found)";
      },
    };
  },
};
