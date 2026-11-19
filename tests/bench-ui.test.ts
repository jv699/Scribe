import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startBench, type Bench, type StartBenchOptions } from "../src/bench/run.ts";
import type { ChatProvider } from "../src/provider/types.ts";
import { makeBenchScreen, type BenchScreenOptions } from "../src/screens/bench.ts";
import type { Screen } from "../src/screens/screen.ts";
import type { Settings } from "../src/store/settings.ts";
import { RGBA } from "@opentui/core";
import { theme } from "../src/theme.ts";
import { setupRenderer, wait, type RendererHarness } from "./helpers/renderer.ts";

let renderer: RendererHarness["renderer"];
let keys: RendererHarness["keys"];
let captureCharFrame: RendererHarness["captureCharFrame"];
let cellAt: RendererHarness["cellAt"];
let renderOnce: RendererHarness["renderOnce"];
let dir: string;
let settings: Settings;
let screen: Screen | null = null;
let realConfigDir: string | undefined;

beforeEach(async () => {
  ({ renderer, keys, captureCharFrame, cellAt, renderOnce } = await setupRenderer({ width: 100, height: 30 }));
  dir = await mkdtemp(join(tmpdir(), "scribe-bench-ui-"));
  realConfigDir = process.env["SCRIBE_CONFIG_DIR"];
  process.env["SCRIBE_CONFIG_DIR"] = join(dir, "config");
  settings = {
    campaignsDir: join(dir, "Scribe"),
    oneshotsDir: join(dir, "Scribe", "One-Shots"),
    sourcesDir: join(dir, "Scribe", "Sources"),
    benchDir: join(dir, "Scribe", "Bench"),
    model: "m1",
  };
});

afterEach(async () => {
  screen?.dispose?.();
  screen = null;
  renderer.destroy();
  if (realConfigDir === undefined) delete process.env["SCRIBE_CONFIG_DIR"];
  else process.env["SCRIBE_CONFIG_DIR"] = realConfigDir;
  await rm(dir, { recursive: true, force: true });
});

const answering: ChatProvider = {
  async *streamChat() {
    yield { type: "usage", usage: { promptTokens: 2000, completionTokens: 300, totalTokens: 2300 } };
    yield { type: "text", delta: "# The Sky-Barge Job\n\nA heist in the clouds." };
  },
};

const hanging: ChatProvider = {
  async *streamChat(_messages, options) {
    await new Promise<void>((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  },
};

async function mount(
  provider: ChatProvider,
  overrides: Partial<BenchScreenOptions> = {},
): Promise<{ benches: Bench[]; backs: () => number }> {
  const benches: Bench[] = [];
  let backs = 0;
  screen = await makeBenchScreen(renderer, {
    settings,
    onBack: () => backs++,
    checkProvider: async () => null,
    loadModels: async () => [{ id: "m1", pricing: { promptPerToken: 0.000001, completionPerToken: 0.000004 } }],
    startBench: (options: StartBenchOptions) => {
      const bench = startBench({ ...options, createProvider: () => provider });
      benches.push(bench);
      return bench;
    },
    ...overrides,
  });
  renderer.root.add(screen.node);
  screen.focus?.();
  await renderOnce();
  return { benches, backs: () => backs };
}

/** Sidebar → + Add Model (a new entry from Settings) → Save (Enter in the model field saves and checks). */
async function checkFirstModel(): Promise<void> {
  keys.pressArrow("down");
  keys.pressEnter();
  await wait(50);
  keys.pressTab();
  keys.pressTab();
  keys.pressEnter();
  await wait(150);
}

/** Back to the sidebar, open the flight deck, type the prompt, and confirm the run. */
async function runPrompt(prompt: string): Promise<void> {
  keys.pressKey("ESCAPE");
  // A lone ESC byte waits briefly to see whether a sequence follows it.
  await wait(50);
  keys.pressArrow("up");
  keys.pressEnter();
  await wait(50);
  await keys.typeText(prompt);
  keys.pressEnter();
  await wait(150);
}

/** The background behind `text` in the sidebar (its first 32 columns). */
const bgAt = (text: string): RGBA => cellAt(text, 32).bg;

describe("ScribeBench screen", () => {
  test("starts with no models and points at Add Model", async () => {
    await mount(answering);
    const frame = captureCharFrame();
    expect(frame).toContain("ScribeBench");
    expect(frame).toContain("Flight Deck");
    expect(frame).toContain("+ Add Model");
    expect(frame).not.toContain("○");
    expect(frame).toContain("0 of 0 ready");
    expect(frame).toContain("Add a model from the sidebar to get started.");
  });

  test("Add Model creates an unchecked entry from the settings", async () => {
    await mount(answering);
    keys.pressArrow("down");
    keys.pressEnter();
    await wait(50);
    const frame = captureCharFrame();
    expect(frame).toContain("○ m1");
    expect(frame).toContain("Model 1");
  });

  test("sending with no models turns the prompt hint into a red warning until the next edit", async () => {
    const { benches } = await mount(answering);
    keys.pressEnter(); // open the flight deck
    await wait(50);
    await keys.typeText("Plan a heist");
    keys.pressEnter();
    await wait(50);
    expect(captureCharFrame()).toContain("Add a model in the sidebar first");
    expect(benches).toHaveLength(0);
    expect(cellAt("Add a model in the sidebar first").fg.equals(RGBA.fromHex(theme.danger))).toBe(true);

    await keys.typeText("!");
    await wait(50);
    expect(captureCharFrame()).not.toContain("Add a model in the sidebar first");
    expect(captureCharFrame()).toContain("Enter runs every ready model");
  });

  test("the open screen keeps a darker bar while its pane has focus", async () => {
    await mount(answering);
    const accent = RGBA.fromHex(theme.accent);
    const dark = RGBA.fromHex(theme.accentDark);
    // The focused list shows its cursor in the full accent.
    expect(bgAt("Flight Deck").equals(accent)).toBe(true);
    // Opening a model moves focus into its pane; its row keeps the darker bar.
    keys.pressArrow("down");
    keys.pressEnter();
    await wait(50);
    expect(bgAt("○ m1").equals(dark)).toBe(true);
    expect(bgAt("Flight Deck").equals(dark)).toBe(false);
  });

  test("saving a model checks it, and a passing check makes it ready", async () => {
    await mount(answering);
    await checkFirstModel();
    const frame = captureCharFrame();
    expect(frame).toContain("✓ connected");
    expect(frame).toContain("✓ m1");
  });

  test("a failed check says why, and no run starts without a ready model", async () => {
    const { benches } = await mount(answering, { checkProvider: async () => "The provider rejected the API key." });
    await checkFirstModel();
    expect(captureCharFrame()).toContain("✗ failed");
    expect(captureCharFrame()).toContain("The provider rejected the API key.");

    await runPrompt("Plan a heist");
    expect(captureCharFrame()).toContain("No model is ready");
    expect(benches).toHaveLength(0);
  });

  test("a mistyped key variable name is refused but left to fix", async () => {
    await mount(answering);
    keys.pressArrow("down");
    keys.pressEnter(); // add a model; focus lands on its base URL
    await wait(50);
    keys.pressTab(); // -> key env var
    await keys.typeText("MY-KEY");
    keys.pressTab(); // -> model
    keys.pressEnter(); // save
    await wait(50);
    const frame = captureCharFrame();
    expect(frame).toContain("can only use letters, digits");
    expect(frame).toContain("MY-KEY");
  });

  test("a model-list error stays up through the repaints a running bench makes", async () => {
    const { benches } = await mount(hanging, {
      loadModels: async () => {
        throw new Error("listing broke");
      },
    });
    await checkFirstModel();
    await runPrompt("Plan a heist");
    keys.pressTab();
    keys.pressEnter();
    await wait(100);
    expect(benches[0]!.runs[0]!.status).toBe("thinking");

    // Add a second model and edit its model field, which loads the provider's list.
    keys.pressKey("ESCAPE");
    await wait(50);
    keys.pressArrow("down");
    keys.pressArrow("down");
    keys.pressEnter();
    await wait(50);
    keys.pressTab();
    keys.pressTab();
    await keys.typeText("x");
    await wait(100);
    expect(captureCharFrame()).toContain("listing broke");
    // The 1 s ticker repaints the open pane while the first run goes on.
    await wait(1200);
    expect(captureCharFrame()).toContain("listing broke");
  });

  test("cancelling the Ctrl+C question asks again on the next Ctrl+C", async () => {
    const mounted = await mount(hanging);
    await checkFirstModel();
    await runPrompt("Plan a heist");
    keys.pressTab();
    keys.pressEnter();
    await wait(100);

    let quits = 0;
    const quit = (): void => {
      quits++;
    };
    expect(screen!.handleInterrupt!(quit)).toBe("handled");
    await wait(50);
    expect(captureCharFrame()).toContain("Stop 1 running model and quit?");
    keys.pressKey("ESCAPE"); // dismiss
    await wait(100);
    expect(captureCharFrame()).not.toContain("Stop 1 running model and quit?");

    expect(screen!.handleInterrupt!(quit)).toBe("handled");
    await wait(50);
    expect(captureCharFrame()).toContain("Stop 1 running model and quit?");
    expect(quits).toBe(0);
    expect(mounted.benches[0]!.runs[0]!.status).toBe("thinking");
  });

  test("a confirmed run fills the tiles and the model's transcript, and saves the result", async () => {
    const { benches } = await mount(answering);
    await checkFirstModel();
    await runPrompt("Plan a heist on a sky-barge");

    const confirm = captureCharFrame();
    expect(confirm).toContain("Run 1 model on this prompt?");
    expect(confirm).toContain("$1.00 in / $4.00 out per 1M");
    expect(confirm).toContain("At least $");
    // Cancel holds focus; Tab moves to Run.
    keys.pressTab();
    keys.pressEnter();
    await benches[0]!.done;
    await wait(100);

    const deck = captureCharFrame();
    expect(deck).toContain("done ·");
    // 2000 prompt tokens at $1/M + 300 completion tokens at $4/M, on its own row and in the total.
    expect(deck).toMatch(/│ \$0\.0032 +│/);
    expect(deck).toContain("Total cost: $0.0032");
    expect(deck).toContain("Thought ·");
    expect(deck).toContain("✓ m1");

    keys.pressKey("ESCAPE");
    await wait(50);
    keys.pressArrow("down");
    keys.pressEnter();
    await wait(100);
    const transcript = captureCharFrame();
    expect(transcript).toContain("The Sky-Barge Job");
    expect(transcript).toContain("Edit model");
    expect(transcript).not.toContain("one-shot");

    const folder = benches[0]!.folder()!;
    expect((await readdir(folder)).sort()).toEqual(["m1.md", "prompt.md"]);
  });

  test("leaving mid-run asks first, then cancels what is running", async () => {
    const mounted = await mount(hanging);
    await checkFirstModel();
    await runPrompt("Plan a heist");
    keys.pressTab();
    keys.pressEnter();
    await wait(100);
    const run = mounted.benches[0]!.runs[0]!;
    expect(run.status).toBe("thinking");

    keys.pressKey("ESCAPE");
    await wait(50);
    keys.pressKey("ESCAPE");
    await wait(50);
    expect(captureCharFrame()).toContain("Stop 1 running model and leave?");
    expect(mounted.backs()).toBe(0);
    keys.pressTab();
    keys.pressEnter();
    await mounted.benches[0]!.done;
    expect(mounted.backs()).toBe(1);
    expect(run.status).toBe("cancelled");
  });

  test("disposing the screen cancels its runs", async () => {
    const mounted = await mount(hanging);
    await checkFirstModel();
    await runPrompt("Plan a heist");
    keys.pressTab();
    keys.pressEnter();
    await wait(100);
    screen?.dispose?.();
    screen = null;
    await mounted.benches[0]!.done;
    expect(mounted.benches[0]!.runs[0]!.status).toBe("cancelled");
  });
});
