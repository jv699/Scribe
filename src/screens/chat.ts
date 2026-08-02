/**
 * Chat screen (scratch harness UI): a scrollable transcript with a single
 * message input in a dark panel. Streams assistant replies from any
 * ChatProvider; a spinner animates next to the "Scribe:" label while the
 * model is thinking, then disappears when the reply starts streaming.
 * Phase 2 will build the planning/report modes on this.
 */
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { startSpinnerFrames } from "../spinner.ts";
import { runAgent, type AgentTool } from "../agent/loop.ts";
import type { ChatMessage, ChatProvider } from "../provider/types.ts";
import type { Screen } from "./screen.ts";

export interface ChatScreenOptions {
  provider: ChatProvider;
  /** Shown on the right of the title bar. */
  model?: string;
  /** Left of the title bar. Defaults to "Chat (test)". */
  title?: string;
  /**
   * When set, sends go through the agent loop with these tools and this base
   * system prompt (planning/report mode). When omitted, plain text streaming only.
   */
  systemPrompt?: string;
  tools?: AgentTool[];
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
  titleRow.add(new TextRenderable(renderer, { content: options.title ?? "Chat (test)", fg: theme.accent }));
  if (options.model) {
    titleRow.add(new TextRenderable(renderer, { content: options.model, fg: theme.textMuted }));
  }
  container.add(titleRow);

  // Status line: errors only (the "thinking" indicator lives in the
  // transcript next to "Scribe:").
  const status = new TextRenderable(renderer, { content: "", fg: theme.textMuted, height: 1 });
  container.add(status);

  // Transcript.
  const syntaxStyle = SyntaxStyle.create();
  const markdown = new MarkdownRenderable(renderer, { content: "", width: "100%", syntaxStyle });
  const scrollBox = new ScrollBoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
  });
  scrollBox.content.add(markdown);
  container.add(scrollBox);

  // Input panel (same dark background as the select menu; no border).
  const inputBox = new BoxRenderable(renderer, {
    width: "100%",
    backgroundColor: theme.surfaceActive,
    paddingX: 1,
    marginTop: 1,
  });
  const input = new InputRenderable(renderer, {
    placeholder: "Type a message…",
    width: "100%",
    backgroundColor: theme.surfaceActive,
    focusedBackgroundColor: theme.surfaceActive,
  });
  inputBox.add(input);
  container.add(inputBox);
  container.add(
    new TextRenderable(renderer, { content: "Enter to send · Esc to exit", fg: theme.textMuted, marginTop: 1 }),
  );

  const messages: ChatMessage[] = [];
  let busy = false;
  let stopThinking: (() => void) | null = null;

  const transcript = (): string =>
    messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim() !== "")
      .map((m) => `**${m.role === "user" ? "You" : "Scribe"}:** ${m.content}`)
      .join("\n\n");

  function render(): void {
    markdown.content = transcript();
    markdown.streaming = busy;
  }

  /** Animate the spinner in the pending "Scribe:" message. */
  function startThinking(): void {
    stopThinking = startSpinnerFrames(80, (frame) => {
      const last = messages[messages.length - 1];
      if (last?.role === "assistant") {
        last.content = frame;
        render();
      }
    });
  }

  /** Stop the spinner, clearing its frame from the pending message. */
  function stopThinkingNow(): void {
    if (!stopThinking) return;
    stopThinking();
    stopThinking = null;
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") last.content = "";
  }

  /** Append a streamed delta to the pending assistant message. */
  function appendStreamed(delta: string): void {
    stopThinkingNow();
    messages[messages.length - 1]!.content += delta;
    render();
  }

  async function send(): Promise<void> {
    const text = input.value.trim();
    if (text === "" || busy) return;
    input.value = "";
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
        // pending assistant message is for spinner/streaming display only —
        // runAgent manages its own conversation copy.
        const result = await runAgent(
          {
            provider: options.provider,
            systemPrompt: options.systemPrompt,
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
        // Scratch mode: plain text streaming.
        for await (const event of options.provider.streamChat(messages)) {
          if (event.type === "text") appendStreamed(event.delta);
        }
      }
      status.content = "";
    } catch (err) {
      status.fg = theme.danger;
      status.content = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      stopThinkingNow();
      busy = false;
      render();
    }
  }

  const onKeypress = (key: KeyEvent): void => {
    if (key.name === "escape") {
      key.preventDefault();
      dispose();
      options.onBack();
    }
  };
  renderer.keyInput.on("keypress", onKeypress);

  function dispose(): void {
    stopThinking?.();
    renderer.keyInput.off("keypress", onKeypress);
    syntaxStyle.destroy();
  }

  input.on(InputRenderableEvents.ENTER, () => void send());

  return { node: container, focus: () => input.focus(), dispose };
}
