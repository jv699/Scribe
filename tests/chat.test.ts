import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMockKeys, type TestRenderer } from "@opentui/core/testing";
import { setupRenderer, wait } from "./helpers/renderer.ts";
import { MarkdownRenderable, TextareaRenderable, type Renderable } from "@opentui/core";
import { makeChatScreen, type ChatLogStore } from "../src/screens/chat.ts";
import type { Screen } from "../src/screens/screen.ts";
import type { ChatEvent, ChatMessage, ChatProvider } from "../src/provider/types.ts";
import type { AgentTool } from "../src/agent/loop.ts";
import { makeAskChannel } from "../src/agent/ask.ts";
import { resolveTools } from "../src/agent/tools/index.ts";
import type { CompletionItem, CompletionSource } from "../src/components/autocomplete.ts";

let renderer: TestRenderer;
let captureCharFrame: () => string;
let renderOnce: () => Promise<void>;
let keys: ReturnType<typeof createMockKeys>;
let current: Screen | null = null;
let wentBack = false;

const okProvider: ChatProvider = {
  async *streamChat() {
    for (const chunk of ["Hel", "lo ", "world"]) yield { type: "text", delta: chunk };
  },
};

const errorProvider: ChatProvider = {
  async *streamChat() {
    throw new Error("connection refused");
  },
};


beforeEach(async () => {
  ({ renderer, keys, captureCharFrame, renderOnce } = await setupRenderer({ width: 80, height: 24 }));
  current = null;
  wentBack = false;
});

afterEach(() => {
  current?.dispose?.();
  renderer.destroy();
});

async function open(provider: ChatProvider): Promise<void> {
  current = await makeChatScreen(renderer, {
    provider,
    onBack: () => {
      wentBack = true;
    },
  });
  renderer.root.add(current.node);
  current.focus?.();
  await renderOnce();
}

describe("chat screen", () => {
  test("streams an assistant reply into the transcript", async () => {
    await open(okProvider);
    await keys.typeText("hello", 5);
    keys.pressEnter();
    await wait();
    await renderOnce();

    const frame = captureCharFrame();
    expect(frame.includes("hello")).toBe(true);
    expect(frame.includes("world")).toBe(true);
    // names are stripped from the transcript
    expect(frame.includes("You:")).toBe(false);
    expect(frame.includes("Scribe:")).toBe(false);
  });

  test("multi-line input: Shift+Enter adds a line, Enter sends it", async () => {
    // Modifiers need the kitty-keyboard mock to round-trip.
    const kitty = createMockKeys(renderer, { kittyKeyboard: true });
    await open(okProvider);
    await kitty.typeText("first line", 5);
    kitty.pressEnter({ shift: true });
    await kitty.typeText("second line", 5);
    kitty.pressEnter();
    await wait();
    await renderOnce();

    const frame = captureCharFrame();
    expect(frame.includes("first line")).toBe(true);
    expect(frame.includes("second line")).toBe(true);
    // both lines landed in a single message (adjacent rows inside one box, no blank line between)
    expect(/first line[^\n]*\n *│ +second line/.test(frame)).toBe(true);
    expect((frame.match(/first line/g) ?? []).length).toBe(1);
    expect((frame.match(/second line/g) ?? []).length).toBe(1);
  });

  test("surfaces provider errors in the status line", async () => {
    await open(errorProvider);
    await keys.typeText("hi", 5);
    keys.pressEnter();
    await wait();
    await renderOnce();

    expect(captureCharFrame().includes("Error: connection refused")).toBe(true);
  });

  test("escape goes back", async () => {
    await open(okProvider);
    keys.pressKey("ESCAPE");
    await wait(500);
    expect(wentBack).toBe(true);
  });

  // Regression: an agent turn outlives the screen. dispose() destroys the
  // SyntaxStyle every transcript row is built from, so a turn that finished
  // after the user left used to throw "NativeSyntaxStyle is destroyed" while
  // building rows for the messages runAgent handed back. Tools mode is what
  // reproduces it: it swaps the whole message list at the end of the turn, so
  // every row is rebuilt rather than updated in place. Bun fails the test on
  // the unhandled error, which is the assertion here.
  test("leaving while a turn is in flight does not throw", async () => {
    const slowToolProvider: ChatProvider = {
      async *streamChat(messages): AsyncGenerator<ChatEvent> {
        await new Promise((r) => setTimeout(r, 120));
        if (messages.some((m) => m.role === "tool")) {
          yield { type: "text", delta: "## Done\n\n- **finished** late" };
          return;
        }
        yield { type: "tool_call", toolCall: { index: 0, id: "c1", name: "echo", arguments: "{}" } };
      },
    };
    const tools: AgentTool[] = [
      {
        definition: {
          type: "function",
          function: { name: "echo", description: "echo", parameters: { type: "object", properties: {} } },
        },
        execute: () => "ok",
      },
    ];

    current = await makeChatScreen(renderer, {
      provider: slowToolProvider,
      tools,
      onBack: () => {
        wentBack = true;
      },
    });
    renderer.root.add(current.node);
    current.focus?.();
    await renderOnce();
    await keys.typeText("hi", 5);
    keys.pressEnter();
    await wait(60); // still mid-turn

    keys.pressKey("ESCAPE");
    await wait(600); // long enough for the turn to finish after we're gone
    expect(wentBack).toBe(true);
    current = null; // the escape handler already disposed it
  });

  test("streaming mode without tools prepends the system prompt", async () => {
    let received: ChatMessage[] = [];
    const captureProvider: ChatProvider = {
      async *streamChat(messages) {
        received = [...messages];
        yield { type: "text", delta: "ok" };
      },
    };

    current = await makeChatScreen(renderer, {
      provider: captureProvider,
      systemPrompt: "You are a one-shot planner.",
      onBack: () => {},
    });
    renderer.root.add(current.node);
    current.focus?.();
    await renderOnce();

    await keys.typeText("plan an encounter", 5);
    keys.pressEnter();
    await wait();
    await renderOnce();

    expect(received[0]).toEqual({ role: "system", content: "You are a one-shot planner." });
    expect(received[1]!.content).toBe("plan an encounter");
    // the system prompt must not leak into the transcript
    expect(captureCharFrame().includes("one-shot planner")).toBe(false);
  });

  test("planning mode runs tools and streams the final answer", async () => {    const toolProvider: ChatProvider = {
      async *streamChat(messages): AsyncGenerator<ChatEvent> {
        if (messages.some((m) => m.role === "tool")) {
          yield { type: "text", delta: "All set." };
          return;
        }
        yield {
          type: "tool_call",
          toolCall: { index: 0, id: "c1", name: "echo", arguments: '{"word":"hi"}' },
        };
      },
    };
    const tools: AgentTool[] = [
      {
        definition: {
          type: "function",
          function: { name: "echo", description: "echo", parameters: { type: "object", properties: {} } },
        },
        execute: () => "ok",
      },
    ];

    current = await makeChatScreen(renderer, {
      provider: toolProvider,
      systemPrompt: "You plan.",
      tools,
      onBack: () => {},
    });
    renderer.root.add(current.node);
    current.focus?.();
    await renderOnce();

    await keys.typeText("do it", 5);
    keys.pressEnter();
    await wait();
    await renderOnce();

    const frame = captureCharFrame();
    expect(frame.includes("do it")).toBe(true);
    expect(frame.includes("All set.")).toBe(true);
    // exactly one assistant reply, no duplicate/empty lines
    expect((frame.match(/All set\./g) ?? []).length).toBe(1);
    expect(frame.includes("Scribe:")).toBe(false);
  });

  // Regression: MarkdownRenderable only builds a synchronous first paint while
  // `streaming` is on. With it off, blocks wait on an async tree-sitter highlight
  // and paint blank for a frame — a visible flicker mid-conversation and a blank
  // first frame for rows built from existing content. See makeRow in chat.ts.
  describe("markdown never blanks out", () => {
    const MARKDOWN = "Here you go:\n\n- **System** (D&D 5e)\n- **Party size**\n\nWhat do you have in mind?";

    /** Every MarkdownRenderable currently in the tree. */
    function markdownRows(node: Renderable = renderer.root): MarkdownRenderable[] {
      const found = node instanceof MarkdownRenderable ? [node] : [];
      for (const child of node.getChildren()) found.push(...markdownRows(child));
      return found;
    }

    test("transcript rows are never taken out of streaming mode", async () => {
      const chunkedProvider: ChatProvider = {
        async *streamChat(): AsyncGenerator<ChatEvent> {
          for (const chunk of MARKDOWN.match(/[\s\S]{1,8}/g) ?? []) {
            await new Promise((r) => setTimeout(r, 2));
            yield { type: "text", delta: chunk };
          }
        },
      };
      await open(chunkedProvider);
      await keys.typeText("hi", 5);
      keys.pressEnter();
      await wait();
      await renderOnce();

      expect(captureCharFrame().includes("What do you have in mind?")).toBe(true);
      const rows = markdownRows();
      expect(rows.length).toBe(2);
      // Turning this off rebuilds every block without a synchronous first paint,
      // which blanks the whole transcript for a frame.
      expect(rows.map((r) => r.streaming)).toEqual([true, true]);
    });

    test("a resumed transcript paints on its very first frame", async () => {
      const chatLog: ChatLogStore = {
        load: async () => [
          { role: "user", content: "previous question" },
          { role: "assistant", content: MARKDOWN },
        ],
        save: async () => {},
      };

      current = await makeChatScreen(renderer, { provider: okProvider, chatLog, onBack: () => {} });
      renderer.root.add(current.node);
      current.focus?.();
      // No settling delay: the first painted frame must already have the text.
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame.includes("previous question")).toBe(true);
      expect(frame.includes("What do you have in mind?")).toBe(true);
    });
  });

  // The ask_user widget: the agent puts a question where the prompt box was,
  // the turn blocks on it, and the settled exchange stays in the transcript.
  // These drive the real tool through a real AskChannel, so the wiring between
  // gateway, tool, channel and screen is covered end to end.
  describe("ask_user questions", () => {
    const PROMPT_HINT = "Enter to send";
    const ONE_OF_TWO = JSON.stringify({
      question: "Which hook drives session 2?",
      header: "Session hook",
      options: [{ label: "The missing bell-ringer" }, { label: "A caravan gone silent" }],
    });

    /** Counts turns so we can tell the loop actually resumed after an answer. */
    let turns = 0;

    /** Calls ask_user on the first turn, then answers once a result comes back. */
    function askingProvider(args: string): ChatProvider {
      return {
        async *streamChat(messages): AsyncGenerator<ChatEvent> {
          turns++;
          if (messages.some((m) => m.role === "tool")) {
            yield { type: "text", delta: "Locked in." };
            return;
          }
          yield { type: "tool_call", toolCall: { index: 0, id: "c1", name: "ask_user", arguments: args } };
        },
      };
    }

    /** Open a chat wired for ask_user and send a message so the question appears. */
    async function ask(args: string, chatLog?: ChatLogStore): Promise<void> {
      turns = 0;
      const channel = makeAskChannel();
      current = await makeChatScreen(renderer, {
        provider: askingProvider(args),
        tools: resolveTools(["ask_user"], { ask: channel }),
        ask: channel,
        ...(chatLog ? { chatLog } : {}),
        onBack: () => {
          wentBack = true;
        },
      });
      renderer.root.add(current.node);
      current.focus?.();
      await renderOnce();
      await keys.typeText("plan it", 5);
      keys.pressEnter();
      await wait();
      await renderOnce();
    }

    test("a question takes the prompt box's place", async () => {
      await ask(ONE_OF_TWO);
      const frame = captureCharFrame();
      expect(frame.includes("Which hook drives session 2?")).toBe(true);
      expect(frame.includes("SESSION HOOK")).toBe(true);
      expect(frame.includes("The missing bell-ringer")).toBe(true);
      expect(frame.includes("A caravan gone silent")).toBe(true);
      // The prompt is hidden while the question is up, not merely covered.
      expect(frame.includes(PROMPT_HINT)).toBe(false);
      expect(frame.includes("waiting for your answer")).toBe(true);
      // Still mid-turn: the tool result hasn't gone back to the model yet.
      expect(turns).toBe(1);
    });

    test("a digit picks an option, and the turn resumes with the answer", async () => {
      await ask(ONE_OF_TWO);
      keys.pressKey("2");
      await wait();
      await renderOnce();

      const frame = captureCharFrame();
      expect(turns).toBe(2);
      expect(frame.includes("Locked in.")).toBe(true);
      // The settled exchange stays visible as a compact Q&A row...
      expect(frame.includes("→ A caravan gone silent")).toBe(true);
      // ...and the prompt box comes back.
      expect(frame.includes(PROMPT_HINT)).toBe(true);
    });

    test("arrows move the selection and Enter chooses it", async () => {
      await ask(ONE_OF_TWO);
      keys.pressArrow("down");
      await renderOnce();
      keys.pressEnter();
      await wait();
      await renderOnce();
      expect(captureCharFrame().includes("→ A caravan gone silent")).toBe(true);
    });

    test("Escape dismisses the question without leaving the chat", async () => {
      // Escape normally exits the chat screen. While a question is up it must
      // mean "skip this question" — otherwise leaving would strand the turn.
      await ask(ONE_OF_TWO);
      keys.pressKey("ESCAPE");
      await wait(500);
      await renderOnce();

      expect(wentBack).toBe(false);
      // The agent was told, and carried on.
      expect(turns).toBe(2);
      const frame = captureCharFrame();
      expect(frame.includes("Locked in.")).toBe(true);
      expect(frame.includes(PROMPT_HINT)).toBe(true);
      // A skipped fork isn't part of the story, so it leaves no row.
      expect(frame.includes("Which hook drives session 2?")).toBe(false);

      // And Escape goes back to meaning "leave" again.
      keys.pressKey("ESCAPE");
      await wait(500);
      expect(wentBack).toBe(true);
    });

    test("Space toggles and Enter confirms in multi-select", async () => {
      await ask(
        JSON.stringify({
          question: "Which omens appear?",
          options: [{ label: "Blood rain" }, { label: "Silent bells" }, { label: "Dead crows" }],
          multiple: true,
          custom: false,
        }),
      );
      expect(captureCharFrame().includes("[ ]")).toBe(true);

      keys.pressKey(" ");
      keys.pressArrow("down");
      keys.pressArrow("down");
      keys.pressKey(" ");
      await renderOnce();
      keys.pressEnter();
      await wait();
      await renderOnce();

      // Emitted in the order presented, not the order clicked.
      expect(captureCharFrame().includes("→ Blood rain, Dead crows")).toBe(true);
    });

    test("confirming nothing in multi-select nudges instead of answering blank", async () => {
      await ask(
        JSON.stringify({
          question: "Which omens appear?",
          options: [{ label: "Blood rain" }],
          multiple: true,
        }),
      );
      keys.pressEnter();
      await renderOnce();
      expect(captureCharFrame().includes("Pick at least one option")).toBe(true);
      expect(turns).toBe(1); // still waiting
    });

    test("the user can type an answer none of the options cover", async () => {
      await ask(ONE_OF_TWO);
      // Row 3 is the "type your own answer" row.
      keys.pressKey("3");
      await renderOnce();
      await keys.typeText("A funeral that won't end", 3);
      keys.pressEnter();
      await wait();
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame.includes("→ A funeral that won't end")).toBe(true);
      expect(frame.includes("Locked in.")).toBe(true);
    });

    test("a typed answer can be combined with picked options", async () => {
      await ask(
        JSON.stringify({
          question: "Which omens appear?",
          options: [{ label: "Blood rain" }, { label: "Silent bells" }],
          multiple: true,
        }),
      );
      keys.pressKey(" "); // toggle "Blood rain"
      keys.pressArrow("down");
      keys.pressArrow("down"); // the "type your own" row
      keys.pressEnter(); // opens the editor
      await renderOnce();
      await keys.typeText("A second moon", 3);
      keys.pressEnter(); // adds it to the selection, back to the list
      await renderOnce();
      expect(captureCharFrame().includes("[x] A second moon")).toBe(true);

      keys.pressEnter(); // confirm
      await wait();
      await renderOnce();
      expect(captureCharFrame().includes("→ Blood rain, A second moon")).toBe(true);
    });

    test("custom answers can be turned off", async () => {
      await ask(
        JSON.stringify({
          question: "Which omens appear?",
          options: [{ label: "Blood rain" }],
          custom: false,
        }),
      );
      expect(captureCharFrame().includes("Type your own answer")).toBe(false);
    });

    test("an answered question is restored from a saved conversation", async () => {
      // Rendering is derived from the assistant's tool_calls plus the tool
      // result, both of which the log already stores — so resume needs no
      // extra persistence and no migration.
      const chatLog: ChatLogStore = {
        load: async () => [
          { role: "user", content: "plan it" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "ask_user", arguments: "{}" } },
              { id: "c2", type: "function", function: { name: "list_sessions", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "Asked: Which hook?\nAnswer: The bell-ringer" },
          { role: "tool", tool_call_id: "c2", content: "1. \"Death House\" [planning]" },
          { role: "assistant", content: "Locked in." },
        ],
        save: async () => {},
      };

      current = await makeChatScreen(renderer, { provider: okProvider, chatLog, onBack: () => {} });
      renderer.root.add(current.node);
      current.focus?.();
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame.includes("Which hook?")).toBe(true);
      expect(frame.includes("→ The bell-ringer")).toBe(true);
      // Only ask_user results surface; other tool output stays out of the transcript.
      expect(frame.includes("Death House")).toBe(false);
    });

    test("leaving mid-question doesn't strand the turn", async () => {
      // Nothing on screen will ever resolve the question once the screen is
      // gone, so disposing has to settle it as a decline.
      await ask(ONE_OF_TWO);
      expect(turns).toBe(1);

      current?.dispose?.();
      current = null;
      await wait();

      // The loop got its result and finished rather than awaiting forever.
      expect(turns).toBe(2);
    });
  });

  // The prompt-anchored completion popup: a list that opens off the top edge of
  // the chat box. It overlays the transcript rather than displacing it, and it
  // borrows the keyboard from the prompt without taking focus.
  describe("completion popup", () => {
    const PROMPT_HINT = "Enter to send";

    /** Mentions with descriptions, to exercise matching on both fields. */
    const mentions: CompletionSource = {
      trigger: "@",
      items: (query) => {
        const all: CompletionItem[] = [
          { label: "@session-1", description: "Death House · planning", insert: 'session 1 ("Death House")' },
          { label: "@session-2", description: "The Bell Tower · ready", insert: 'session 2 ("The Bell Tower")' },
          { label: "@background", description: "The campaign premise", insert: "the campaign background" },
        ];
        const needle = query.toLowerCase();
        if (needle === "") return all;
        return all.filter((i) => `${i.label} ${i.description}`.toLowerCase().includes(needle));
      },
    };

    async function openWithCompletions(): Promise<void> {
      current = await makeChatScreen(renderer, {
        provider: okProvider,
        completions: [mentions],
        onBack: () => {
          wentBack = true;
        },
      });
      renderer.root.add(current.node);
      current.focus?.();
      await renderOnce();
    }

    /** The prompt textarea, so tests can assert what substitution produced. */
    function promptText(): string {
      const find = (node: Renderable): TextareaRenderable | null => {
        if (node instanceof TextareaRenderable) return node;
        for (const child of node.getChildren()) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      };
      return find(renderer.root)?.plainText ?? "";
    }

    test("typing @ opens the popup above the chat box", async () => {
      await openWithCompletions();
      await keys.typeText("look at @", 5);
      await wait(60);
      await renderOnce();

      const frame = captureCharFrame();
      const lines = frame.split("\n");
      expect(frame.includes("@session-1")).toBe(true);
      expect(frame.includes("The Bell Tower")).toBe(true);
      // It sits above the prompt, not below it, and the prompt is still there:
      // the popup overlays the transcript rather than replacing the chat box.
      const popupLine = lines.findIndex((l) => l.includes("@session-1"));
      const hintLine = lines.findIndex((l) => l.includes(PROMPT_HINT));
      expect(popupLine).toBeGreaterThan(-1);
      expect(hintLine).toBeGreaterThan(popupLine);
    });

    test("the query filters on labels and descriptions alike", async () => {
      await openWithCompletions();
      await keys.typeText("@bell", 5);
      await wait(60);
      await renderOnce();

      const frame = captureCharFrame();
      // Matched by title, which the label alone would have missed.
      expect(frame.includes("@session-2")).toBe(true);
      expect(frame.includes("@session-1")).toBe(false);
      expect(frame.includes("@background")).toBe(false);
    });

    test("Enter picks the highlighted item instead of sending", async () => {
      await openWithCompletions();
      await keys.typeText("look at @sess", 5);
      await wait(60);
      keys.pressArrow("down"); // second match
      await renderOnce();
      keys.pressEnter();
      await wait(60);
      await renderOnce();

      // The trigger and query were replaced, and a trailing space added.
      expect(promptText()).toBe('look at session 2 ("The Bell Tower") ');
      // Enter completed rather than submitting, so nothing was sent.
      expect(captureCharFrame().includes("world")).toBe(false);
      // And the popup closed behind it.
      expect(captureCharFrame().includes("The campaign premise")).toBe(false);
    });

    test("Tab completes too", async () => {
      await openWithCompletions();
      await keys.typeText("@back", 5);
      await wait(60);
      keys.pressTab();
      await wait(60);
      await renderOnce();
      expect(promptText()).toBe("the campaign background ");
    });

    test("Escape closes the popup but stays in the chat", async () => {
      await openWithCompletions();
      await keys.typeText("@", 5);
      await wait(60);
      await renderOnce();
      expect(captureCharFrame().includes("@session-1")).toBe(true);

      keys.pressKey("ESCAPE");
      await wait(500);
      await renderOnce();
      expect(captureCharFrame().includes("@session-1")).toBe(false);
      expect(wentBack).toBe(false);

      // Escape means "leave" again now the list is gone.
      keys.pressKey("ESCAPE");
      await wait(500);
      expect(wentBack).toBe(true);
    });

    test("a space closes the popup, and Enter sends again", async () => {
      await openWithCompletions();
      await keys.typeText("@session-1 hello", 5);
      await wait(60);
      await renderOnce();
      expect(captureCharFrame().includes("Death House · planning")).toBe(false);

      keys.pressEnter();
      await wait();
      await renderOnce();
      expect(captureCharFrame().includes("world")).toBe(true);
    });

    test("a mid-word @ is left alone", async () => {
      // Email addresses and handles shouldn't summon a session list.
      await openWithCompletions();
      await keys.typeText("mail me at scribe@", 5);
      await wait(60);
      await renderOnce();
      expect(captureCharFrame().includes("@session-1")).toBe(false);
    });

    test("a list longer than the window scrolls to follow the selection", async () => {
      const many: CompletionSource = {
        trigger: "@",
        items: () =>
          Array.from({ length: 14 }, (_, i) => ({
            label: `@session-${i + 1}`,
            insert: `s${i + 1}`,
          })),
      };
      current = await makeChatScreen(renderer, {
        provider: okProvider,
        completions: [many],
        onBack: () => {},
      });
      renderer.root.add(current.node);
      current.focus?.();
      await renderOnce();

      await keys.typeText("@", 5);
      await wait(60);
      await renderOnce();
      // Eight rows by default, so the tail of the list starts off-screen.
      expect(captureCharFrame().includes("@session-8")).toBe(true);
      expect(captureCharFrame().includes("@session-9")).toBe(false);

      for (let i = 0; i < 9; i++) keys.pressArrow("down");
      await renderOnce();
      const scrolled = captureCharFrame();
      // Scrolled by the minimum needed rather than recentring.
      expect(scrolled.includes("@session-10")).toBe(true);
      expect(scrolled.includes("@session-3")).toBe(true);
      expect(scrolled.includes("@session-2")).toBe(false);

      // Selection wraps, and the window follows it back to the top.
      for (let i = 0; i < 5; i++) keys.pressArrow("down");
      await renderOnce();
      expect(captureCharFrame().includes("@session-1")).toBe(true);

      keys.pressEnter();
      await wait(60);
      expect(promptText()).toBe("s1 ");
    });

    test("no matches means no popup", async () => {
      await openWithCompletions();
      await keys.typeText("@zzz", 5);
      await wait(60);
      await renderOnce();
      expect(captureCharFrame().includes("@session")).toBe(false);
    });

    describe("slash commands", () => {
      test("/ lists the chat's own commands", async () => {
        await openWithCompletions();
        await keys.typeText("/", 5);
        await wait(60);
        await renderOnce();
        const frame = captureCharFrame();
        expect(frame.includes("/clear")).toBe(true);
        expect(frame.includes("/back")).toBe(true);
      });

      test("only at the start of the prompt", async () => {
        // Dates and fractions are not commands.
        await openWithCompletions();
        await keys.typeText("on 3/", 5);
        await wait(60);
        await renderOnce();
        expect(captureCharFrame().includes("/clear")).toBe(false);
      });

      test("/back leaves the chat", async () => {
        await openWithCompletions();
        await keys.typeText("/back", 5);
        await wait(60);
        keys.pressEnter();
        await wait(200);
        expect(wentBack).toBe(true);
        current = null; // the command disposed it
      });

      test("/clear asks first, and clearing empties the transcript and the log", async () => {
        let stored: ChatMessage[] = [
          { role: "user", content: "previous question" },
          { role: "assistant", content: "previous answer" },
        ];
        const chatLog: ChatLogStore = {
          load: async () => stored,
          save: async (m) => {
            stored = [...m];
          },
        };
        current = await makeChatScreen(renderer, {
          provider: okProvider,
          chatLog,
          onBack: () => {
            wentBack = true;
          },
        });
        renderer.root.add(current.node);
        current.focus?.();
        await renderOnce();
        expect(captureCharFrame().includes("previous answer")).toBe(true);

        await keys.typeText("/clear", 5);
        await wait(60);
        keys.pressEnter();
        await wait(100);
        await renderOnce();

        // Confirmation first — the history is still there.
        expect(captureCharFrame().includes("Clear this conversation?")).toBe(true);
        expect(stored).toHaveLength(2);

        // Cancel is focused by default; Tab moves to Clear.
        keys.pressTab();
        keys.pressEnter();
        await wait(200);
        await renderOnce();

        const frame = captureCharFrame();
        expect(frame.includes("previous answer")).toBe(false);
        expect(frame.includes("Clear this conversation?")).toBe(false);
        expect(stored).toEqual([]);
        // The command text was taken back out of the prompt.
        expect(promptText()).toBe("");
      });

      test("Escape in the clear dialog cancels without leaving the chat", async () => {
        await openWithCompletions();
        await keys.typeText("/clear", 5);
        await wait(60);
        keys.pressEnter();
        await wait(100);
        await renderOnce();
        expect(captureCharFrame().includes("Clear this conversation?")).toBe(true);

        keys.pressKey("ESCAPE");
        await wait(500);
        await renderOnce();
        expect(captureCharFrame().includes("Clear this conversation?")).toBe(false);
        expect(wentBack).toBe(false);
      });
    });
  });

  test("resumes a saved conversation and persists new messages", async () => {
    let stored: ChatMessage[] = [
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ];
    const chatLog: ChatLogStore = {
      load: async () => stored,
      save: async (m) => {
        stored = [...m];
      },
    };

    current = await makeChatScreen(renderer, { provider: okProvider, chatLog, onBack: () => {} });
    renderer.root.add(current.node);
    current.focus?.();
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame.includes("previous question")).toBe(true);
    expect(frame.includes("previous answer")).toBe(true);

    // sending a message persists it through the chat log
    await keys.typeText("new msg", 5);
    keys.pressEnter();
    await wait();
    await renderOnce();
    expect(stored.some((m) => m.content === "new msg")).toBe(true);
  });
});

describe("model header", () => {
  test("upgrades from the bare id to name/usage/context/price once modelInfo and usage arrive", async () => {
    const provider: ChatProvider = {
      async *streamChat() {
        yield { type: "text", delta: "hi" };
        yield {
          type: "usage",
          usage: { promptTokens: 6400, completionTokens: 1600, totalTokens: 8000 },
        };
      },
    };

    current = await makeChatScreen(renderer, {
      provider,
      model: "gpt-4o-mini",
      modelInfo: Promise.resolve({
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        contextLength: 128000,
        pricing: { promptPerToken: 0.00000015, completionPerToken: 0.0000006 },
      }),
      onBack: () => {},
    });
    renderer.root.add(current.node);
    current.focus?.();
    await renderOnce();

    await keys.typeText("hello", 5);
    keys.pressEnter();
    await wait();
    await renderOnce();

    const frame = captureCharFrame();
    expect(frame.includes("GPT-4o Mini")).toBe(true);
    expect(frame.includes("8k/128k")).toBe(true);
    expect(frame.includes("6%")).toBe(true); // 8000 / 128000
    expect(frame.includes("$0.0")).toBe(true);
  });

  test("falls back to the raw token count when context length is unknown", async () => {
    const provider: ChatProvider = {
      async *streamChat() {
        yield { type: "text", delta: "hi" };
        yield { type: "usage", usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
      },
    };

    current = await makeChatScreen(renderer, {
      provider,
      model: "local-model",
      onBack: () => {},
    });
    renderer.root.add(current.node);
    current.focus?.();
    await renderOnce();

    await keys.typeText("hello", 5);
    keys.pressEnter();
    await wait();
    await renderOnce();

    const frame = captureCharFrame();
    expect(frame.includes("local-model")).toBe(true);
    expect(frame.includes("120 tokens")).toBe(true);
  });
});
