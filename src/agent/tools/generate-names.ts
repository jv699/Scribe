/**
 * Names for NPCs and places, so plans don't keep reaching for the same few
 * names a model favours. Real cultures come from Behind the Name when the user
 * has a key; invented ones (and everything, without a key) from the offline
 * generator in `src/names/`.
 *
 * This is the one tool that makes a network request, so the security rule
 * that tools take no paths has a network twin here: the model's `culture` is
 * looked up in a fixed table and only that table's usage code reaches the
 * URL; gender is an enum and count is clamped. Nothing the model wrote is
 * passed through.
 */
import { cultureLabels, findCulture } from "../../names/cultures.ts";
import type { NameGender, NameKind } from "../../names/generator.ts";
import type { ChatMessage } from "../../provider/types.ts";
import { boolArg, numberArg, stringArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

export const MAX_NAMES = 12;
const DEFAULT_NAMES = 8;

const labels = cultureLabels();

function enumArg<T extends string>(args: Record<string, unknown>, key: string, values: readonly T[], fallback: T): T {
  const value = stringArg(args, key).trim().toLowerCase();
  return (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

export const generateNamesTool: ToolSpec = {
  name: "generate_names",
  label: "Finding names",
  pastLabel: "Found names",
  definition: {
    type: "function",
    function: {
      name: "generate_names",
      description:
        "Get a list of names for NPCs or places in a given culture or style, instead of inventing them yourself. " +
        "Ask for several at once and pick or adapt the ones that fit. Each call returns names not given out earlier in this chat. " +
        `Fantasy styles: ${labels.fantasy.join(", ")}. ` +
        `Real and historical cultures: ${labels.real.join(", ")}.`,
      parameters: {
        type: "object",
        properties: {
          culture: { type: "string", description: "A culture or style from the lists above, e.g. \"Dwarvish\" or \"Welsh\"" },
          count: { type: "number", description: `How many names (1-${MAX_NAMES}, default ${DEFAULT_NAMES})` },
          gender: { type: "string", enum: ["male", "female", "any"], description: "For people (default any)" },
          kind: { type: "string", enum: ["person", "place"], description: "Person or place names (default person)" },
          surnames: { type: "boolean", description: "Add a family name to each person (default false)" },
        },
        required: ["culture"],
      },
    },
  },
  create({ names }) {
    if (!names) return null;
    return {
      definition: generateNamesTool.definition,
      execute: async (args) => {
        const asked = stringArg(args, "culture").trim();
        const culture = findCulture(asked);
        if (!culture) {
          return (
            `(unknown culture "${asked}"; pick the closest of these)\n` +
            `Fantasy styles: ${labels.fantasy.join(", ")}\n` +
            `Real and historical cultures: ${labels.real.join(", ")}`
          );
        }

        const countArg = numberArg(args, "count");
        const count = Number.isFinite(countArg) ? Math.min(MAX_NAMES, Math.max(1, Math.floor(countArg))) : DEFAULT_NAMES;
        const gender = enumArg<NameGender>(args, "gender", ["male", "female", "any"], "any");
        const kind = enumArg<NameKind>(args, "kind", ["person", "place"], "person");
        const surnames = kind === "person" && boolArg(args, "surnames", false);

        const batch = await names.generate({ culture, count, gender, kind, surnames });

        if (batch.source === "none") {
          const what = kind === "place" ? "place names" : "names";
          const why =
            batch.skipped === "places"
              ? "Behind the Name has only people's names"
              : batch.skipped === "no-key"
                ? "real-world names need a Behind the Name key, which isn't set"
                : "Behind the Name didn't answer";
          return (
            `(no ${culture.label} ${what} available: ${why}, and there is no offline style for ${culture.label}. ` +
            `Write them yourself, varying them, or use a fantasy style.)`
          );
        }
        if (batch.names.length === 0) return `(no new ${culture.label} names this time; call again or try a related culture)`;

        const header =
          batch.source === "behindthename"
            ? `${culture.label} names from Behind the Name:`
            : batch.style && batch.style !== culture.label.toLowerCase()
              ? `${culture.label} ${kind} names (generated in a ${batch.style} style):`
              : `${culture.label} ${kind} names (generated):`;
        const lines = [header, ...batch.names.map((name) => `- ${name}`)];
        if (batch.fellBack) lines.push("(Behind the Name didn't answer, so these were generated instead.)");
        if (batch.names.length < count) lines.push(`(${batch.names.length} of ${count}; call again for more.)`);
        return lines.join("\n");
      },
    };
  },
};

/**
 * Every name earlier generate_names results in a conversation handed out, so
 * a resumed chat can tell a fresh NameService what not to repeat. Results are
 * found by call id, as the transcript finds ask_user's, and names are the
 * result's "- " lines; notes in parentheses are not names.
 */
export function namesInConversation(messages: readonly ChatMessage[]): string[] {
  const callIds = new Set<string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.function.name === generateNamesTool.name) callIds.add(call.id);
    }
  }
  const names: string[] = [];
  for (const message of messages) {
    if (message.role !== "tool" || !message.tool_call_id || !callIds.has(message.tool_call_id)) continue;
    for (const line of message.content.split("\n")) {
      if (line.startsWith("- ")) names.push(line.slice(2).trim());
    }
  }
  return names;
}
