/**
 * The ask seam: how the `ask_user` tool reaches whatever UI is on screen.
 *
 * A tool cannot import a screen (the screens import the agent, not the other
 * way round), and tools are resolved *before* the chat screen exists — the app
 * calls `toolsFor(...)` to build the tool list it then hands to
 * `makeChatScreen`. So the two are introduced by a channel: the app makes one,
 * passes it into both, and the screen attaches its handler on mount.
 *
 * The channel is also the safety net. Whoever attaches gets a detach function,
 * and detaching **settles any question still on screen** with `null`. Without
 * that, backing out of a chat mid-question would leave `runAgent` awaiting a
 * promise nobody can resolve — a permanently stuck turn.
 */

/**
 * The tool's name, shared so the transcript can recognise its results without
 * a screen having to import a tool module.
 */
export const ASK_USER_TOOL_NAME = "ask_user";

/** One option the user can pick. */
export interface AskOption {
  label: string;
  /** Optional secondary line, shown dimmed next to the label. */
  description?: string;
}

/**
 * A single question. Deliberately one question per request: the agent asks
 * again if it needs a follow-up, which keeps the widget a flat list instead of
 * a multi-tab form with its own review step.
 */
export interface AskQuestion {
  /** The question itself, e.g. "Which hook should drive session 3?". */
  question: string;
  /** Short label above the question, e.g. "Session hook". */
  header?: string;
  options: AskOption[];
  /** Allow picking more than one option. Defaults to false. */
  multiple?: boolean;
  /** Offer a "type your own answer" row. Defaults to true. */
  custom?: boolean;
}

export interface AskAnswer {
  /** Echo of the question, so a result can be rendered without extra context. */
  question: string;
  /** Chosen labels, or free text when the user typed their own. */
  answers: string[];
}

/** Presents a question and resolves with the user's answer, or `null` if declined. */
export type AskHandler = (question: AskQuestion) => Promise<AskAnswer | null>;

export interface AskChannel {
  /**
   * Ask the user. Resolves `null` when the question was declined, dismissed,
   * or the UI went away — callers must treat that as a normal outcome, never
   * an error.
   */
  ask: AskHandler;
  /**
   * Install the UI's handler. Returns a detach function that also settles any
   * in-flight question with `null`. Attaching replaces any previous handler.
   */
  attach(handler: AskHandler): () => void;
  /** Whether a handler is currently attached (i.e. there is a UI to ask). */
  readonly available: boolean;
  /**
   * Count of questions currently awaiting an answer. Exists mainly so tests
   * can assert the pending queue doesn't grow unboundedly across a long
   * conversation of sequentially answered questions.
   */
  readonly pendingCount: number;
}

export function makeAskChannel(): AskChannel {
  let handler: AskHandler | null = null;
  /** Resolvers for questions currently awaiting an answer. */
  let pending: ((answer: AskAnswer | null) => void)[] = [];

  return {
    get available() {
      return handler !== null;
    },

    get pendingCount() {
      return pending.length;
    },

    ask: async (question) => {
      const active = handler;
      // No UI attached (headless run, or the screen already went away).
      if (!active) return null;

      // Race the handler against detachment so a disposed screen can't leave
      // this promise dangling. Whichever settles first wins; the loser is
      // ignored because `resolve` after settlement is a no-op.
      return new Promise<AskAnswer | null>((resolve) => {
        // Wrap `resolve` so a normally-answered question removes its own
        // entry from `pending` instead of riding along until the next
        // detach — otherwise a long session's answered questions pile up
        // in the array forever.
        const settle = (answer: AskAnswer | null) => {
          const index = pending.indexOf(settle);
          if (index !== -1) pending.splice(index, 1);
          resolve(answer);
        };
        pending.push(settle);
        void active(question).then(
          (answer) => settle(answer),
          // A crashing widget must not take the agent turn down with it —
          // it reads as a decline, same as Escape.
          () => settle(null),
        );
      });
    },

    attach: (next) => {
      handler = next;
      return () => {
        // Only stand down if we're still the installed handler; a later
        // attach means someone else owns the channel now.
        if (handler === next) handler = null;
        const settling = pending;
        pending = [];
        for (const resolve of settling) resolve(null);
      };
    },
  };
}

/**
 * The tool result string for an answered question — and, by design, exactly
 * what the transcript shows. Keeping one representation means the transcript
 * needs no JSON parsing, resumed conversations render for free from the saved
 * log, and the model reads the same plain text the user sees.
 */
export function formatAskResult(answer: AskAnswer): string {
  const chosen = answer.answers.length > 0 ? answer.answers.join(", ") : "(no answer)";
  return `Asked: ${answer.question}\nAnswer: ${chosen}`;
}

/** The tool result when the user dismissed the question instead of answering. */
export const ASK_DECLINED = "The user dismissed the question without answering.";

/** Split a `formatAskResult` string back into its parts, for rendering. */
export function parseAskResult(content: string): { question: string; answer: string } | null {
  const match = /^Asked: ([^\n]*)\nAnswer: ([\s\S]*)$/.exec(content);
  if (!match) return null;
  return { question: match[1]!, answer: match[2]! };
}
