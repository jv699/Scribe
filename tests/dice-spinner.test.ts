import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing";
import { DiceSpinnerRenderable } from "../src/dice-spinner.ts";

let renderer: TestRenderer;
let captureCharFrame: () => string;
let renderOnce: () => Promise<void>;
const spinners: DiceSpinnerRenderable[] = [];

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

function makeSpinner(frameMs?: number): DiceSpinnerRenderable {
  const spinner = new DiceSpinnerRenderable(renderer, { marginRight: 1, ...(frameMs ? { frameMs } : {}) });
  spinners.push(spinner);
  return spinner;
}

const DIE = /[⚀⚁⚂⚃⚄⚅]/;

describe("dice spinner", () => {
  test("starts hidden so it never leaves a gap while idle", async () => {
    const spinner = makeSpinner();
    renderer.root.add(spinner);
    await renderOnce();
    expect(spinner.visible).toBe(false);
    expect(captureCharFrame().trim()).toBe("");
  });

  test("start() shows a die face and stop() clears it", async () => {
    const spinner = makeSpinner();
    renderer.root.add(spinner);
    spinner.start();
    await renderOnce();
    expect(spinner.visible).toBe(true);
    expect(captureCharFrame().match(DIE)).not.toBeNull();

    spinner.stop();
    await renderOnce();
    expect(spinner.visible).toBe(false);
    expect(captureCharFrame().match(DIE)).toBeNull();
  });

  test("start() rolls through the faces", async () => {
    const spinner = makeSpinner(20);
    renderer.root.add(spinner);
    spinner.start();
    // Sample across several ticks and require more than one distinct face.
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      await renderOnce();
      seen.add(captureCharFrame().match(DIE)?.[0] ?? "");
      await wait(70);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
