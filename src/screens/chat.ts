/**
 * Chat screen (scratch harness UI): a scrollable transcript with a single
 * message input. Streams assistant replies from any ChatProvider. Phase 2
 * will build the planning/report modes on this.
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
import type { ChatMessage, ChatProvider } from "../provider/types.ts";
import type { Screen } from "./screen.ts";

export interface ChatScreenOptions {
  provider: ChatProvider;
  onBack: () => void;
}

export async function makeChatScreen(renderer: CliRenderer, options: ChatScreenOptions): Promise<Screen> {
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    padding: 1,
    flexDirection: "column",
  });
  container.add(new TextRenderable(renderer, { content: "Chat (test)", fg: theme.accent, marginBottom: 1 }));

  const status = new TextRenderable(renderer, {
    content: "",
    fg: theme.textMuted,
    height: 1,
    marginBottom: 1,
  });
  container.add(status);

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

  const input = new InputRenderable(renderer, {
    placeholder: "Type a message…",
    width: "100%",
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    marginTop: 1,
  });
  container.add(input);
  container.add(
    new TextRenderable(renderer, { content: "Enter to send · Esc to exit", fg: theme.textMuted, marginTop: 1 }),
  );

  const messages: ChatMessage[] = [];
  let busy = false;

  const transcript = (): string =>
    messages.map((m) => `**${m.role === "user" ? "You" : "Scribe"}:** ${m.content}`).join("\n\n");

  function render(): void {
    markdown.content = transcript();
    markdown.streaming = busy;
  }

  async function send(): Promise<void> {
    const text = input.value.trim();
    if (text === "" || busy) return;
    input.value = "";
    messages.push({ role: "user", content: text });
    messages.push({ role: "assistant", content: "" });
    busy = true;
    status.fg = theme.textMuted;
    status.content = "…";
    render();

    try {
      for await (const chunk of options.provider.streamChat(messages)) {
        messages[messages.length - 1]!.content += chunk;
        render();
      }
      status.content = "";
    } catch (err) {
      status.fg = theme.danger;
      status.content = `Error: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
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
    renderer.keyInput.off("keypress", onKeypress);
    syntaxStyle.destroy();
  }

  input.on(InputRenderableEvents.ENTER, () => void send());

  return { node: container, focus: () => input.focus(), dispose };
}
