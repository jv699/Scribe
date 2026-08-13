/** Replaces the active saved one-shot's body while preserving frontmatter. */
import { writeOneshot } from "../../store/oneshots.ts";
import { stringArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const updateOneshotTool: ToolSpec = {
  name: "update_oneshot",
  label: "Writing the saved one-shot",
  pastLabel: "Wrote the saved one-shot",
  definition: {
    type: "function",
    function: {
      name: "update_oneshot",
      description:
        "Replace the complete markdown body of the saved one-shot most recently selected by read_oneshot. Preserve the whole runnable plan in the replacement content.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "The complete new markdown body for the active one-shot" },
        },
        required: ["content"],
      },
    },
  },
  create({ oneshotsDir, activeOneshot }) {
    if (!oneshotsDir || !activeOneshot) return null;
    return {
      definition: updateOneshotTool.definition,
      execute: async (args) => {
        if (!activeOneshot.current) return "(read a one-shot before updating it)";
        const content = stringArg(args, "content");
        if (content.trim() === "") return "(content cannot be empty)";
        activeOneshot.current = await writeOneshot(activeOneshot.current, content);
        return `Updated saved one-shot "${activeOneshot.current.displayName}".`;
      },
    };
  },
};
