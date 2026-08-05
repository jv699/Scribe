/**
 * Chat screen: a scrollable transcript with an opencode-style prompt at the
 * bottom — an accent-bordered panel holding a multi-line textarea (Enter
 * sends, Shift+Enter adds a line) and a hint footer. User messages each render
 * in their own accent-strip panel (the same treatment as the prompt box) while
 * assistant replies flow as markdown beneath them. Streams assistant replies
 * from any ChatProvider; a status line with a rolling-die spinner shows
 * "Scribe is thinking…", running-tool activity, and provider errors.
 * Supports three modes: plain streaming, plain streaming with a system prompt
 * (The Tome), and the agent loop with tools (planning/report).
 */
import {
  BoxRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { makeAccentPanel } from "../components/ui.ts";
import { makePrompt } from "../components/prompt.ts";
import { DiceSpinnerRenderable } from "../components/dice-spinner.ts";
import { runAgent, type AgentTool } from "../agent/loop.ts";
import type { ChatMessage, ChatProvider } from "../provider/types.ts";
import type { Screen } from "./screen.ts";

/** Persistence seam for resuming a conversation across app sessions. */
export interface ChatLogStore {
  load(): Promise<ChatMessage[]>;
  save(messages: ChatMessage[]): Promise<void>;
}

export interface ChatScreenOptions {
  provider: ChatProvider;
  /** Shown on the right of the title bar. */
  model?: string;
  /** Left of the title bar. Defaults to "The Tome". */
  title?: string;
  /**
   * When set, sends go through the agent loop with these tools and this base
   * system prompt (planning/report mode). When omitted, plain text streaming
   * only — if `systemPrompt` is still set (The Tome), it is prepended to the
   * conversation as a system message.
   */
  systemPrompt?: string;
  tools?: AgentTool[];
  /** When set, the conversation is loaded and saved back here across sessions. */
  chatLog?: ChatLogStore;
  onBack: () => void;
}

export async function makeChatScreen(renderer: CliRenderer, options: ChatScreenOptions): Promise<Screen> {
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    padding: 1,
    flexDirection: "column",
  });

  // Title bar: Chat (test) on the left, model on the right.
  const titleRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    marginBottom: 1,
  });
  titleRow.add(new TextRenderable(renderer, { content: options.title ?? "The Tome", fg: theme.accent }));
  if (options.model) {
    titleRow.add(new TextRenderable(renderer, { content: options.model, fg: theme.textMuted }));
  }
  container.add(titleRow);

  // Transcript: user messages each get their own accent-strip panel (mirroring
  // the prompt box); assistant replies flow as plain markdown beneath them.
  const syntaxStyle = SyntaxStyle.create();
  const scrollBox = new ScrollBoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
  });
  const transcriptBox = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "column",
  });
  scrollBox.content.add(transcriptBox);
  container.add(scrollBox);

  // Status line: die + text for thinking / tool activity / errors.
  const statusRow = new BoxRenderable(renderer, {
    width: "100%",
    height: 1,
    paddingLeft: 2,
    flexDirection: "row",
    alignItems: "center",
  });
  const thinkingSpinner = new DiceSpinnerRenderable(renderer, { marginRight: 1 });
  const status = new TextRenderable(renderer, { content: "", fg: theme.textMuted, height: 1 });
  statusRow.add(thinkingSpinner);
  statusRow.add(status);
  container.add(statusRow);


  // Prompt panel (opencode-style): bordered textarea + hint footer.
  const prompt = makePrompt(renderer, { onSubmit: () => void send() });
  container.add(prompt.node);

  const messages: ChatMessage[] = [];
  let busy = false;

  /** A rendered transcript row; updated in place as its message streams in. */
  interface TranscriptRow {
    msg: ChatMessage;
    node: BoxRenderable;
    markdown: MarkdownRenderable;
    update: () => void;
  }

  const rows: TranscriptRow[] = [];

  const visibleMessages = (): ChatMessage[] =>
    messages.filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim() !== "");

  function makeRow(msg: ChatMessage): TranscriptRow {
    const md = new MarkdownRenderable(renderer, { content: msg.content, width: "100%", syntaxStyle });
    const update = (): void => {
      md.content = msg.content;
    };
    if (msg.role === "user") {
      // Same accent-strip treatment as the prompt box.
      const { node, panel } = makeAccentPanel(renderer);
      panel.add(md);
      return { msg, node, markdown: md, update };
    }
    const node = new BoxRenderable(renderer, { width: "100%", flexShrink: 0, marginTop: 1 });
    node.add(md);
    return { msg, node, markdown: md, update };
  }

  function removeRow(index: number): void {
    const row = rows[index]!;
    transcriptBox.remove(row.node.id);
    row.node.destroyRecursively();
    rows.splice(index, 1);
  }

  /** Line the transcript up with `messages`, reusing rows for surviving messages. */
  function render(): void {
    const visible = visibleMessages();
    const alive = new Set(visible);

    for (let i = rows.length - 1; i >= 0; i--) {
      if (!alive.has(rows[i]!.msg)) removeRow(i);
    }

    let cursor = 0;
    for (const msg of visible) {
      // Search manually from cursor (findIndex's 2nd arg is thisArg, not fromIndex).
      let match = -1;
      for (let i = cursor; i < rows.length; i++) {
        if (rows[i]!.msg === msg) {
          match = i;
          break;
        }
      }
      if (match === cursor) {
        cursor++;
        continue;
      }
      const row = match > cursor ? rows.splice(match, 1)[0]! : makeRow(msg);
      rows.splice(cursor, 0, row);
      transcriptBox.insertBefore(row.node, rows[cursor + 1]?.node);
      cursor++;
    }

    for (const row of rows) row.update();

    // Only a trailing assistant reply blinks a streaming cursor while busy.
    for (const row of rows) row.markdown.streaming = false;
    const last = rows[rows.length - 1];
    if (busy && last?.msg.role === "assistant") last.markdown.streaming = true;
  }

  // Resume: seed the transcript with any saved conversation.
  if (options.chatLog) {
    messages.push(...(await options.chatLog.load()));
    render();
  }

  const THINKING_TEXT = "Scribe is thinking…";
  let thinking = false;

  /** Start the status-line spinner while waiting on the model. */
  function startThinking(): void {
    thinking = true;
    thinkingSpinner.start();
    status.fg = theme.textMuted;
    status.content = THINKING_TEXT;
  }

  /** Stop the spinner, clearing the status line it was driving. */
  function stopThinkingNow(): void {
    if (!thinking) return;
    thinking = false;
    thinkingSpinner.stop();
    status.content = "";
  }

  /** Append a streamed delta to the pending assistant message. */
  function appendStreamed(delta: string): void {
    stopThinkingNow();
    messages[messages.length - 1]!.content += delta;
    render();
  }

  async function send(): Promise<void> {
    const text = prompt.input.plainText.trim();
    if (text === "" || busy) return;
    prompt.input.clear();
    messages.push({ role: "user", content: text });
    messages.push({ role: "assistant", content: "" });
    busy = true;
    status.fg = theme.textMuted;
    status.content = "";
    startThinking();
    render();

    try {
      if (options.tools) {
        // Planning mode: run the agent loop (system prompt + tools). The
        // pending assistant message is for streaming display only —
        // runAgent manages its own conversation copy.
        const result = await runAgent(
          {
            provider: options.provider,
            ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
            tools: options.tools,
            onText: (delta) => appendStreamed(delta),
            onTool: (name) => {
              status.content = `running tool: ${name}…`;
            },
          },
          messages.slice(0, -1),
        );
        // Keep the full conversation (minus the system message) for context.
        messages.splice(0, messages.length, ...result.messages.filter((m) => m.role !== "system"));
      } else {
        // Scratch / The Tome: plain text streaming. Prepend the system prompt
        // (if any) to a local copy so it never pollutes the transcript/log.
        const context: ChatMessage[] =
          options.systemPrompt && options.systemPrompt.trim() !== ""
            ? [{ role: "system", content: options.systemPrompt }, ...messages]
            : messages;
        for await (const event of options.provider.streamChat(context)) {
          if (event.type === "text") appendStreamed(event.delta);
        }
      }
      status.content = "";
    } catch (err) {
      stopThinkingNow();
      status.fg = theme.danger;
      status.content = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      stopThinkingNow();
      busy = false;
      render();
      if (options.chatLog) {
        try {
          await options.chatLog.save(messages);
        } catch {
          // Persisting history must not break the turn.
        }
      }
    }
  }

  const onKeypress = (key: KeyEvent): void => {
    if (key.name === "escape") {
      key.preventDefault();
      dispose();
      options.onBack();
      return;
    }
  };
  renderer.keyInput.on("keypress", onKeypress);

  function dispose(): void {
    thinkingSpinner.stop();
    renderer.keyInput.off("keypress", onKeypress);
    syntaxStyle.destroy();
    if (options.chatLog && messages.length > 0) {
      void options.chatLog.save(messages);
    }
  }

  return { node: container, focus: () => prompt.input.focus(), dispose };
}
