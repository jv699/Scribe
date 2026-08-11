/**
 * Appends to the campaign's running summary. Granted to the report agent only —
 * the planning agent must not rewrite history while drafting a future session.
 */
import { appendStorySoFar } from "../../store/campaigns.ts";
import { stringArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const appendCampaignSummaryTool: ToolSpec = {
  name: "append_campaign_summary",
  label: "Updating the campaign summary",
  pastLabel: "Updated the campaign summary",
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
  create({ campaign }) {
    if (!campaign) return null;
    return {
      definition: appendCampaignSummaryTool.definition,
      execute: async (args) => {
        const entry = stringArg(args, "entry").trim();
        if (entry === "") return "(entry cannot be empty)";
        await appendStorySoFar(campaign, entry);
        return "Appended to the campaign's story so far.";
      },
    };
  },
};
