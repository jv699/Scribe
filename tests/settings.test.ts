import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { InputRenderable, type Renderable } from "@opentui/core";
import { type createMockKeys, type TestRenderer } from "@opentui/core/testing";
import { setupRenderer, wait } from "./helpers/renderer.ts";
import { makeSettingsScreen } from "../src/screens/settings.ts";
import type { Screen } from "../src/screens/screen.ts";
import { expandHome, loadSettings, type Settings } from "../src/store/settings.ts";

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

async function open(
  settings: Settings,
  onSaved: (next: Settings) => void | Promise<void> = (next) => {
    saved = next;
  },
): Promise<void> {
  current = await makeSettingsScreen(renderer, {
    settings,
    onSaved,
    onBack: () => {
      wentBack = true;
    },
  });
  renderer.root.add(current.node);
  current.focus?.();
  await renderOnce();
}

function settingsInputs(): InputRenderable[] {
  const found: InputRenderable[] = [];
  const visit = (node: Renderable): void => {
    if (node instanceof InputRenderable) found.push(node);
    for (const child of node.getChildren()) visit(child as Renderable);
  };
  if (current) visit(current.node);
  return found;
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
    await open({
      campaignsDir: "/tmp/x",
      oneshotsDir: "/tmp/o",
      sourcesDir: "/tmp/s",
      model: "llama3.1",
      systemPromptOverride: "/tmp/campaign-core.md",
      oneshotPromptOverride: "/tmp/oneshot-core.md",
    });

    await keys.typeText("https://ollama.local/v1", 5); // base URL
    await keys.pressKeys(["TAB"], 20); // -> model
    await keys.pressKeys(["TAB", "TAB", "TAB", "TAB", "TAB"], 20); // -> key, dir, one-shots, sources, Save
    keys.pressEnter();
    await wait();

    expect(saved?.baseUrl).toBe("https://ollama.local/v1");
    expect(saved?.model).toBe("llama3.1");
    expect(saved?.campaignsDir).toBe("/tmp/x"); // untouched field preserved
    expect(saved?.oneshotsDir).toBe("/tmp/o"); // untouched field preserved
    expect(saved?.sourcesDir).toBe("/tmp/s"); // untouched field preserved
    expect(saved?.systemPromptOverride).toBe("/tmp/campaign-core.md");
    expect(saved?.oneshotPromptOverride).toBe("/tmp/oneshot-core.md");
  });

  test("reports asynchronous save failures and allows retry", async () => {
    let attempts = 0;
    await open(
      { campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" },
      async () => {
        attempts++;
        throw new Error("config is read-only");
      },
    );

    await keys.pressKeys(["TAB", "TAB", "TAB", "TAB", "TAB", "TAB"], 10);
    keys.pressEnter();
    await wait(60);
    await renderOnce();
    expect(captureCharFrame()).toContain("config is read-only");

    keys.pressEnter();
    await wait(60);
    expect(attempts).toBe(2);
  });

  test("typing in the model field loads suggestions and Enter picks then advances", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") {
          return new Response(
            JSON.stringify({
              data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini", name: "GPT-4o Mini", context_length: 128000 }],
            }),
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

      await keys.pressKeys(["TAB"], 20); // -> model
      await keys.typeText("gpt-4o", 5);
      await wait();
      await renderOnce();

      let frame = captureCharFrame();
      expect(frame.includes("gpt-4o-mini")).toBe(true);
      expect(frame.includes("GPT-4o Mini · 128k ctx")).toBe(true);
      expect(frame.includes("Browse...")).toBe(false);

      keys.pressEnter(); // pick the first (alphabetically: gpt-4o)
      await wait();
      await renderOnce();

      frame = captureCharFrame();
      expect(frame.includes("gpt-4o")).toBe(true);
      expect(frame.includes("gpt-4o-mini")).toBe(false);
      expect(renderer.currentFocusedRenderable).toBe(settingsInputs()[2]!);
    } finally {
      server.stop();
    }
  });

  test("model suggestions filter locally, wrap selection, and Tab accepts", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/v1/models") {
          requests++;
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

      await keys.pressKeys(["TAB"], 20); // -> model
      await keys.typeText("beta", 5);
      await wait();
      await renderOnce();
      let frame = captureCharFrame();
      expect(frame.includes("beta-two")).toBe(true);
      expect(frame.includes("alpha-one")).toBe(false);
      expect(frame.includes("gamma-three")).toBe(false);
      expect(requests).toBe(1);

      // A query matching nothing empties the list rather than leaving it stale.
      await keys.typeText("zzz", 5);
      await wait();
      await renderOnce();
      frame = captureCharFrame();
      expect(frame.includes("beta-two")).toBe(false);
      expect(frame).toContain("betazzz");
      expect(frame).toContain("No matching models");

      // Clear the filter, then arrow up from the first row: selection wraps to
      // the last model, so Tab picks it.
      await keys.pressKeys(Array(7).fill("BACKSPACE"), 10);
      await wait();
      await renderOnce();
      frame = captureCharFrame();
      expect(frame.includes("alpha-one") && frame.includes("gamma-three")).toBe(true);
      expect(requests).toBe(1);

      await keys.pressKeys(["ARROW_UP"], 20);
      keys.pressKey("TAB");
      await wait();
      await renderOnce();

      frame = captureCharFrame();
      expect(frame.includes("gamma-three")).toBe(true);
      expect(frame.includes("alpha-one")).toBe(false);
      expect(renderer.currentFocusedRenderable).toBe(settingsInputs()[1]!);

      // The accepting Tab leaves focus in the field; the next Tab advances.
      keys.pressKey("TAB");
      await wait();
      await keys.typeText("MY_API_KEY", 5);
      await renderOnce();
      expect(captureCharFrame()).toContain("MY_API_KEY");
    } finally {
      server.stop();
    }
  });

  test("Shift+Tab traverses backward without accepting a model suggestion", async () => {
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

      keys.pressTab();
      await keys.typeText("gpt", 5);
      await wait();
      await renderOnce();
      expect(captureCharFrame()).toContain("gpt-4o");

      keys.pressTab({ shift: true });
      await wait();
      await renderOnce();

      const [baseInput, modelInput] = settingsInputs();
      expect(renderer.currentFocusedRenderable).toBe(baseInput!);
      expect(modelInput?.value).toBe("gpt");
      expect(captureCharFrame()).not.toContain("gpt-4o");
    } finally {
      server.stop();
    }
  });

  test("escape closes inline suggestions before leaving the settings screen", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/v1/models") {
          return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "second-model" }] }), {
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
      await keys.typeText("m", 5);
      await wait();
      await renderOnce();
      expect(captureCharFrame()).toContain("second-model");

      keys.pressKey("ESCAPE");
      await wait();
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame.includes("second-model")).toBe(false);
      expect(frame.includes("Base URL")).toBe(true); // settings screen still up
      expect(wentBack).toBe(false);

      keys.pressKey("ESCAPE");
      await wait();
      expect(wentBack).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("a model request finishing after disposal cannot open stale suggestions", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/v1/models") {
          await Bun.sleep(150);
          return new Response(JSON.stringify({ data: [{ id: "late-model" }] }), {
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
      await keys.pressKeys(["TAB"], 20);
      await keys.typeText("late", 5);
      await wait(30);

      keys.pressKey("ESCAPE"); // dismiss the loading dropdown
      await wait(30);
      keys.pressKey("ESCAPE");
      await wait(30);
      expect(wentBack).toBe(true);
      renderer.root.remove(current!.node);
      current!.node.destroyRecursively();

      await wait(250);
      await renderOnce();
      expect(captureCharFrame()).not.toContain("late-model");
    } finally {
      server.stop();
    }
  });

  test("changing provider settings invalidates the cached model listing", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        requests++;
        const path = new URL(req.url).pathname;
        if (path === "/a/models") {
          return new Response(JSON.stringify({ data: [{ id: "alpha-model" }] }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (path === "/b/models") {
          return new Response(JSON.stringify({ data: [{ id: "beta-model" }] }), {
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
        baseUrl: `http://localhost:${server.port}/a`,
      });

      keys.pressTab();
      await keys.typeText("alpha", 5);
      await wait();
      await renderOnce();
      expect(captureCharFrame()).toContain("alpha-model");
      keys.pressEnter();
      await wait();

      const [baseInput, modelInput] = settingsInputs();
      baseInput!.value = `http://localhost:${server.port}/b`;
      modelInput!.focus();
      modelInput!.value = "beta";
      await wait();
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain("beta-model");
      expect(frame).not.toContain("alpha-model");
      expect(requests).toBe(2);
    } finally {
      server.stop();
    }
  });

  test("provider failures leave manual model ids editable and retry on the next edit", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/v1/models") {
          requests++;
          return new Response("listing unavailable", { status: 503 });
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

      keys.pressTab();
      await keys.typeText("custom-model", 5);
      await wait();
      await renderOnce();
      let frame = captureCharFrame();
      expect(frame).toContain("custom-model");
      expect(frame).toContain("Failed to list models (503)");
      expect(requests).toBe(1);

      await wait(550);
      await keys.typeText("-2", 5);
      await wait();
      await renderOnce();
      frame = captureCharFrame();
      expect(frame).toContain("custom-model-2");
      expect(requests).toBe(2);
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
    const expanded = expandHome("~/My One-Shots");
    expect(expanded).toBe(join(homedir(), "My One-Shots"));
    expect(expanded.startsWith("~")).toBe(false);
  });

  test("defaults sourcesDir to <home>/Scribe/Sources", async () => {
    const settings = await loadSettings(join(tmp, "config.json"));
    expect(settings.sourcesDir).toBe(join(homedir(), "Scribe", "Sources"));
  });

  test("expands a ~/... custom sourcesDir value", async () => {
    const expanded = expandHome("~/My Sources");
    expect(expanded).toBe(join(homedir(), "My Sources"));
    expect(expanded.startsWith("~")).toBe(false);
  });
});
