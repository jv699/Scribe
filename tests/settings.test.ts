import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type createMockKeys, type TestRenderer } from "@opentui/core/testing";
import { setupRenderer, wait } from "./helpers/renderer.ts";
import { makeSettingsScreen } from "../src/screens/settings.ts";
import type { Screen } from "../src/screens/screen.ts";
import { loadSettings, type Settings } from "../src/store/settings.ts";

let renderer: TestRenderer;
let captureCharFrame: () => string;
let renderOnce: () => Promise<void>;
let keys: ReturnType<typeof createMockKeys>;
let current: Screen | null = null;
let saved: Settings | null = null;
let wentBack = false;


beforeEach(async () => {
  ({ renderer, keys, captureCharFrame, renderOnce } = await setupRenderer({ width: 90, height: 24 }));
  current = null;
  saved = null;
  wentBack = false;
});

afterEach(() => {
  current?.dispose?.();
  renderer.destroy();
});

async function open(settings: Settings): Promise<void> {
  current = await makeSettingsScreen(renderer, {
    settings,
    onSaved: (s) => {
      saved = s;
    },
    onBack: () => {
      wentBack = true;
    },
  });
  renderer.root.add(current.node);
  current.focus?.();
  await renderOnce();
}

describe("settings screen", () => {
  test("renders fields prefilled from settings and accepts typing", async () => {
    await open({
      campaignsDir: "/tmp/x",
      oneshotsDir: "/tmp/o",
      sourcesDir: "/tmp/s",
      baseUrl: "https://localhost:11434/v1",
      model: "llama3.1",
    });

    let frame = captureCharFrame();
    expect(frame.includes("Base URL")).toBe(true);
    expect(frame.includes("https://localhost:11434/v1")).toBe(true);
    expect(frame.includes("llama3.1")).toBe(true);
    expect(frame.includes("/tmp/x")).toBe(true);
    expect(frame.includes("/tmp/s")).toBe(true);
    expect(frame.includes(".config/scribe")).toBe(true);

    await keys.typeText("http://other/v1", 5);
    await wait();
    await renderOnce();
    frame = captureCharFrame();
    expect(frame.includes("http://other/v1")).toBe(true);
  });

  test("saves edited values", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });

    await keys.typeText("https://ollama.local/v1", 5); // base URL
    await keys.pressKeys(["TAB"], 20); // -> model
    await keys.typeText("llama3.1", 5);
    await keys.pressKeys(["TAB", "TAB", "TAB", "TAB", "TAB", "TAB"], 20); // -> browse, key, dir, one-shots, sources, Save
    keys.pressEnter();
    await wait();

    expect(saved?.baseUrl).toBe("https://ollama.local/v1");
    expect(saved?.model).toBe("llama3.1");
    expect(saved?.campaignsDir).toBe("/tmp/x"); // untouched field preserved
    expect(saved?.oneshotsDir).toBe("/tmp/o"); // untouched field preserved
    expect(saved?.sourcesDir).toBe("/tmp/s"); // untouched field preserved
  });

  test("browse fetches models and picking one fills the model field", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") {
          return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await open({
        campaignsDir: "/tmp/x",
        oneshotsDir: "/tmp/o",
        sourcesDir: "/tmp/s",
        baseUrl: `http://localhost:${server.port}/v1`,
      });

      await keys.pressKeys(["TAB"], 20); // -> model
      await keys.pressKeys(["TAB"], 20); // -> Browse...
      keys.pressEnter();
      await wait();
      await renderOnce();

      let frame = captureCharFrame();
      expect(frame.includes("Select a model")).toBe(true);
      expect(frame.includes("gpt-4o-mini")).toBe(true);

      keys.pressEnter(); // pick the first (alphabetically: gpt-4o)
      await wait();
      await renderOnce();

      frame = captureCharFrame();
      expect(frame.includes("Select a model")).toBe(false);
      expect(frame.includes("gpt-4o")).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("the model picker filters as you type and wraps arrow selection", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/v1/models") {
          // Ids deliberately unlike the Model field's "gpt-4o-mini" placeholder,
          // which sits behind the dialog and would otherwise match.
          return new Response(
            JSON.stringify({ data: [{ id: "alpha-one" }, { id: "beta-two" }, { id: "gamma-three" }] }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await open({
        campaignsDir: "/tmp/x",
        oneshotsDir: "/tmp/o",
        sourcesDir: "/tmp/s",
        baseUrl: `http://localhost:${server.port}/v1`,
      });

      await keys.pressKeys(["TAB", "TAB"], 20); // -> Browse...
      keys.pressEnter();
      await wait();
      await renderOnce();
      expect(captureCharFrame().includes("gamma-three")).toBe(true);

      // Typing narrows the list to matching ids.
      await keys.typeText("beta", 5);
      await wait();
      await renderOnce();
      let frame = captureCharFrame();
      expect(frame.includes("beta-two")).toBe(true);
      expect(frame.includes("alpha-one")).toBe(false);
      expect(frame.includes("gamma-three")).toBe(false);

      // A query matching nothing empties the list rather than leaving it stale.
      await keys.typeText("zzz", 5);
      await wait();
      await renderOnce();
      expect(captureCharFrame().includes("beta-two")).toBe(false);

      // Clear the filter, then arrow up from the first row: selection wraps to
      // the last model, so Enter picks it.
      await keys.pressKeys(Array(7).fill("BACKSPACE"), 10);
      await wait();
      await renderOnce();
      frame = captureCharFrame();
      expect(frame.includes("alpha-one") && frame.includes("gamma-three")).toBe(true);

      await keys.pressKeys(["ARROW_UP"], 20);
      keys.pressEnter();
      await wait();
      await renderOnce();

      frame = captureCharFrame();
      expect(frame.includes("Select a model")).toBe(false);
      // The model field now holds the last item, reached by wrapping upward.
      expect(frame.includes("gamma-three")).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("escape in the model picker closes only the picker, not the screen", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/v1/models") {
          return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      await open({
        campaignsDir: "/tmp/x",
        oneshotsDir: "/tmp/o",
        sourcesDir: "/tmp/s",
        baseUrl: `http://localhost:${server.port}/v1`,
      });

      await keys.pressKeys(["TAB", "TAB"], 20); // -> Browse...
      keys.pressEnter();
      await wait();
      await renderOnce();
      expect(captureCharFrame().includes("Select a model")).toBe(true);

      keys.pressKey("ESCAPE");
      await wait();
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame.includes("Select a model")).toBe(false);
      expect(frame.includes("Base URL")).toBe(true); // settings screen still up
      expect(wentBack).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("escape goes back without saving", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });
    await keys.typeText("zzz", 5);
    keys.pressKey("ESCAPE");
    await wait(500);
    expect(wentBack).toBe(true);
    expect(saved).toBeNull();
  });
});

describe("settings loadSettings", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "scribe-settings-"));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("defaults oneshotsDir to <home>/Scribe/One-Shots", async () => {
    const settings = await loadSettings(join(tmp, "config.json"));
    expect(settings.oneshotsDir).toBe(join(homedir(), "Scribe", "One-Shots"));
  });

  test("expands a ~/... custom oneshotsDir value", async () => {
    const configPath = join(tmp, "config.json");
    await Bun.write(
      configPath,
      JSON.stringify({ campaignsDir: "~/Scribe", oneshotsDir: "~/My One-Shots" }),
    );
    const settings = await loadSettings(configPath);
    expect(settings.oneshotsDir).toBe(join(homedir(), "My One-Shots"));
    expect(settings.oneshotsDir.startsWith("~")).toBe(false);
    // loadSettings mkdirs the expanded dir; remove the stray one we created
    await rm(settings.oneshotsDir, { recursive: true, force: true });
  });

  test("defaults sourcesDir to <home>/Scribe/Sources", async () => {
    const settings = await loadSettings(join(tmp, "config.json"));
    expect(settings.sourcesDir).toBe(join(homedir(), "Scribe", "Sources"));
  });

  test("expands a ~/... custom sourcesDir value", async () => {
    const configPath = join(tmp, "config.json");
    await Bun.write(
      configPath,
      JSON.stringify({ campaignsDir: "~/Scribe", oneshotsDir: "~/Scribe/One-Shots", sourcesDir: "~/My Sources" }),
    );
    const settings = await loadSettings(configPath);
    expect(settings.sourcesDir).toBe(join(homedir(), "My Sources"));
    expect(settings.sourcesDir.startsWith("~")).toBe(false);
    // loadSettings mkdirs the expanded dir; remove the stray one we created
    await rm(settings.sourcesDir, { recursive: true, force: true });
  });
});
