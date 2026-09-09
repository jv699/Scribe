export const ASK_USER_TOOL_NAME = "ask_user";

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  /** Defaults to false. */
  multiple?: boolean;
  /** Offer free-text input; defaults to true. */
  custom?: boolean;
}

export interface AskAnswer {
  /** Kept with the answer so the result can render without external context. */
  question: string;
  answers: string[];
}

export type AskHandler = (question: AskQuestion) => Promise<AskAnswer | null>;

export interface AskChannel {
  /** Null is a normal outcome: declined, dismissed, or no UI. */
  ask: AskHandler;
  /**
   * Install the UI's handler. Returns a detach function that also settles any
   * in-flight question with `null`. Attaching replaces any previous handler.
   */
  attach(handler: AskHandler): () => void;
  readonly available: boolean;
  /** Exposed so tests can detect leaked pending questions. */
  readonly pendingCount: number;
}

export function makeAskChannel(): AskChannel {
  let handler: AskHandler | null = null;
  interface PendingAsk {
    owner: AskHandler;
    settle(answer: AskAnswer | null): void;
  }
  let pending: PendingAsk[] = [];

  return {
    get available() {
      return handler !== null;
    },

    get pendingCount() {
      return pending.length;
    },

    ask: async (question) => {
      const active = handler;
      if (!active) return null;

      // Detachment settles the promise if its UI disappears mid-question.
      return new Promise<AskAnswer | null>((resolve) => {
        const entry: PendingAsk = {
          owner: active,
          settle: (answer) => {
            const index = pending.indexOf(entry);
            if (index !== -1) pending.splice(index, 1);
            resolve(answer);
          },
        };
        pending.push(entry);
        void active(question).then(
          (answer) => entry.settle(answer),
          // Treat a failed UI handler like a dismissed question.
          () => entry.settle(null),
        );
      });
    },

    attach: (next) => {
      handler = next;
      return () => {
        // A newer attachment may already own the channel.
        if (handler === next) handler = null;
        const settling = pending.filter((entry) => entry.owner === next);
        pending = pending.filter((entry) => entry.owner !== next);
        for (const entry of settling) entry.settle(null);
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

export const ASK_DECLINED = "The user dismissed the question without answering.";

export function parseAskResult(content: string): { question: string; answer: string } | null {
  const match = /^Asked: ([^\n]*)\nAnswer: ([\s\S]*)$/.exec(content);
  if (!match) return null;
  return { question: match[1]!, answer: match[2]! };
}
