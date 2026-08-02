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

const FLAME = /[▀▄]/;

describe("torch spinner", () => {
  test("starts hidden so it never leaves a gap while idle", async () => {
    const spinner = makeSpinner();
    renderer.root.add(spinner);
    await renderOnce();
    expect(spinner.visible).toBe(false);
    expect(captureCharFrame().trim()).toBe("");
  });

  test("start() draws a flame and stop() clears it", async () => {
    const spinner = makeSpinner();
    renderer.root.add(spinner);
    spinner.start();
    await renderOnce();
    expect(spinner.visible).toBe(true);
    expect(spinner.spinning).toBe(true);
    expect(captureCharFrame().match(FLAME)).not.toBeNull();

    spinner.stop();
    await renderOnce();
    expect(spinner.visible).toBe(false);
    expect(spinner.spinning).toBe(false);
    expect(captureCharFrame().match(FLAME)).toBeNull();
  });

  test("start() animates through flame frames", async () => {
    const spinner = makeSpinner(40);
    renderer.root.add(spinner);
    spinner.start();
    // Sample across several ticks and require more than one distinct flame shape.
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      await renderOnce();
      seen.add(captureCharFrame().split("\n").slice(0, 4).join(""));
      await wait(60);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
