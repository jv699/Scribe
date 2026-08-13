/** Lists the saved plans available to the Drafting Table agent. */
import { listOneshots } from "../../store/oneshots.ts";
import type { ToolSpec } from "./types.ts";

export const listOneshotsTool: ToolSpec = {
  name: "list_oneshots",
  label: "Listing saved one-shots",
  pastLabel: "Listed saved one-shots",
  definition: {
    type: "function",
    function: {
      name: "list_oneshots",
      description: "List saved one-shot documents that can be continued in the Drafting Table.",
      parameters: { type: "object", properties: {} },
    },
  },
  create({ oneshotsDir }) {
    if (!oneshotsDir) return null;
    return {
      definition: listOneshotsTool.definition,
      execute: async () => {
        const oneshots = await listOneshots(oneshotsDir);
        if (oneshots.length === 0) return "(no saved one-shots)";
        return oneshots.map((oneshot) => `- ${oneshot.displayName} (slug: ${oneshot.slug})`).join("\n");
      },
    };
  },
};
