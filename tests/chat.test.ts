import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, createMockKeys, type TestRenderer } from "@opentui/core/testing";
import { makeChatScreen } from "../src/screens/chat.ts";
import type { Screen } from "../src/screens/screen.ts";
import type { ChatProvider } from "../src/provider/types.ts";

let renderer: TestRenderer;
let captureCharFrame: () => string;
let renderOnce: () => Promise<void>;
let keys: ReturnType<typeof createMockKeys>;
let current: Screen | null = null;
let wentBack = false;

const okProvider: ChatProvider = {
  async *streamChat() {
    for (const chunk of ["Hel", "lo ", "world"]) yield chunk;
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
    expect(frame.includes("You:")).toBe(true);
    expect(frame.includes("hello")).toBe(true);
    expect(frame.includes("world")).toBe(true);
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
});
