/**
 * Lists the user's PDF source documents (rulebooks, bestiaries, adventures),
 * grouped by system. Granted to `planning` and `oneshot` so the agent knows
 * what reference material exists to consult via `search_sources` instead of
 * guessing at system-specific rules.
 */
import { indexSources, listSources } from "../../store/sources.ts";
import { stringArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const listSourcesTool: ToolSpec = {
  name: "list_sources",
  label: "Browsing the source library",
  pastLabel: "Browsed the source library",
  definition: {
    type: "function",
    function: {
      name: "list_sources",
      description:
        "List the user's reference PDFs (rulebooks, bestiaries, adventures) available in their source library, grouped by game system. Consult these — via search_sources — for system-specific rules instead of guessing.",
      parameters: {
        type: "object",
        properties: {
          system: { type: "string", description: "Only list documents for this game system, if given" },
        },
        required: [],
      },
    },
  },
  create({ sourcesDir }) {
    if (!sourcesDir) return null;
    return {
      definition: listSourcesTool.definition,
      execute: async (args) => {
        await indexSources(sourcesDir);
        const system = stringArg(args, "system").trim();
        const docs = await listSources(sourcesDir, system !== "" ? system : undefined);
        if (docs.length === 0) return "(no source documents — the user can add PDFs under the Sources folder)";

        const bySystem = new Map<string, typeof docs>();
        for (const doc of docs) {
          const group = bySystem.get(doc.system);
          if (group) group.push(doc);
          else bySystem.set(doc.system, [doc]);
        }

        const lines: string[] = [];
        for (const [groupSystem, group] of bySystem) {
          lines.push(`${groupSystem}:`);
          for (const doc of group) {
            lines.push(`  [${doc.slug}] ${doc.title} — ${doc.pages} page${doc.pages === 1 ? "" : "s"}`);
          }
        }
        return lines.join("\n");
      },
    };
  },
};
