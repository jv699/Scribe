import {
  BoxRenderable,
  MarkdownRenderable,
  TextRenderable,
  type CliRenderer,
  type SyntaxStyle,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { formatDuration } from "../format.ts";
import { makeAccentPanel } from "./ui.ts";
import { makeShimmerText, type ShimmerText } from "./shimmer-text.ts";
import { ASK_USER_TOOL_NAME, parseAskResult } from "../agent/ask.ts";
import type { ChatMessage } from "../provider/types.ts";

export interface TranscriptOptions {
  /** Shared markdown theme. The caller owns it, including destroying it. */
  syntaxStyle: SyntaxStyle;
}

export interface TranscriptActivity {
  finish(): void;
}

export interface Transcript {
  node: BoxRenderable;
  sync(messages: readonly ChatMessage[]): void;
  /** Groups consecutive activities until a message or notice arrives. UI-only. */
  beginActivity(present: string, past: string): TranscriptActivity;
  addNotice(text: string, tone?: "muted" | "danger"): void;
  reset(): void;
}

// sync reconciles messages but leaves pinned rows in place.
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
  const liveShimmers = new Set<ShimmerText>();

  let openGroup: BoxRenderable | null = null;

  // Derive ask_user results from call IDs without changing the wire/log format.
  // Cache by message count because streaming deltas only change final content.
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
   * Empty assistant messages must stay hidden: `runAgent` announces them before
   * opening activity rows, and rendering one would split each activity block.
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
      // Keep this on: disabling it waits for async highlighting and briefly blanks rows.
      streaming: true,
    });
    const update = (): void => {
      md.content = msg.content;
    };
    if (msg.role === "user") {
      const { node: panelNode, panel } = makeAccentPanel(renderer);
      panel.add(md);
      return { kind: "message", msg, node: panelNode, update };
    }
    const rowNode = new BoxRenderable(renderer, { width: "100%", flexShrink: 0, marginTop: 1 });
    rowNode.add(md);
    return { kind: "message", msg, node: rowNode, update };
  }

  function makeAskEntry(msg: ChatMessage): Entry {
    const parsed = parseAskResult(msg.content);
    const { node: blockNode, body } = makeQuietBlock();
    body.add(new TextRenderable(renderer, { content: parsed?.question ?? "", fg: theme.textMuted }));
    body.add(new TextRenderable(renderer, { content: `→ ${parsed?.answer ?? ""}`, fg: theme.accent }));
    return { kind: "message", msg, node: blockNode, update: () => {} };
  }

  function removeEntry(index: number): void {
    const entry = entries[index]!;
    node.remove(entry.node);
    entry.node.destroyRecursively();
    entries.splice(index, 1);
  }

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
    const shimmer = makeShimmerText(renderer, {
      text: `${present}…`,
      baseColor: theme.textMuted,
      edgeColor: theme.textDim,
      highlightColor: theme.flameCore,
    });
    openGroup.add(shimmer.node);
    liveShimmers.add(shimmer);

    const startedAt = Date.now();
    let settled = false;
    return {
      finish(): void {
        if (settled) return;
        settled = true;
        liveShimmers.delete(shimmer);
        shimmer.stop(`${past} · ${formatDuration(Date.now() - startedAt)}`);
      },
    };
  }

  /** Suppresses duplicate notices only while the matching notice remains last. */
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
    for (const shimmer of liveShimmers) shimmer.stop();
    liveShimmers.clear();
    for (let i = entries.length - 1; i >= 0; i--) removeEntry(i);
  }

  function nextMessageIndex(from: number): number {
    for (let i = from; i < entries.length; i++) {
      if (entries[i]!.kind === "message") return i;
    }
    return entries.length;
  }

  /**
   * Messages append or truncate and the visibility filter preserves order, so
   * surviving rows never need reordering. A previously empty assistant can
   * become visible later, which is why insertion is not always at the tail.
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
      openGroup = null;
      const entry = makeMessageEntry(msg);
      if (slot === entries.length) {
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
