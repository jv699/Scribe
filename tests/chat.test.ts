import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, createMockKeys, type TestRenderer } from "@opentui/core/testing";
import { makeChatScreen, type ChatLogStore } from "../src/screens/chat.ts";
import type { Screen } from "../src/screens/screen.ts";
import type { ChatEvent, ChatMessage, ChatProvider } from "../src/provider/types.ts";
import type { AgentTool } from "../src/agent/loop.ts";

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

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 });
  renderer = setup.renderer;
  captureCharFrame = setup.captureCharFrame;
  renderOnce = setup.renderOnce;
  keys = createMockKeys(renderer);
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
    // both lines landed in a single message (adjacent rows, no blank line between)
    expect(/first line[^\n]*\n ?second line/.test(frame)).toBe(true);
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
    // markdown parses async — give it a beat before asserting the transcript
    await wait();
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
