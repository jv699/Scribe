/**
 * The chat transcript: a column of rows kept in step with a `ChatMessage[]`,
 * interleaved with rows the screen pins there directly.
 *
 * User messages render in their own accent-strip panel (the same treatment as
 * the prompt box), assistant replies flow as markdown beneath them, and settled
 * `ask_user` exchanges appear as a compact, quieter Q&A aside. `sync` reuses
 * the rows of surviving messages so a streaming reply repaints in place rather
 * than rebuilding the whole transcript on every delta.
 *
 * Alongside those, the screen pins **activity rows** — "Scribe is thinking…"
 * settling into "Thought · 4.3s", one per tool call — and one-off **notices**
 * (errors, refusals). Both are UI-only: they never become `ChatMessage`s, so
 * nothing reaches the model or the saved log, and a resumed conversation shows
 * the prose without them.
 */
import {
  BoxRenderable,
  MarkdownRenderable,
  TextRenderable,
  type CliRenderer,
  type SyntaxStyle,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { makeAccentPanel } from "./ui.ts";
import { makeActivityRow, type ActivityRow } from "./activity-row.ts";
import { ASK_USER_TOOL_NAME, parseAskResult } from "../agent/ask.ts";
import type { ChatMessage } from "../provider/types.ts";

export interface TranscriptOptions {
  /** Shared markdown theme. The caller owns it, including destroying it. */
  syntaxStyle: SyntaxStyle;
}

/** A live activity row, until it is settled. */
export interface TranscriptActivity {
  /** Flip the row to its past-tense label and the time it took. Idempotent. */
  finish(): void;
}

export interface Transcript {
  /** The column of rows — add this to the scroll box's content. */
  node: BoxRenderable;
  /** Line the rendered rows up with `messages`, reusing surviving rows. */
  sync(messages: readonly ChatMessage[]): void;
  /**
   * Open a live activity row at the end of the transcript. Consecutive
   * activities stack into one block; the first message row (or notice) that
   * lands after them closes it, so the next one starts a fresh block.
   */
  beginActivity(present: string, past: string): TranscriptActivity;
  /** A standalone dimmed line — errors and refusals, which have no message of their own. */
  addNotice(text: string, tone?: "muted" | "danger"): void;
  /** Drop every row, pinned ones included. */
  reset(): void;
}

/**
 * A rendered row. Message rows are reconciled against the conversation by
 * `sync`; pinned rows are owned by the caller and left where they were put.
 */
type Entry =
  | { kind: "message"; msg: ChatMessage; node: BoxRenderable; update: () => void }
  | { kind: "pinned"; node: BoxRenderable };

export function makeTranscript(renderer: CliRenderer, options: TranscriptOptions): Transcript {
  const node = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "column",
    paddingRight: "1%",
  });
  const entries: Entry[] = [];
  const liveActivities = new Set<ActivityRow>();

  /**
   * The activity block still accepting rows, if any. Cleared whenever anything
   * else joins the transcript, which is what turns a run of activities into one
   * block and starts a new block after the prose it produced.
   */
  let openGroup: BoxRenderable | null = null;

  /**
   * Ids of the tool calls that were `ask_user`, so their results can be told
   * apart from every other tool message. Derived from the `tool_calls` already
   * on the assistant messages rather than stamped onto the tool message: that
   * keeps `ChatMessage` (and the JSONL log, and what goes over the wire)
   * untouched, and makes resumed conversations render with no migration.
   *
   * Cached against the message count because `sync` runs on every streamed
   * delta, and a delta only mutates the last message's `content` — ask ids can
   * appear only alongside new messages, so an unchanged length means an
   * unchanged set.
   */
  let cachedAskIds = new Set<string>();
  let cachedAt = -1;

  function askCallIds(messages: readonly ChatMessage[]): Set<string> {
    if (cachedAt === messages.length) return cachedAskIds;
    const ids = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      for (const call of msg.tool_calls) {
        if (call.function.name === ASK_USER_TOOL_NAME) ids.add(call.id);
      }
    }
    cachedAskIds = ids;
    cachedAt = messages.length;
    return ids;
  }

  /**
   * The rows worth showing: user/assistant prose, plus answered questions.
   * A dismissed question has no parseable answer and is left out — a skipped
   * fork isn't part of the story.
   *
   * The empty-content test is load-bearing for activity ordering, not just
   * tidiness. `runAgent` announces each assistant turn empty and fills it in
   * afterwards, and the screen opens the "thinking" row right then. Because the
   * empty turn is invisible here, no message row is created, so `sync` leaves
   * `openGroup` open and the row joins the block above — where it belongs.
   * Were empty assistants visible, every turn would create a row that closed
   * the block, and each tool call would end up in a block of its own.
   */
  function visibleMessages(messages: readonly ChatMessage[]): ChatMessage[] {
    const askIds = askCallIds(messages);
    return messages.filter((msg) => {
      if (msg.role === "user" || msg.role === "assistant") return msg.content.trim() !== "";
      if (msg.role !== "tool") return false;
      return (
        msg.tool_call_id !== undefined &&
        askIds.has(msg.tool_call_id) &&
        parseAskResult(msg.content) !== null
      );
    });
  }

  /**
   * The quiet aside: a muted left rule over a padded column, one blank line
   * clear of whatever came before. Shared by settled `ask_user` exchanges and
   * activity blocks so the two read as the same kind of remark — quieter than
   * either speaker, and distinct from the accent strip on user messages.
   */
  function makeQuietBlock(): { node: BoxRenderable; body: BoxRenderable } {
    const blockNode = new BoxRenderable(renderer, {
      width: "100%",
      flexShrink: 0,
      marginTop: 1,
      border: ["left"],
      borderColor: theme.textMuted,
    });
    const body = new BoxRenderable(renderer, {
      width: "100%",
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
    });
    blockNode.add(body);
    return { node: blockNode, body };
  }

  function makeMessageEntry(msg: ChatMessage): Entry {
    if (msg.role === "tool") return makeAskEntry(msg);

    const md = new MarkdownRenderable(renderer, {
      content: msg.content,
      width: "100%",
      syntaxStyle: options.syntaxStyle,
      fg: theme.text,
      internalBlockMode: "top-level",
      tableOptions: { style: "grid" },
      // Always streaming, never toggled off. MarkdownRenderable only builds the
      // synchronous "unstyled" first paint (`initialStyledText`) while streaming
      // is on; with it off, every block waits on an async tree-sitter highlight
      // and paints blank for a frame. That shows up as a full-transcript flicker
      // when a reply finishes (true -> false rebuilds every block) and as a blank
      // first frame for rows built from existing content (resume / agent mode).
      // The settled output is identical either way, so we just leave it on.
      streaming: true,
    });
    const update = (): void => {
      md.content = msg.content;
    };
    if (msg.role === "user") {
      // Same accent-strip treatment as the prompt box.
      const { node: panelNode, panel } = makeAccentPanel(renderer);
      panel.add(md);
      return { kind: "message", msg, node: panelNode, update };
    }
    const rowNode = new BoxRenderable(renderer, { width: "100%", flexShrink: 0, marginTop: 1 });
    rowNode.add(md);
    return { kind: "message", msg, node: rowNode, update };
  }

  /**
   * A settled `ask_user` exchange: the question, dimmed, and the answer in
   * accent. Plain text rather than markdown — this is a record of a decision,
   * not model prose, and it should read as a quieter aside than either speaker.
   */
  function makeAskEntry(msg: ChatMessage): Entry {
    const parsed = parseAskResult(msg.content);
    const { node: blockNode, body } = makeQuietBlock();
    body.add(new TextRenderable(renderer, { content: parsed?.question ?? "", fg: theme.textMuted }));
    body.add(new TextRenderable(renderer, { content: `→ ${parsed?.answer ?? ""}`, fg: theme.accent }));
    // Content is final once the tool returned, so there is nothing to update.
    return { kind: "message", msg, node: blockNode, update: () => {} };
  }

  function removeEntry(index: number): void {
    const entry = entries[index]!;
    node.remove(entry.node);
    entry.node.destroyRecursively();
    entries.splice(index, 1);
  }

  /** Append a pinned row at the very end of the transcript. */
  function pin(pinned: BoxRenderable): void {
    entries.push({ kind: "pinned", node: pinned });
    node.add(pinned);
  }

  function beginActivity(present: string, past: string): TranscriptActivity {
    if (!openGroup) {
      const { node: blockNode, body } = makeQuietBlock();
      openGroup = body;
      pin(blockNode);
    }
    const activity = makeActivityRow(renderer, present, past);
    openGroup.add(activity.node);
    liveActivities.add(activity);
    let settled = false;
    return {
      finish(): void {
        if (settled) return;
        settled = true;
        liveActivities.delete(activity);
        activity.finish();
      },
    };
  }

  /**
   * The notice currently at the tail, so an identical one repeated against an
   * unchanged transcript doesn't stack. Hammering `/clear` mid-turn used to
   * leave a column of the same refusal; the old status line simply overwrote
   * itself. The message is still on screen either way — it *is* the tail — so
   * nothing is lost by declining to add it twice. Cleared whenever anything
   * else lands, because by then the notice is answering a different moment.
   */
  let lastNotice: { text: string; node: BoxRenderable } | null = null;

  function addNotice(text: string, tone: "muted" | "danger" = "muted"): void {
    if (lastNotice?.text === text && entries[entries.length - 1]?.node === lastNotice.node) return;
    openGroup = null;
    const { node: blockNode, body } = makeQuietBlock();
    body.add(
      new TextRenderable(renderer, {
        content: text,
        fg: tone === "danger" ? theme.danger : theme.textMuted,
      }),
    );
    pin(blockNode);
    lastNotice = { text, node: blockNode };
  }

  function reset(): void {
    openGroup = null;
    lastNotice = null;
    for (const activity of liveActivities) activity.dispose();
    liveActivities.clear();
    for (let i = entries.length - 1; i >= 0; i--) removeEntry(i);
  }

  /** Index of the first message entry at or after `from`, or `entries.length`. */
  function nextMessageIndex(from: number): number {
    for (let i = from; i < entries.length; i++) {
      if (entries[i]!.kind === "message") return i;
    }
    return entries.length;
  }

  /**
   * Reconcile the message rows against the conversation, leaving pinned rows
   * exactly where they are. New messages land at the very end — after any
   * activity block — which is chronologically right, because a pinned row is
   * only ever appended at the tail too.
   *
   * Surviving message rows never need reordering, so this only ever removes or
   * inserts. `messages` is append-and-truncate only, and `visibleMessages` is an
   * order-preserving filter over it, so once the sweep below has dropped the
   * rows whose messages are gone, the rest already sit in conversation order —
   * a row can only be *missing* from its slot, never behind another one. (A
   * message can still become visible late, when an announced-empty assistant
   * turn gets its first token, so the insert is not always at the tail.)
   */
  function sync(messages: readonly ChatMessage[]): void {
    const visible = visibleMessages(messages);
    const alive = new Set(visible);

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.kind === "message" && !alive.has(entry.msg)) removeEntry(i);
    }

    let cursor = 0;
    for (const msg of visible) {
      const slot = nextMessageIndex(cursor);
      const held = entries[slot];
      if (held?.kind === "message" && held.msg === msg) {
        cursor = slot + 1;
        continue;
      }
      // Prose has arrived, so the run of activity rows above it is over.
      openGroup = null;
      const entry = makeMessageEntry(msg);
      if (slot === entries.length) {
        // The common case: a new message at the end of the conversation.
        entries.push(entry);
        node.add(entry.node);
      } else {
        entries.splice(slot, 0, entry);
        node.insertBefore(entry.node, entries[slot + 1]?.node);
      }
      cursor = slot + 1;
    }

    for (const entry of entries) {
      if (entry.kind === "message") entry.update();
    }
  }

  return { node, sync, beginActivity, addNotice, reset };
}
