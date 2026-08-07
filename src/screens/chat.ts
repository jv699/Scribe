/**
 * Chat screen: a scrollable transcript with an opencode-style prompt at the
 * bottom — an accent-bordered panel holding a multi-line textarea (Enter
 * sends, Shift+Enter adds a line) and a hint footer. User messages each render
 * in their own accent-strip panel (the same treatment as the prompt box) while
 * assistant replies flow as markdown beneath them. Streams assistant replies
 * from any ChatProvider; a status line with a rolling-die spinner shows
 * "Scribe is thinking…", running-tool activity, and provider errors.
 * Supports two modes: the agent loop with tools (planning/report, and
 * Drafting Table when it has tools), and plain streaming as the fallback
 * when an agent has no tools (the system prompt, if set, is prepended).
 *
 * When given an `AskChannel`, the screen also answers the `ask_user` tool: the
 * question replaces the prompt box until the user picks, the agent turn blocks
 * on it, and the settled exchange stays in the transcript as a compact Q&A row.
 */
import {
  BoxRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { createMarkdownSyntaxStyle } from "../markdown-style.ts";
import { makeAccentPanel } from "../components/ui.ts";
import { makePrompt } from "../components/prompt.ts";
import { makeActionDialog } from "../components/action-dialog.ts";
import { makeAskWidget, type AskWidget } from "../components/ask-widget.ts";
import { makeAutocomplete, type CompletionSource } from "../components/autocomplete.ts";
import { DiceSpinnerRenderable } from "../components/dice-spinner.ts";
import { runAgent, type AgentTool } from "../agent/loop.ts";
import {
  ASK_USER_TOOL_NAME,
  parseAskResult,
  type AskAnswer,
  type AskChannel,
  type AskQuestion,
} from "../agent/ask.ts";
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
  /** Left of the title bar. Defaults to "Drafting Table". */
  title?: string;
  /**
   * When non-empty, sends go through the agent loop with these tools and this
   * base system prompt (planning/report, and Drafting Table when it has tools).
   * When omitted *or empty*, plain text streaming only — if `systemPrompt` is
   * still set, it is prepended to the conversation as a system message.
   */
  systemPrompt?: string;
  tools?: AgentTool[];
  /** When set, the conversation is loaded and saved back here across sessions. */
  chatLog?: ChatLogStore;
  /**
   * When set, this screen answers the `ask_user` tool: a question replaces the
   * prompt box until the user picks. The same channel must have been passed in
   * the `ToolContext` used to build `tools`, or the tool will have declined.
   */
  ask?: AskChannel;
  /**
   * Extra completion sources for the prompt popup — in practice the `@`
   * mentions, whose contents come from the campaign. Supplied by the caller so
   * this screen stays ignorant of the store; the `/` commands below are
   * built in because they act on the chat itself.
   */
  completions?: CompletionSource[];
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
  titleRow.add(new TextRenderable(renderer, { content: options.title ?? "Drafting Table", fg: theme.accent }));
  if (options.model) {
    titleRow.add(new TextRenderable(renderer, { content: options.model, fg: theme.textMuted }));
  }
  container.add(titleRow);

  // Transcript: user messages each get their own accent-strip panel (mirroring
  // the prompt box); assistant replies flow as markdown beneath them. The shared
  // SyntaxStyle themes every markdown block with Scribe's palette.
  const syntaxStyle = createMarkdownSyntaxStyle();
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
    paddingRight: "1%"
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
  /**
   * Set by `dispose`. An agent turn outlives the screen — the user can leave
   * while the model is still streaming, or while a question sits unanswered —
   * and everything the turn would otherwise touch on the way out (the syntax
   * style, the transcript, the status line) is gone by then.
   */
  let disposed = false;

  /** A rendered transcript row; updated in place as its message streams in. */
  interface TranscriptRow {
    msg: ChatMessage;
    node: BoxRenderable;
    update: () => void;
  }

  const rows: TranscriptRow[] = [];

  /**
   * Ids of the tool calls that were `ask_user`, so their results can be told
   * apart from every other tool message. Derived from the `tool_calls` already
   * on the assistant messages rather than stamped onto the tool message: that
   * keeps `ChatMessage` (and the JSONL log, and what goes over the wire)
   * untouched, and makes resumed conversations render with no migration.
   */
  function askCallIds(): Set<string> {
    const ids = new Set<string>();
    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.tool_calls) continue;
      for (const call of msg.tool_calls) {
        if (call.function.name === ASK_USER_TOOL_NAME) ids.add(call.id);
      }
    }
    return ids;
  }

  /**
   * The rows worth showing: user/assistant prose, plus answered questions.
   * A dismissed question has no parseable answer and is left out — a skipped
   * fork isn't part of the story.
   */
  function visibleMessages(): ChatMessage[] {
    const askIds = askCallIds();
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
      syntaxStyle,
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
      const { node, panel } = makeAccentPanel(renderer);
      panel.add(md);
      return { msg, node, update };
    }
    const node = new BoxRenderable(renderer, { width: "100%", flexShrink: 0, marginTop: 1 });
    node.add(md);
    return { msg, node, update };
  }

  /**
   * A settled `ask_user` exchange: the question, dimmed, and the answer in
   * accent. Plain text rather than markdown — this is a record of a decision,
   * not model prose, and it should read as a quieter aside than either speaker.
   * A muted left rule distinguishes it from the accent strip on user messages.
   */
  function makeAskRow(msg: ChatMessage): TranscriptRow {
    const parsed = parseAskResult(msg.content);
    const node = new BoxRenderable(renderer, {
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
    node.add(body);
    // Content is final once the tool returned, so there is nothing to update.
    return { msg, node, update: () => {} };
  }

  function removeRow(index: number): void {
    const row = rows[index]!;
    transcriptBox.remove(row.node);
    row.node.destroyRecursively();
    rows.splice(index, 1);
  }

  /** Line the transcript up with `messages`, reusing rows for surviving messages. */
  function render(): void {
    // Building a row needs the SyntaxStyle, which dispose() destroys. A turn
    // still streaming after the user left must not paint into a dead tree.
    if (disposed) return;
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
  }

  // Resume: seed the transcript with any saved conversation.
  if (options.chatLog) {
    messages.push(...(await options.chatLog.load()));
    render();
  }

  const THINKING_TEXT = "Scribe is thinking…";
  const WAITING_TEXT = "Scribe is waiting for your answer…";
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

  // --- ask_user: a question takes the prompt box's place ---

  let askWidget: AskWidget | null = null;

  /**
   * Show a question and resolve with the answer. The prompt is hidden rather
   * than disabled — `visible = false` sets the Yoga display to none, so it
   * collapses out of the layout and blurs, and the question lands in exactly
   * the spot the user was about to type in.
   */
  function presentQuestion(question: AskQuestion): Promise<AskAnswer | null> {
    return new Promise<AskAnswer | null>((resolve) => {
      let settled = false;
      const finish = (answer: AskAnswer | null): void => {
        // Guard against a double settle: a click and a keypress can both land
        // before the widget is torn down.
        if (settled) return;
        settled = true;
        closeQuestion();
        resolve(answer);
      };

      const widget = makeAskWidget(renderer, {
        question,
        onSubmit: finish,
        onCancel: () => finish(null),
      });
      askWidget = widget;

      // It isn't thinking, it's blocked on the user — stop the die.
      stopThinkingNow();
      status.fg = theme.textMuted;
      status.content = WAITING_TEXT;

      prompt.node.visible = false;
      // Appending is enough: the hidden prompt takes up no space, so the
      // widget lands at the bottom where the prompt was.
      container.add(widget.node);
      widget.focus();
    });
  }

  function closeQuestion(): void {
    const widget = askWidget;
    if (!widget) return;
    askWidget = null;
    container.remove(widget.node);
    widget.node.destroyRecursively();
    prompt.node.visible = true;
    if (disposed) return;
    // The answer still has to go back to the model, so the turn continues.
    prompt.input.focus();
    startThinking();
  }

  const detachAsk = options.ask?.attach(presentQuestion);

  // --- slash commands and the completion popup ---

  /** True while the clear-confirmation dialog owns the keyboard. */
  let modalOpen = false;

  function leave(): void {
    dispose();
    options.onBack();
  }

  function clearConversation(): void {
    messages.length = 0;
    render();
    // Persist the empty log so the conversation is gone on the next visit too,
    // not just in this session.
    if (options.chatLog) void options.chatLog.save(messages);
  }

  function confirmClear(): void {
    // Wiping the history the agent is mid-way through reasoning over would
    // leave the turn talking about messages that no longer exist.
    if (busy) {
      status.fg = theme.textMuted;
      status.content = "Can't clear while Scribe is working — wait for the reply.";
      return;
    }
    modalOpen = true;
    const dialog = makeActionDialog(renderer, {
      width: 54,
      onClose: () => {
        modalOpen = false;
        prompt.input.focus();
      },
    });
    dialog.content.add(new TextRenderable(renderer, { content: "Clear this conversation?", fg: theme.text }));
    dialog.content.add(
      new TextRenderable(renderer, {
        content: "The saved history is deleted. This can't be undone.",
        fg: theme.textMuted,
        marginBottom: 1,
      }),
    );
    // Cancel first, so the safe choice is the one already focused.
    dialog.addButton("Cancel", "ghost", () => dialog.close());
    dialog.addButton("Clear", "primary", () => {
      clearConversation();
      dialog.close();
    });
  }

  /** Commands that act on the chat, not the message — never sent to the model. */
  const commands = [
    { name: "clear", description: "Start this conversation over", run: confirmClear },
    { name: "back", description: "Leave the chat", run: leave },
  ];

  const slashCommands: CompletionSource = {
    trigger: "/",
    // A slash mid-sentence is a date or a fraction, not a command.
    atStartOnly: true,
    items: (query) => {
      const needle = query.toLowerCase();
      return commands
        .filter((command) => command.name.startsWith(needle))
        .map((command) => ({
          label: `/${command.name}`,
          description: command.description,
          run: command.run,
        }));
    },
  };

  const autocomplete = makeAutocomplete(renderer, {
    input: prompt.input,
    anchor: prompt.node,
    sources: [slashCommands, ...(options.completions ?? [])],
  });

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
      if (options.tools && options.tools.length > 0) {
        // Planning mode: run the agent loop (system prompt + tools). The
        // pending assistant message is for streaming display only —
        // runAgent manages its own conversation copy.
        //
        // Length-checked, not just truthy: an agent granted no tools (see
        // AGENTS in agent/agents.ts) resolves to [], which must take the
        // cheaper plain-streaming path rather than a tool-less agent loop.
        const result = await runAgent(
          {
            provider: options.provider,
            ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
            tools: options.tools,
            onText: (delta) => appendStreamed(delta),
            onTool: (name) => {
              // ask_user drives the status line itself ("waiting for your
              // answer"); announcing it as a running tool would flash past and
              // then be wrong for as long as the question is up.
              if (name === ASK_USER_TOOL_NAME) return;
              status.content = `running tool: ${name}…`;
            },
          },
          messages.slice(0, -1),
        );
        // Keep the full conversation (minus the system message) for context.
        messages.splice(0, messages.length, ...result.messages.filter((m) => m.role !== "system"));
      } else {
        // No tools (agent declined or has none): plain text streaming. Prepend the
        // system prompt (if any) to a local copy so it never pollutes the transcript/log.
        const context: ChatMessage[] =
          options.systemPrompt && options.systemPrompt.trim() !== ""
            ? [{ role: "system", content: options.systemPrompt }, ...messages]
            : messages;
        for await (const event of options.provider.streamChat(context)) {
          if (event.type === "text") appendStreamed(event.delta);
        }
      }
      if (!disposed) status.content = "";
    } catch (err) {
      if (disposed) return;
      stopThinkingNow();
      status.fg = theme.danger;
      status.content = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busy = false;
      // The user may have left while this turn was in flight. dispose() has
      // already stopped the spinner and saved, and the transcript is gone.
      if (!disposed) {
        stopThinkingNow();
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
  }

  const onKeypress = (key: KeyEvent): void => {
    // The confirm dialog registered its own listener after ours, so bow out
    // without consuming anything and let it handle Escape and Tab.
    if (modalOpen) return;

    // A question owns the keyboard while it is up. In particular Escape
    // dismisses the question instead of leaving the chat — walking out
    // mid-question would strand the turn. Keys the widget doesn't claim are
    // left alone (not preventDefault'd), so its answer textarea still types.
    if (askWidget) {
      askWidget.handleKey(key);
      return;
    }

    // Then the completion popup, so while it is open Enter picks rather than
    // sends and Escape closes the list rather than the screen.
    if (autocomplete.handleKey(key)) return;

    if (key.name === "escape") {
      key.preventDefault();
      leave();
      return;
    }
  };
  renderer.keyInput.on("keypress", onKeypress);

  let disposeRan = false;
  function dispose(): void {
    // `/back` and Escape both route here, and index.ts disposes screens on
    // navigation, so this can be reached twice for one departure.
    if (disposeRan) return;
    disposeRan = true;
    disposed = true;
    // Detach first: this settles any question still on screen with "declined",
    // so an in-flight runAgent can finish instead of awaiting forever.
    detachAsk?.();
    autocomplete.dispose();
    thinkingSpinner.stop();
    renderer.keyInput.off("keypress", onKeypress);
    syntaxStyle.destroy();
    if (options.chatLog && messages.length > 0) {
      void options.chatLog.save(messages);
    }
  }

  return { node: container, focus: () => prompt.input.focus(), dispose };
}
