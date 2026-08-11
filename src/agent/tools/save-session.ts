/**
 * Saves a drafted one-shot plan to a markdown file in the configured one-shots
 * directory. Granted to the oneshot (Drafting Table) agent only. Saving is
 * gated on an explicit user request: both this tool's description and the
 * one-shot system prompt forbid calling it on the agent's own initiative.
 */
import { saveOneshot } from "../../store/oneshots.ts";
import { abbreviateHome } from "../../store/settings.ts";
import { stringArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const saveSessionTool: ToolSpec = {
  name: "save_session",
  label: "Saving the plan",
  pastLabel: "Saved the plan",
  definition: {
    type: "function",
    function: {
      name: "save_session",
      description:
        'Save the one-shot plan to a markdown file on disk. ONLY call this tool when the user has explicitly asked to save the session, or has clearly agreed after you offered. Never call it on your own initiative.',
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "A short title for the one-shot; used as the file name" },
          content: { type: "string", description: "The full one-shot plan as markdown" },
          system: { type: "string", description: 'The game system, if known (e.g. "5e")' },
        },
        required: ["title", "content"],
      },
    },
  },
  create({ oneshotsDir }) {
    if (!oneshotsDir) return null;
    return {
      definition: saveSessionTool.definition,
      execute: async (args) => {
        const title = stringArg(args, "title").trim();
        const content = stringArg(args, "content").trim();
        if (title === "" || content === "") return "(title and content cannot be empty)";
        const system = stringArg(args, "system").trim();
        const path = await saveOneshot(oneshotsDir, { title, content, ...(system !== "" ? { system } : {}) });
        return `Saved one-shot "${title}" to ${abbreviateHome(path)}`;
      },
    };
  },
};
