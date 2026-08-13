/**
 * Chat screen: a scrollable transcript with an opencode-style prompt at the
 * bottom — an accent-bordered panel holding a multi-line textarea (Enter
 * sends, Shift+Enter adds a line) and a hint footer. User messages each render
 * in their own accent-strip panel (the same treatment as the prompt box) while
 * assistant replies flow as markdown beneath them. Streams assistant replies
 * from any ChatProvider. There is no status line: what Scribe is doing is
 * recorded inline as transcript activity rows ("Scribe is thinking…" settling
 * into "Thought · 4.3s", one row per tool call), and provider errors land there
 * too as one-off notices. Supports two modes: the agent loop with tools (planning/report, and
 * Drafting Table when it has tools), and plain streaming as the fallback
 * when an agent has no tools (the system prompt, if set, is prepended).
 *
 * When given an `AskChannel`, the screen also answers the `ask_user` tool: the
 * question replaces the prompt box until the user picks, the agent turn blocks
 * on it, and the settled exchange stays in the transcript as a compact Q&A row.
 */
import {
  BoxRenderable,
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

/** Persistence seam for resuming a conversation across app sessions. */
export interface ChatLogStore {
  load(): Promise<ChatMessage[]>;
  save(messages: ChatMessage[]): Promise<void>;
}

export interface ChatScreenOptions {
  provider: ChatProvider;
  /** Shown on the right of the title bar. */
  model?: string;
  /**
   * Resolves to richer metadata for `model` (display name, context window,
   * pricing) when the provider's `/models` listing includes it — OpenRouter
   * does, most others don't. The title bar shows just `model` until this
   * settles, then upgrades in place; a rejection or `undefined` leaves it as
   * is.
   */
  modelInfo?: Promise<ModelInfo | undefined>;
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

export interface ChatScreen extends Screen {
  /** Update the left side of the title bar without rebuilding the screen. */
  setTitle(title: string): void;
}

export async function makeChatScreen(renderer: CliRenderer, options: ChatScreenOptions): Promise<ChatScreen> {
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    // The top padding row belongs to the title bar below (see its paddingTop),
    // which has to own every row above the scroll box to keep the transcript
    // from painting into them.
    paddingLeft: 1,
    paddingRight: 1,
    paddingBottom: 1,
    flexDirection: "column",
  });

  // Title bar: Chat (test) on the left, model on the right.
  const titleRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    // Pinned: without these the flexGrow:1 scroll box below shrinks the row to
    // zero height and the transcript (added later, so drawn after) paints over
    // the header text.
    //
    // Opaque, and two rows tall so it covers the screen's top padding row too:
    // OpenTUI clips text and fills to the scroll viewport but draws a box's own
    // border unclipped, so a transcript row straddling the top edge still
    // paints its left rule across the rows above the scroll box. Drawing this
    // band last (zIndex) over an opaque background paints over that bleed — the
    // header text sits on the second row, so the bar still reads as a single
    // line with one blank row above it.
    height: 2,
    paddingTop: 1,
    paddingBottom: 1,
    backgroundColor: theme.background,
    flexShrink: 0,
    zIndex: 1,
    // No marginBottom on purpose: the first transcript row brings its own
    // marginTop, and the prompt panel below brings one too, so the transcript
    // sits exactly one blank row clear of each — symmetric in every state.
  });
  const titleText = new TextRenderable(renderer, { content: options.title ?? "Drafting Table", fg: theme.accent });
  titleRow.add(titleText);
  const modelText = new TextRenderable(renderer, { content: options.model ?? "", fg: theme.textMuted });
  if (options.model) titleRow.add(modelText);
  container.add(titleRow);

  // Model header: "Name | 45k/128k ctx (35%) | $0.02". Degrades gracefully as
  // pieces of ModelInfo/usage go missing — see ChatScreenOptions.modelInfo.
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
    modelText.content = parts.join("  |  ");
  }

  /** Approximate running cost: full resent context is priced every turn, so this overstates true billed cost when a provider caches the shared prefix. */
  function recordUsage(usage: UsageInfo): void {
    lastUsage = usage;
    const pricing = modelInfo?.pricing;
    if (pricing?.promptPerToken !== undefined && pricing.completionPerToken !== undefined) {
      cumulativeCost += usage.promptTokens * pricing.promptPerToken + usage.completionTokens * pricing.completionPerToken;
    }
    updateModelHeader();
  }

  // Scrolling transcript (see components/transcript.ts for how rows render).
  // The shared SyntaxStyle themes every markdown block with Scribe's palette;
  // this screen owns it, and dispose() destroys it.
  const syntaxStyle = createMarkdownSyntaxStyle();
  const scrollBox = new ScrollBoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
  });
  const transcript = makeTranscript(renderer, { syntaxStyle });
  scrollBox.content.add(transcript.node);
  container.add(scrollBox);

  // Prompt panel (opencode-style): bordered textarea + hint footer.
  const prompt = makePrompt(renderer, { onSubmit: () => void send() });
  container.add(prompt.node);

  const messages: ChatMessage[] = [];
  let busy = false;
  /**
   * Set by `dispose`. An agent turn outlives the screen — the user can leave
   * while the model is still streaming, or while a question sits unanswered —
   * and everything the turn would otherwise touch on the way out (the syntax
   * style, the transcript and its activity rows) is gone by then.
   */
  let disposed = false;

  if (options.modelInfo) {
    void options.modelInfo.then((info) => {
      if (disposed) return;
      modelInfo = info;
      updateModelHeader();
    });
  }

  /** Repaint the transcript. Skipped after dispose: building a row needs the
   * SyntaxStyle, which dispose() destroys, and a turn still streaming after the
   * user left must not paint into a dead tree. */
  function render(): void {
    if (disposed) return;
    transcript.sync(messages);
  }

  // Resume: seed the transcript with any saved conversation.
  if (options.chatLog) {
    messages.push(...(await options.chatLog.load()));
    render();
  }

  // --- activity: what Scribe is doing, recorded inline in the transcript ---

  /**
   * The one activity row currently running, if any. Scribe does exactly one
   * thing at a time — think, or run a tool — so opening a new activity settles
   * whatever was open, which makes every call site below safe to repeat.
   */
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

  /** Waiting on the model — the activity every turn starts and resumes with. */
  function beginThinking(): void {
    beginActivity("Scribe is thinking", "Thought");
  }

  /**
   * Append a streamed delta to the pending assistant message — the trailing
   * placeholder in plain-streaming mode, or the live message `runAgent` handed
   * over in agent mode. A message that already carries tool calls is settled,
   * so text after it starts a new one rather than growing the old bubble.
   */
  function appendStreamed(delta: string): void {
    // Prose is arriving, so the wait is over and its row can settle.
    endActivity();
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && !last.tool_calls) last.content += delta;
    else messages.push({ role: "assistant", content: delta });
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

      // It isn't thinking, it's blocked on the user — settle the row. The
      // question itself is the indicator, and the answer becomes its own
      // transcript row, so ask_user gets no activity row of its own.
      endActivity();

      prompt.node.visible = false;
      // Hiding the prompt leaves its textarea focused, which keeps the terminal
      // cursor blinking where the input used to be; blur it so only the widget
      // is live.
      prompt.input.blur();
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
    // The answer still has to go back to the model, so the turn continues. The
    // thinking row is deliberately *not* opened here: the answered question
    // hasn't reached the transcript yet, and a pinned row would land above it.
    // `onMessage` opens it when the next model turn is announced.
    prompt.input.focus();
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
    // Activity rows aren't messages, so `render()` alone would leave them
    // stranded above an empty conversation. Drop our handle on the running row
    // first — `reset()` tears its renderable down, so there is nothing left to
    // settle.
    live = null;
    transcript.reset();
    render();
    // Persist the empty log so the conversation is gone on the next visit too,
    // not just in this session.
    if (options.chatLog) void options.chatLog.save(messages);
  }

  function confirmClear(): void {
    // Wiping the history the agent is mid-way through reasoning over would
    // leave the turn talking about messages that no longer exist.
    if (busy) {
      transcript.addNotice("Can't clear while Scribe is working — wait for the reply.");
      return;
    }
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
    // Length-checked, not just truthy: an agent granted no tools (see AGENTS in
    // agent/agents.ts) resolves to [], which must take the cheaper
    // plain-streaming path rather than a tool-less agent loop.
    const agentTools = options.tools && options.tools.length > 0 ? options.tools : null;
    // Agent mode gets its assistant messages from runAgent's `onMessage` (one
    // per model turn, interleaved with tool results); only plain streaming
    // needs a placeholder to stream into.
    if (!agentTools) messages.push({ role: "assistant", content: "" });
    busy = true;
    render();

    try {
      if (agentTools) {
        // Planning mode: run the agent loop (system prompt + tools). runAgent
        // keeps its own conversation array, but hands every message over as it
        // is created, so the transcript grows during the turn — an answered
        // ask_user shows up the moment it is answered, not when the turn ends.
        const result = await runAgent(
          {
            provider: options.provider,
            ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
            tools: agentTools,
            onText: (delta) => appendStreamed(delta),
            // The live objects runAgent is building; mirroring them by
            // reference keeps this array element-identical to the result, so
            // the splice below reuses every already-rendered row.
            onMessage: (message) => {
              messages.push(message);
              render();
              // Every model turn opens with an empty assistant message, so this
              // is exactly when thinking starts — and it is the only safe moment
              // to open the row. Pinned rows land at the end of the transcript,
              // so opening it any earlier (when the question widget closed, say)
              // puts "Scribe is thinking…" above the answer that preceded it.
              // The empty message renders nothing, so the row still lands last.
              if (message.role === "assistant") beginThinking();
            },
            onTool: (name) => {
              // ask_user is its own indicator: the question replaces the prompt
              // box and the answer becomes a transcript row, so a row for it
              // here would only duplicate what's already on screen. Still settle
              // the thinking row — the model has stopped and the user is up.
              if (name === ASK_USER_TOOL_NAME) {
                endActivity();
                return;
              }
              beginActivity(toolLabel(name), toolPastLabel(name));
            },
            // Settle the tool's row the moment it returns; the next turn's
            // thinking row is opened by `onMessage`, not here, so back-to-back
            // tool calls in one turn don't get a phantom "Thought · 0.1s"
            // wedged between them.
            onToolEnd: () => endActivity(),
            onUsage: (usage) => recordUsage(usage),
          },
          // A snapshot taken before the turn starts: there is no placeholder to
          // trim here, and `onMessage` appends to `messages` as the turn runs.
          messages.slice(),
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
        // No agent loop here, so nothing else announces the turn.
        beginThinking();
        for await (const event of options.provider.streamChat(context)) {
          if (event.type === "text") appendStreamed(event.delta);
          else if (event.type === "usage") recordUsage(event.usage);
        }
      }
    } catch (err) {
      if (disposed) return;
      endActivity();
      transcript.addNotice(`Error: ${err instanceof Error ? err.message : String(err)}`, "danger");
    } finally {
      busy = false;
      // The user may have left while this turn was in flight. dispose() has
      // already settled the activity row and saved, and the transcript is gone.
      // Everything below would only repeat that against a dead tree.
      if (!disposed) {
        endActivity();
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
    // Settle rather than drop: the transcript is still alive at this point (the
    // screen manager destroys the node after dispose returns), so a turn that
    // outlives the screen leaves a finished row behind instead of a dangling
    // "Scribe is thinking…".
    endActivity();
    renderer.keyInput.off("keypress", onKeypress);
    syntaxStyle.destroy();
    if (options.chatLog && messages.length > 0) {
      void options.chatLog.save(messages);
    }
  }

  return {
    node: container,
    focus: () => prompt.input.focus(),
    dispose,
    setTitle: (title) => {
      if (!disposed) titleText.content = title;
    },
  };
}
