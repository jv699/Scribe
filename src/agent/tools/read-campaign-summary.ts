/** Reads the campaign's running summary ("The Story So Far"). */
import { freshCampaign } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const readCampaignSummaryTool: ToolSpec = {
  name: "read_campaign_summary",
  definition: {
    type: "function",
    function: {
      name: "read_campaign_summary",
      description:
        "Read the campaign's running summary ('The Story So Far') — the accumulated record of what has happened in previous sessions.",
      parameters: { type: "object", properties: {} },
    },
  },
  create({ campaign }) {
    if (!campaign) return null;
    return {
      definition: readCampaignSummaryTool.definition,
      // Re-read from disk: append_campaign_summary may have run this turn.
      execute: async () => (await freshCampaign(campaign)).storySoFar || "(no story yet)",
    };
  },
};
