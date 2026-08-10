/**
 * The chat transcript: a column of rows kept in step with a `ChatMessage[]`.
 *
 * User messages render in their own accent-strip panel (the same treatment as
 * the prompt box), assistant replies flow as markdown beneath them, and settled
 * `ask_user` exchanges appear as a compact, quieter Q&A aside. `sync` reuses
 * the rows of surviving messages so a streaming reply repaints in place rather
 * than rebuilding the whole transcript on every delta.
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
import { ASK_USER_TOOL_NAME, parseAskResult } from "../agent/ask.ts";
import type { ChatMessage } from "../provider/types.ts";

export interface TranscriptOptions {
  /** Shared markdown theme. The caller owns it, including destroying it. */
  syntaxStyle: SyntaxStyle;
}

export interface Transcript {
  /** The column of rows — add this to the scroll box's content. */
  node: BoxRenderable;
  /** Line the rendered rows up with `messages`, reusing surviving rows. */
  sync(messages: readonly ChatMessage[]): void;
}

/** A rendered transcript row; updated in place as its message streams in. */
interface TranscriptRow {
  msg: ChatMessage;
  node: BoxRenderable;
  update: () => void;
}

export function makeTranscript(renderer: CliRenderer, options: TranscriptOptions): Transcript {
  const node = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "column",
    paddingRight: "1%",
  });
  const rows: TranscriptRow[] = [];

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

  function makeRow(msg: ChatMessage): TranscriptRow {
    if (msg.role === "tool") return makeAskRow(msg);

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
      return { msg, node: panelNode, update };
    }
    const rowNode = new BoxRenderable(renderer, { width: "100%", flexShrink: 0, marginTop: 1 });
    rowNode.add(md);
    return { msg, node: rowNode, update };
  }

  /**
   * A settled `ask_user` exchange: the question, dimmed, and the answer in
   * accent. Plain text rather than markdown — this is a record of a decision,
   * not model prose, and it should read as a quieter aside than either speaker.
   * A muted left rule distinguishes it from the accent strip on user messages.
   */
  function makeAskRow(msg: ChatMessage): TranscriptRow {
    const parsed = parseAskResult(msg.content);
    const rowNode = new BoxRenderable(renderer, {
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
    body.add(new TextRenderable(renderer, { content: parsed?.question ?? "", fg: theme.textMuted }));
    body.add(new TextRenderable(renderer, { content: `→ ${parsed?.answer ?? ""}`, fg: theme.accent }));
    rowNode.add(body);
    // Content is final once the tool returned, so there is nothing to update.
    return { msg, node: rowNode, update: () => {} };
  }

  function removeRow(index: number): void {
    const row = rows[index]!;
    node.remove(row.node);
    row.node.destroyRecursively();
    rows.splice(index, 1);
  }

  /** Index of `msg` in `rows` at or after `from`, or -1. */
  function rowIndexFrom(msg: ChatMessage, from: number): number {
    for (let i = from; i < rows.length; i++) {
      if (rows[i]!.msg === msg) return i;
    }
    return -1;
  }

  function sync(messages: readonly ChatMessage[]): void {
    const visible = visibleMessages(messages);
    const alive = new Set(visible);

    for (let i = rows.length - 1; i >= 0; i--) {
      if (!alive.has(rows[i]!.msg)) removeRow(i);
    }

    let cursor = 0;
    for (const msg of visible) {
      const match = rowIndexFrom(msg, cursor);
      if (match === cursor) {
        cursor++;
        continue;
      }
      const row = match > cursor ? rows.splice(match, 1)[0]! : makeRow(msg);
      rows.splice(cursor, 0, row);
      node.insertBefore(row.node, rows[cursor + 1]?.node);
      cursor++;
    }

    for (const row of rows) row.update();
  }

  return { node, sync };
}
