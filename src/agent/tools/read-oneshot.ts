/** Reads a saved plan and makes it the active Drafting Table document. */
import { findOneshot } from "../../store/oneshots.ts";
import { stringArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const readOneshotTool: ToolSpec = {
  name: "read_oneshot",
  label: "Reading the saved one-shot",
  pastLabel: "Read the saved one-shot",
  definition: {
    type: "function",
    function: {
      name: "read_oneshot",
      description:
        "Read a saved one-shot by the exact slug or display name returned by list_oneshots. This also selects it for update_oneshot.",
      parameters: {
        type: "object",
        properties: {
          document: { type: "string", description: "The saved one-shot slug or display name" },
        },
        required: ["document"],
      },
    },
  },
  create({ oneshotsDir, activeOneshot }) {
    if (!oneshotsDir || !activeOneshot) return null;
    return {
      definition: readOneshotTool.definition,
      execute: async (args) => {
        const oneshot = await findOneshot(oneshotsDir, stringArg(args, "document"));
        if (!oneshot) return "(one-shot not found or ambiguous)";
        activeOneshot.current = oneshot;
        activeOneshot.onRead?.(oneshot);
        const metadata = Object.entries(oneshot.data)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");
        return `Saved one-shot metadata:\n${metadata || "(none)"}\n\nSaved one-shot body:\n${oneshot.body}`;
      },
    };
  },
};
