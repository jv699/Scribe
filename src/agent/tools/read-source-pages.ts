/**
 * Reads a page range's full text from a cached source document, addressed by
 * slug or title (as surfaced by `list_sources` / `search_sources`) — never a
 * filesystem path. Granted to `planning` and `oneshot`.
 */
import { indexSources, readSourcePages } from "../../store/sources.ts";
import { numberArg, stringArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const readSourcePagesTool: ToolSpec = {
  name: "read_source_pages",
  label: "Reading the source pages",
  definition: {
    type: "function",
    function: {
      name: "read_source_pages",
      description:
        "Read the full text of a page range from a source document, addressed by the slug or title from a prior list_sources or search_sources result. The range is capped at 10 pages.",
      parameters: {
        type: "object",
        properties: {
          document: { type: "string", description: "The document's slug or title" },
          from: { type: "number", description: "First page to read" },
          to: { type: "number", description: "Last page to read (defaults to from, capped at from + 9)" },
        },
        required: ["document", "from"],
      },
    },
  },
  create({ sourcesDir }) {
    if (!sourcesDir) return null;
    return {
      definition: readSourcePagesTool.definition,
      execute: async (args) => {
        await indexSources(sourcesDir);

        const document = stringArg(args, "document").trim();
        const from = numberArg(args, "from");
        const toArg = numberArg(args, "to");
        const to = Number.isFinite(toArg) ? toArg : from;

        if (document === "") return "(name a document — call list_sources to see what is available)";
        if (!Number.isFinite(from)) return "(give a first page number)";

        const result = await readSourcePages(sourcesDir, document, from, to);
        if (!result) return "(no such source document — call list_sources to see what is available)";

        return `${result.doc.title} (${result.doc.system}):\n\n${result.text}`;
      },
    };
  },
};
