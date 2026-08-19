/**
 * Asks the user a multiple-choice question and blocks until they answer.
 *
 * This is the one tool whose result comes from the person rather than the disk.
 * It resolves only when a UI is attached to the `AskChannel` (see
 * `../ask.ts`) — a headless or scripted run declines it, exactly like the
 * campaign tools decline a campaign-less context, so granting it to every
 * agent stays safe.
 *
 * The result string doubles as the transcript row (`formatAskResult`), so the
 * model reads the same plain text the user sees.
 */
import { ASK_DECLINED, ASK_USER_TOOL_NAME, formatAskResult, type AskOption } from "../ask.ts";
import { boolArg, stringArg } from "./shared.ts";
import type { ToolSpec } from "./types.ts";

/** How many options a single question may offer (rows are pickable by digit). */
const MAX_OPTIONS = 9;

/** Generic meta-options that duplicate the widget's built-in free-text row. */
const CUSTOM_PLACEHOLDERS = new Set([
  "custom",
  "custom answer",
  "other",
  "other answer",
  "something else",
  "type your own",
  "type your own answer",
  "write your own",
  "write your own answer",
  "enter your own",
  "enter your own answer",
]);

export const askUserTool: ToolSpec = {
  name: ASK_USER_TOOL_NAME,
  label: "Waiting for your answer",
  pastLabel: "Waited for your answer",
  definition: {
    type: "function",
    function: {
      name: ASK_USER_TOOL_NAME,
      description:
        "Ask the user to choose between concrete options, and wait for their answer. " +
        "Use this at genuine forks — which hook to build a session around, which NPC " +
        "should betray the party, which of several tones to take — instead of guessing " +
        "or writing a wall of prose asking them to reply. Ask one question at a time; " +
        "call this again if you need a follow-up. Offer 2-9 concrete, meaningfully " +
        "different options, each a short label the user can scan. Never include a " +
        '"Custom", "Other", or "Type your own answer" option: the custom flag makes ' +
        "the UI add that row automatically. Do not use it for " +
        "open-ended questions with no natural options (just ask those in your reply), " +
        "and do not use it to ask permission for work you can simply do.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to put to the user, phrased as a full sentence",
          },
          header: {
            type: "string",
            description: 'Optional 1-3 word label for the question, e.g. "Session hook"',
          },
          options: {
            type: "array",
            description:
              `The concrete choices to offer (2-${MAX_OPTIONS}). Do not add a Custom, Other, ` +
              "or Type your own answer choice; use the custom flag for free text.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short scannable choice, a few words" },
                description: {
                  type: "string",
                  description: "Optional one-line elaboration of the choice",
                },
              },
              required: ["label"],
            },
          },
          multiple: {
            type: "boolean",
            description: "Let the user pick more than one option. Defaults to false.",
          },
          custom: {
            type: "boolean",
            description:
              "Make the UI append a 'type your own answer' row. Defaults to true; set false only when the options are genuinely exhaustive.",
          },
        },
        required: ["question", "options"],
      },
    },
  },

  create({ ask }) {
    // No channel means no UI to ask through — decline rather than hang.
    if (!ask) return null;
    return {
      definition: askUserTool.definition,
      // Gated on a human keystroke, so it can't be part of a runaway loop.
      userDriven: true,
      execute: async (args) => {
        const question = stringArg(args, "question").trim();
        if (question === "") return "(question cannot be empty)";

        const custom = boolArg(args, "custom", true);
        const options = coerceOptions(args["options"], custom);
        if (options.length === 0) return "(provide at least one option)";

        const header = stringArg(args, "header").trim();
        const answer = await ask.ask({
          question,
          options,
          multiple: boolArg(args, "multiple", false),
          custom,
          ...(header !== "" ? { header } : {}),
        });

        if (!answer) return ASK_DECLINED;
        return formatAskResult(answer);
      },
    };
  },
};

/**
 * Normalize the `options` argument. Models are inconsistent here — the schema
 * asks for `{label, description}` objects but plain strings are just as common,
 * and a single option sometimes arrives unwrapped. All three are accepted;
 * anything else is dropped rather than throwing.
 */
function coerceOptions(raw: unknown, custom: boolean): AskOption[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const options: AskOption[] = [];
  const seen = new Set<string>();

  for (const entry of list) {
    const option = coerceOption(entry);
    // When enabled, the widget owns its free-text row. Some models still emit
    // a placeholder choice as well, which would otherwise produce the
    // duplicate shown as "Custom" followed by "Type your own answer…".
    if (custom && option && isCustomPlaceholder(option.label)) continue;
    // Duplicate labels would make the answer ambiguous, and digit-picking
    // confusing. First one wins.
    if (!option || seen.has(option.label)) continue;
    seen.add(option.label);
    options.push(option);
    if (options.length === MAX_OPTIONS) break;
  }
  return options;
}

function isCustomPlaceholder(label: string): boolean {
  const normalized = label
    .toLowerCase()
    .replace(/[.…]+$/u, "")
    .trim();
  return CUSTOM_PLACEHOLDERS.has(normalized);
}

function coerceOption(entry: unknown): AskOption | null {
  if (typeof entry === "string") {
    const label = entry.trim();
    return label === "" ? null : { label };
  }
  if (typeof entry !== "object" || entry === null) return null;

  const record = entry as Record<string, unknown>;
  const label = (typeof record["label"] === "string" ? record["label"] : "").trim();
  if (label === "") return null;
  const description = (typeof record["description"] === "string" ? record["description"] : "").trim();
  return description === "" ? { label } : { label, description };
}
