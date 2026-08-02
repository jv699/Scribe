import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing";
import { TorchSpinnerRenderable } from "../src/torch-spinner.ts";

let renderer: TestRenderer;
let captureCharFrame: () => string;
let renderOnce: () => Promise<void>;
const spinners: TorchSpinnerRenderable[] = [];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  const setup = await createTestRenderer({ width: 40, height: 10 });
  renderer = setup.renderer;
  captureCharFrame = setup.captureCharFrame;
  renderOnce = setup.renderOnce;
  spinners.length = 0;
});

afterEach(() => {
  for (const spinner of spinners) spinner.stop();
  renderer.destroy();
});

function makeSpinner(frameMs?: number): TorchSpinnerRenderable {
  const spinner = new TorchSpinnerRenderable(renderer, { marginRight: 1, ...(frameMs ? { frameMs } : {}) });
  spinners.push(spinner);
  return spinner;
}

const FLAME = /[\u2800-\u28FF]/;

describe("torch spinner", () => {
  test("starts hidden so it never leaves a gap while idle", async () => {
    const spinner = makeSpinner();
    renderer.root.add(spinner);
    await renderOnce();
    expect(spinner.visible).toBe(false);
    expect(captureCharFrame().trim()).toBe("");
  });

  test("start() shows a flame and stop() hides it", async () => {
    const spinner = makeSpinner();
    renderer.root.add(spinner);
    spinner.start();
    await renderOnce();
    expect(spinner.visible).toBe(true);
    expect(captureCharFrame().match(FLAME)).not.toBeNull();

    spinner.stop();
    await renderOnce();
    expect(spinner.visible).toBe(false);
    expect(captureCharFrame().match(FLAME)).toBeNull();
  });

  test("start() animates through flame frames", async () => {
    const spinner = makeSpinner(20);
    renderer.root.add(spinner);
    spinner.start();
    // Sample across a few ticks (90ms apart, not aligned to the frame cycle)
    // and require more than one distinct flame glyph to appear.
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      await renderOnce();
      seen.add(captureCharFrame().match(FLAME)?.[0] ?? "");
      await wait(90);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
