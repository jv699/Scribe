import {
  BoxRenderable,
  RenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { createMarkdownSyntaxStyle } from "../markdown-style.ts";
import { makeTranscript, type TranscriptActivity } from "../components/transcript.ts";
import { makePrompt } from "../components/prompt.ts";
import { showConfirmDialog } from "../components/confirm-dialog.ts";
import { makeAskWidget, type AskWidget } from "../components/ask-widget.ts";
import { makeAutocomplete, type CompletionSource } from "../components/autocomplete.ts";
import { runAgent, type AgentTool } from "../agent/loop.ts";
import { toolLabel, toolPastLabel } from "../agent/tools/index.ts";
import {
  ASK_USER_TOOL_NAME,
  type AskAnswer,
  type AskChannel,
  type AskQuestion,
} from "../agent/ask.ts";
import type { ChatMessage, ChatProvider, ModelInfo, UsageInfo } from "../provider/types.ts";
import { formatDollars, formatTokenCount } from "../format.ts";
import type { Screen } from "./screen.ts";

const DOUBLE_PRESS_MS = 750;
const QUIT_HINT = "Press Ctrl+C again to quit";
const BACK_HINT = "Press Escape again to go back";
/** Narrower than this, the model name is a stub not worth showing. */
const MIN_MODEL_WIDTH = 16;

export interface ChatLogStore {
  load(): Promise<ChatMessage[]>;
  save(messages: ChatMessage[]): Promise<void>;
}

export type ChatState = "idle" | "working" | "awaiting-answer";

export interface ChatTurnContext {
  systemPrompt?: string;
  tools?: AgentTool[];
}

/** What a slash command can do to the chat it runs in. */
export interface ChatCommandContext {
  /** Submit `text` as a user turn, as if typed. */
  send(text: string): void;
  notice(text: string, tone?: "muted" | "danger"): void;
  /** Whether the conversation has anything in it yet. */
  hasMessages(): boolean;
}

export interface ChatCommand {
  name: string;
  description: string;
  /** Run even while a turn is in flight; otherwise the command is refused. */
  whileBusy?: boolean;
  run(chat: ChatCommandContext): void | Promise<void>;
}

export interface ChatScreenOptions {
  provider: ChatProvider;
  /** Shown on the right of the title bar. */
  model?: string;
  /** Updates the header when metadata arrives; undefined keeps the model ID. */
  modelInfo?: Promise<ModelInfo | undefined>;
  /** Left of the title bar. Defaults to "Drafting Table". */
  title?: string;
  /** Shown in place of the transcript while the conversation is empty. */
  emptyHint?: string;
  systemPrompt?: string;
  /** Non-empty tools enable the agent loop; otherwise use plain streaming. */
  tools?: AgentTool[];
  /** Reload mutable context immediately before each submitted turn. */
  loadTurnContext?: () => Promise<ChatTurnContext>;
  chatLog?: ChatLogStore;
  /** Must be the same channel passed to the tools' ToolContext. */
  ask?: AskChannel;
  /** Added alongside the built-in slash commands. */
  completions?: CompletionSource[];
  /** Screen-specific slash commands, listed after the built-in ones. */
  commands?: ChatCommand[];
  /** Owns global keys when true; defaults to true for standalone chats. */
  isInputActive?: () => boolean;
  /** Notify an embedding owner when the prompt takes focus (including by mouse). */
  onInputFocus?: () => void;
  onStateChange?: (state: ChatState) => void;
  /** Request navigation away from the chat. The owner remains responsible for disposal. */
  onBack: () => void;
}

export interface ChatScreen extends Screen {
  setTitle(title: string): void;
}

export async function makeChatScreen(renderer: CliRenderer, options: ChatScreenOptions): Promise<ChatScreen> {
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    paddingLeft: 1,
    paddingRight: 1,
    paddingBottom: 1,
    flexDirection: "column",
  });

  const titleRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    // OpenTUI doesn't clip box borders at scroll edges. This opaque, fixed-height
    // band covers the bleed across the header and its top padding row.
    height: 2,
    paddingTop: 1,
    paddingBottom: 1,
    backgroundColor: theme.background,
    flexShrink: 0,
    zIndex: 1,
  });
  // The title says where you are, so it keeps its room: the model shrinks
  // first, and steps aside entirely once it would be cut to a stub.
  let titleContent = options.title ?? "Drafting Table";
  let modelContent = options.model ?? "";
  const titleText = new TextRenderable(renderer, {
    content: titleContent,
    fg: theme.accent,
    wrapMode: "none",
    truncate: true,
    flexShrink: 1,
    minWidth: 0,
  });
  titleRow.add(titleText);
  const modelText = new TextRenderable(renderer, {
    content: modelContent,
    fg: theme.textMuted,
    wrapMode: "none",
    truncate: true,
    flexShrink: 1000,
    minWidth: 0,
    marginLeft: 2,
  });
  if (options.model) titleRow.add(modelText);
  container.add(titleRow);

  function fitHeader(): void {
    if (!options.model || titleRow.isDestroyed) return;
    const room = titleRow.width - 2;
    modelText.visible = room >= titleContent.length + Math.min(modelContent.length, MIN_MODEL_WIDTH);
  }
  titleRow.onSizeChange = fitHeader;

  let modelInfo: ModelInfo | undefined;
  let lastUsage: UsageInfo | null = null;
  let cumulativeCost = 0;

  function updateModelHeader(): void {
    if (!options.model) return;
    const parts = [modelInfo?.name ?? options.model];
    if (lastUsage) {
      const contextLength = modelInfo?.contextLength;
      parts.push(
        contextLength
          ? `${formatTokenCount(lastUsage.totalTokens)}/${formatTokenCount(contextLength)} ctx (${Math.min(100, Math.round((lastUsage.totalTokens / contextLength) * 100))}%)`
          : `${formatTokenCount(lastUsage.totalTokens)} tokens`,
      );
      if (cumulativeCost > 0) parts.push(formatDollars(cumulativeCost));
    }
    modelContent = parts.join("  |  ");
    modelText.content = modelContent;
    fitHeader();
  }

  // Estimated cost excludes provider discounts for cached context.
  function recordUsage(usage: UsageInfo): void {
    lastUsage = usage;
    const pricing = modelInfo?.pricing;
    if (pricing?.promptPerToken !== undefined && pricing.completionPerToken !== undefined) {
      cumulativeCost += usage.promptTokens * pricing.promptPerToken + usage.completionTokens * pricing.completionPerToken;
    }
    updateModelHeader();
  }

  const syntaxStyle = createMarkdownSyntaxStyle();
  const scrollBox = new ScrollBoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
  });
  const transcript = makeTranscript(renderer, { syntaxStyle });
  // UI-only, like a notice: it never reaches the model or the log.
  const emptyHint = new TextRenderable(renderer, {
    content: options.emptyHint ?? "",
    fg: theme.textMuted,
    wrapMode: "word",
    marginTop: 1,
    marginBottom: 1,
  });
  emptyHint.visible = options.emptyHint !== undefined;
  scrollBox.content.add(emptyHint);
  scrollBox.content.add(transcript.node);
  container.add(scrollBox);

  const prompt = makePrompt(renderer, { onSubmit: () => void send() });
  if (options.onInputFocus) {
    prompt.input.on(RenderableEvents.FOCUSED, options.onInputFocus);
  }
  // Messages sent mid-turn wait here, then go out together when the turn ends.
  const queueText = new TextRenderable(renderer, { content: "", fg: theme.textMuted, flexShrink: 0 });
  queueText.visible = false;
  container.add(queueText);
  container.add(prompt.node);

  const messages: ChatMessage[] = [];
  let busy = false;
  let queued: string[] = [];
  /** A prompt turn whose text is still in the prompt while its context loads. */
  let preparingPrompt = false;
  // Turns can outlive the screen; guard access to destroyed renderables/styles.
  let disposed = false;

  function setState(state: ChatState): void {
    if (!disposed) options.onStateChange?.(state);
  }
  setState("idle");

  if (options.modelInfo) {
    void options.modelInfo.then((info) => {
      if (disposed) return;
      modelInfo = info;
      updateModelHeader();
    });
  }

  function render(): void {
    if (disposed) return;
    emptyHint.visible = options.emptyHint !== undefined && messages.length === 0;
    transcript.sync(messages);
  }

  if (options.chatLog) {
    messages.push(...(await options.chatLog.load()));
    render();
  }

  function updateQueueStrip(): void {
    if (disposed) return;
    queueText.visible = queued.length > 0;
    if (queued.length === 0) return;
    const first = (queued[0] ?? "").split("\n")[0] ?? "";
    const more = queued.length > 1 ? ` (+${queued.length - 1} more)` : "";
    // Up belongs to an open question, so only offer it when the prompt is showing.
    queueText.content = `Queued: ${first}${more}${askWidget ? "" : " · ↑ to edit"}`;
  }

  /** Empty the queue, returning its messages merged into one, or null if it was empty. */
  function takeQueue(): string | null {
    if (queued.length === 0) return null;
    const text = queued.join("\n\n");
    queued = [];
    updateQueueStrip();
    return text;
  }

  /**
   * Hand text back to the prompt alongside any draft there: ahead of it by
   * default (queued text was typed first), after it when the draft is older.
   */
  function restoreToPrompt(text: string, draftFirst = false): void {
    if (disposed) return;
    const draft = prompt.input.plainText.trim();
    const restored = draft === "" ? text : draftFirst ? `${draft}\n\n${text}` : `${text}\n\n${draft}`;
    prompt.input.setText(restored);
    prompt.input.cursorOffset = restored.length;
    if (!options.isInputActive || options.isInputActive()) prompt.input.focus();
  }

  let live: TranscriptActivity | null = null;

  function beginActivity(present: string, past: string): void {
    if (disposed) return;
    live?.finish();
    live = transcript.beginActivity(present, past);
  }

  function endActivity(): void {
    live?.finish();
    live = null;
  }

  function beginThinking(): void {
    beginActivity("Scribe is thinking", "Thought");
  }

  function appendStreamed(delta: string): void {
    endActivity();
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && !last.tool_calls) last.content += delta;
    else messages.push({ role: "assistant", content: delta });
    render();
  }

  /** Remove only the placeholder for a model turn that failed before producing anything. */
  function dropUnfinishedAssistant(): void {
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && last.content === "" && !last.tool_calls?.length) messages.pop();
  }

  let askWidget: AskWidget | null = null;

  function presentQuestion(question: AskQuestion): Promise<AskAnswer | null> {
    return new Promise<AskAnswer | null>((resolve) => {
      let settled = false;
      const finish = (answer: AskAnswer | null): void => {
        // A click and keypress can both arrive before teardown.
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
      updateQueueStrip();

      setState("awaiting-answer");

      endActivity();

      prompt.node.visible = false;
      // Blur the hidden textarea to remove its terminal cursor.
      prompt.input.blur();
      // A hidden prompt takes no layout space, so the question fills its slot.
      container.add(widget.node);
      if (!options.isInputActive || options.isInputActive()) widget.focus();
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
    updateQueueStrip();
    setState(busy ? "working" : "idle");
    if (!options.isInputActive || options.isInputActive()) prompt.input.focus();
  }

  const detachAsk = options.ask?.attach(presentQuestion);

  /** True while the clear-confirmation dialog owns the keyboard. */
  let modalOpen = false;

  let pendingShortcut: "quit" | "back" | null = null;
  let shortcutDeadline = 0;
  let shortcutTimer: ReturnType<typeof setTimeout> | undefined;

  function disarmShortcut(): void {
    pendingShortcut = null;
    shortcutDeadline = 0;
    if (shortcutTimer !== undefined) {
      clearTimeout(shortcutTimer);
      shortcutTimer = undefined;
    }
    prompt.setHint();
  }

  function armShortcut(shortcut: "quit" | "back", hint: string): void {
    disarmShortcut();
    pendingShortcut = shortcut;
    prompt.setHint(hint);
    shortcutDeadline = Date.now() + DOUBLE_PRESS_MS;
    shortcutTimer = setTimeout(() => {
      shortcutTimer = undefined;
      pendingShortcut = null;
      shortcutDeadline = 0;
      if (!disposed) prompt.setHint();
    }, DOUBLE_PRESS_MS);
  }

  function handleInterrupt(): "handled" | "quit" {
    const now = Date.now();
    if (pendingShortcut === "quit" && shortcutDeadline > now) {
      disarmShortcut();
      return "quit";
    }

    // Preserve modal answers and the prompt hidden beneath them.
    if (!askWidget && !modalOpen) prompt.input.clear();
    armShortcut("quit", QUIT_HINT);
    return "handled";
  }

  function handleBack(): void {
    const now = Date.now();
    if (pendingShortcut === "back" && shortcutDeadline > now) {
      disarmShortcut();
      leave();
      return;
    }
    armShortcut("back", BACK_HINT);
  }

  function leave(): void {
    options.onBack();
  }

  function clearConversation(): void {
    messages.length = 0;
    // reset() destroys UI-only activity rows; discard the handle first.
    live = null;
    transcript.reset();
    render();
    if (options.chatLog) void options.chatLog.save(messages);
  }

  function confirmClear(): void {
    modalOpen = true;
    showConfirmDialog(renderer, {
      title: "Clear this conversation?",
      body: "The saved history is deleted. This can't be undone.",
      confirmLabel: "Clear",
      onConfirm: clearConversation,
      onClose: () => {
        modalOpen = false;
        prompt.input.focus();
      },
    });
  }

  const commandContext: ChatCommandContext = {
    send: (text) => {
      // An async command can finish after the user has left.
      if (disposed) return;
      if (busy) refuseBusy("send that");
      else void submit(text, "command");
    },
    notice: (text, tone) => {
      if (!disposed) transcript.addNotice(text, tone);
    },
    hasMessages: () => messages.length > 0,
  };

  function refuseBusy(what: string): void {
    transcript.addNotice(`Can't ${what} while Scribe is working — wait for the reply.`);
  }

  async function runCommand(command: ChatCommand): Promise<void> {
    if (busy && !command.whileBusy) {
      refuseBusy(`run /${command.name}`);
      return;
    }
    try {
      await command.run(commandContext);
    } catch (err) {
      commandContext.notice(`/${command.name} failed: ${err instanceof Error ? err.message : String(err)}`, "danger");
    }
  }

  /**
   * The built-ins act on the chat, not the message, and never reach the model;
   * they live here because every chat has them. Screen commands come in through
   * `options.commands` and may start a turn through their context's `send`.
   */
  const commands: ChatCommand[] = [
    { name: "clear", description: "Start this conversation over", run: confirmClear },
    // An in-flight turn outlives the screen, so leaving mid-turn is safe.
    { name: "back", description: "Leave the chat", whileBusy: true, run: leave },
    ...(options.commands ?? []),
  ];

  const slashCommands: CompletionSource = {
    trigger: "/",
    atStartOnly: true,
    items: (query) => {
      const needle = query.toLowerCase();
      return commands
        .filter((command) => command.name.startsWith(needle))
        .map((command) => ({
          label: `/${command.name}`,
          description: command.description,
          run: () => void runCommand(command),
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
    if (text === "") return;
    // That text is already on its way; a second Enter must not queue a copy.
    if (preparingPrompt) return;
    if (busy) {
      queued.push(text);
      prompt.input.clear();
      updateQueueStrip();
      return;
    }
    await submit(text, "prompt");
  }

  /**
   * Prompt turns clear the prompt once the turn starts; command and queue turns
   * leave any draft alone. A queue turn that can't start goes back to the prompt.
   */
  async function submit(text: string, origin: "prompt" | "command" | "queue"): Promise<void> {
    busy = true;
    preparingPrompt = origin === "prompt";
    setState("working");
    let turnContext: ChatTurnContext = {};
    try {
      turnContext = (await options.loadTurnContext?.()) ?? {};
    } catch (err) {
      busy = false;
      preparingPrompt = false;
      if (disposed) return;
      setState("idle");
      // Context that just failed to load would fail again, so nothing queued is sent;
      // it goes back to the prompt in the order it was typed. A prompt turn's text never left.
      const rest = takeQueue();
      if (origin === "queue") restoreToPrompt(rest === null ? text : `${text}\n\n${rest}`);
      else if (rest !== null) restoreToPrompt(rest, origin === "prompt");
      transcript.addNotice(
        `Couldn't prepare this turn: ${err instanceof Error ? err.message : String(err)}`,
        "danger",
      );
      if (!options.isInputActive || options.isInputActive()) prompt.input.focus();
      return;
    }
    preparingPrompt = false;
    if (disposed) return;
    if (origin === "prompt") prompt.input.clear();
    messages.push({ role: "user", content: text });
    const configuredTools = turnContext.tools ?? options.tools;
    const systemPrompt = turnContext.systemPrompt ?? options.systemPrompt;
    const agentTools = configuredTools && configuredTools.length > 0 ? configuredTools : null;
    // The agent loop supplies its own assistant messages through onMessage.
    if (!agentTools) messages.push({ role: "assistant", content: "" });
    render();

    let failed = false;
    try {
      if (agentTools) {
        const result = await runAgent(
          {
            provider: options.provider,
            ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            tools: agentTools,
            onText: (delta) => appendStreamed(delta),
            // Preserve message identity so the final splice reuses rendered rows.
            onMessage: (message) => {
              messages.push(message);
              render();
              // Render before pinning activity so it lands after the preceding
              // answer. The announced assistant message is still empty/invisible.
              if (message.role === "assistant") beginThinking();
            },
            onTool: (name) => {
              // The question widget and Q&A row already represent ask_user.
              if (name === ASK_USER_TOOL_NAME) {
                endActivity();
                return;
              }
              beginActivity(toolLabel(name), toolPastLabel(name));
            },
            // onMessage starts thinking again, avoiding spurious rows between tools.
            onToolEnd: () => endActivity(),
            onUsage: (usage) => recordUsage(usage),
          },
          // onMessage mutates messages during the turn, so pass a snapshot.
          messages.slice(),
        );
        messages.splice(0, messages.length, ...result.messages.filter((m) => m.role !== "system"));
      } else {
        // Keep the system prompt out of the transcript and saved log.
        const context: ChatMessage[] =
          systemPrompt && systemPrompt.trim() !== ""
            ? [{ role: "system", content: systemPrompt }, ...messages]
            : messages;
        beginThinking();
        for await (const event of options.provider.streamChat(context)) {
          if (event.type === "text") appendStreamed(event.delta);
          else if (event.type === "usage") recordUsage(event.usage);
        }
      }
    } catch (err) {
      failed = true;
      dropUnfinishedAssistant();
      if (disposed) return;
      endActivity();
      transcript.addNotice(`Error: ${err instanceof Error ? err.message : String(err)}`, "danger");
    } finally {
      if (!disposed) {
        endActivity();
        render();
        // Stay busy through the save, so anything sent meanwhile queues behind
        // what is already queued instead of jumping ahead of it.
        if (options.chatLog) {
          try {
            await options.chatLog.save(messages);
          } catch {
            // Persisting history must not break the turn.
          }
        }
      }
      busy = false;
      if (!disposed) {
        // Read the queue only now: Up may have emptied it during the save.
        const next = takeQueue();
        // A provider that just failed would likely fail again; let the user resend.
        if (next !== null && failed) restoreToPrompt(next);
        // Going straight into the queued turn stays "working" rather than flickering idle.
        if (next !== null && !failed) void submit(next, "queue");
        else setState("idle");
      }
    }
  }

  const onKeypress = (key: KeyEvent): void => {
    if (options.isInputActive && !options.isInputActive()) return;

    // Let the confirmation dialog's later listener receive the key.
    if (modalOpen) {
      disarmShortcut();
      return;
    }

    // Escape dismisses the question; unclaimed keys reach its answer textarea.
    if (askWidget) {
      disarmShortcut();
      askWidget.handleKey(key);
      return;
    }

    // The popup gets Enter/Escape before submission or navigation.
    if (autocomplete.handleKey(key)) {
      disarmShortcut();
      return;
    }

    // Up on an empty prompt takes queued messages back for editing.
    if (key.name === "up" && queued.length > 0 && prompt.input.plainText === "") {
      key.preventDefault();
      disarmShortcut();
      const text = takeQueue();
      if (text !== null) restoreToPrompt(text);
      return;
    }

    if (key.name === "escape") {
      key.preventDefault();
      // A held key is not a deliberate second press when the terminal reports repeats.
      if (key.eventType === "repeat" || key.repeated) return;
      handleBack();
      return;
    }

    // Ctrl+C is intercepted by the app; any other key cancels either pending shortcut.
    if (pendingShortcut !== null) disarmShortcut();
  };
  renderer.keyInput.on("keypress", onKeypress);

  let disposeRan = false;
  function dispose(): void {
    if (disposeRan) return;
    disposeRan = true;
    disposed = true;
    dropUnfinishedAssistant();
    disarmShortcut();
    // Detaching declines pending questions so the agent turn can finish.
    detachAsk?.();
    autocomplete.dispose();
    // Settle while the transcript is still alive; the owner destroys it afterward.
    endActivity();
    renderer.keyInput.off("keypress", onKeypress);
    syntaxStyle.destroy();
    if (options.chatLog && messages.length > 0) {
      void options.chatLog.save(messages);
    }
  }

  return {
    node: container,
    focus: () => (askWidget ? askWidget.focus() : prompt.input.focus()),
    handleInterrupt,
    dispose,
    setTitle: (title) => {
      if (disposed) return;
      titleContent = title;
      titleText.content = title;
      fitHeader();
    },
  };
}
