import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMockKeys, type TestRenderer } from "@opentui/core/testing";
import { setupRenderer, wait } from "./helpers/renderer.ts";
import { makePrompt, type Prompt } from "../src/components/prompt.ts";

let renderer: TestRenderer;
let captureCharFrame: () => string;
let renderOnce: () => Promise<void>;
let prompt: Prompt | null = null;


beforeEach(async () => {
  ({ renderer, captureCharFrame, renderOnce } = await setupRenderer({ width: 50, height: 8 }));
  prompt = null;
});

afterEach(() => {
  renderer.destroy();
});

function open(onSubmit: () => void): ReturnType<typeof createMockKeys> {
  prompt = makePrompt(renderer, { onSubmit });
  renderer.root.add(prompt.node);
  prompt.input.focus();
  return createMockKeys(renderer, { kittyKeyboard: true });
}

describe("prompt", () => {
  test("renders placeholder and hint footer", async () => {
    open(() => {});
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame.includes("Type a message…")).toBe(true);
    expect(frame.includes("Enter to send")).toBe(true);
  });

  test("Enter submits", async () => {
    const keys = open(() => {});
    let submitted = "";
    prompt!.input.onSubmit = () => {
      submitted = prompt!.input.plainText;
    };
    await keys.typeText("hello", 3);
    keys.pressEnter();
    await wait(20);
    expect(submitted).toBe("hello");
  });

  test("Shift+Enter adds a line instead of submitting", async () => {
    const keys = open(() => {});
    let submits = 0;
    prompt!.input.onSubmit = () => {
      submits += 1;
    };
    await keys.typeText("first", 3);
    keys.pressEnter({ shift: true });
    await wait(20);
    expect(submits).toBe(0);
    expect(prompt!.input.plainText).toBe("first\n");
  });
});
