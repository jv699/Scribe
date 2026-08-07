/**
 * Full-text search over the user's cached source-document library. Granted to
 * `planning` and `oneshot`, scoped by default to the campaign's game system
 * (`defaultSystem`) so a search for "grapple" in a Shadowdark campaign doesn't
 * surface a 5e rulebook that happens to share the shelf.
 */
import { indexSources, searchSources } from "../../store/sources.ts";
import { boolArg, numberArg, stringArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const searchSourcesTool: ToolSpec = {
  name: "search_sources",
  definition: {
    type: "function",
    function: {
      name: "search_sources",
      description:
        "Search the user's reference PDFs (rulebooks, bestiaries, adventures) for a term or phrase. By default this is scoped to the campaign's game system; pass all_systems to search everything, or system to search a specific one. Follow up a promising hit with read_source_pages for the full text.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for, e.g. \"grapple check\"" },
          system: { type: "string", description: "Only search documents for this game system" },
          all_systems: { type: "boolean", description: "Search across every system, ignoring the campaign default" },
          limit: { type: "number", description: "Maximum number of hits to return (default 8)" },
        },
        required: ["query"],
      },
    },
  },
  create({ sourcesDir, defaultSystem }) {
    if (!sourcesDir) return null;
    return {
      definition: searchSourcesTool.definition,
      execute: async (args) => {
        await indexSources(sourcesDir);

        const query = stringArg(args, "query").trim();
        if (query === "") return "(provide a search query)";

        const explicitSystem = stringArg(args, "system").trim();
        const allSystems = boolArg(args, "all_systems", false);
        const system = explicitSystem !== "" ? explicitSystem : allSystems ? undefined : defaultSystem;

        const limitArg = numberArg(args, "limit");
        const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.floor(limitArg) : undefined;

        const limitOpt = limit !== undefined ? { limit } : {};
        let hits = await searchSources(sourcesDir, query, {
          ...(system !== undefined ? { system } : {}),
          ...limitOpt,
        });

        // `defaultSystem` is the campaign's free-text system field ("D&D 5e"),
        // which need not match a folder name ("5e"). Rather than report a
        // silent miss caused by that mismatch, widen to the whole library and
        // say so — the agent can then judge whether the hits are relevant.
        let widened = false;
        if (hits.length === 0 && system !== undefined && explicitSystem === "") {
          hits = await searchSources(sourcesDir, query, limitOpt);
          widened = hits.length > 0;
        }

        if (hits.length === 0) return `(no matches for "${query}")`;

        const lines = hits.map((hit) => `[${hit.doc.slug}] ${hit.doc.title}, p.${hit.page} — "${hit.snippet}"`);
        if (widened) {
          lines.unshift(`(nothing filed under "${system}" — searched every system instead)`);
        }
        lines.push("Call read_source_pages with a slug and page range for the full text of a hit.");
        return lines.join("\n");
      },
    };
  },
};
