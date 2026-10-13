import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InputRenderable, type Renderable } from "@opentui/core";
import { type createMockKeys, type TestRenderer } from "@opentui/core/testing";
import { homedir } from "node:os";
import { join } from "node:path";
import { setupRenderer, wait } from "./helpers/renderer.ts";
import { looksLikeApiKey, makeSettingsScreen } from "../src/screens/settings.ts";
import type { Screen } from "../src/screens/screen.ts";
import type { Settings } from "../src/store/settings.ts";

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

/** Answer the unsaved-changes dialog: Cancel holds focus, so Tab to Discard. */
async function confirmDiscard(ms = 300): Promise<void> {
  keys.pressKey("TAB");
  await wait(ms);
  keys.pressEnter();
  await wait(ms);
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
    await keys.pressKeys(["TAB"], 20); // -> key
    await keys.pressKeys(["TAB", "TAB", "TAB", "TAB", "TAB"], 20); // -> model, dir, one-shots, sources, Save
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

      await keys.pressKeys(["TAB", "TAB"], 20); // -> key -> model
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
      expect(renderer.currentFocusedRenderable).toBe(settingsInputs()[3]!);
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

      await keys.pressKeys(["TAB", "TAB"], 20); // -> key -> model
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
      expect(renderer.currentFocusedRenderable).toBe(settingsInputs()[2]!);

      // The accepting Tab leaves focus in the field; the next Tab advances.
      keys.pressKey("TAB");
      await wait();
      await keys.typeText("-next-field", 5);
      await renderOnce();
      expect(captureCharFrame()).toContain("/tmp/x-next-field");
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

      await keys.pressKeys(["TAB", "TAB"], 20); // -> key -> model
      await keys.typeText("gpt", 5);
      await wait();
      await renderOnce();
      expect(captureCharFrame()).toContain("gpt-4o");

      keys.pressTab({ shift: true });
      await wait();
      await renderOnce();

      const [, keyInput, modelInput] = settingsInputs();
      expect(renderer.currentFocusedRenderable).toBe(keyInput!);
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

      await keys.pressKeys(["TAB", "TAB"], 20); // -> key -> model
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

      // The typed filter is an unsaved edit, so leaving asks first.
      keys.pressKey("ESCAPE");
      await wait();
      expect(wentBack).toBe(false);
      await confirmDiscard();
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
      await keys.pressKeys(["TAB", "TAB"], 20); // -> key -> model
      await keys.typeText("late", 5);
      await wait(30);

      keys.pressKey("ESCAPE"); // dismiss the loading dropdown
      await wait(30);
      keys.pressKey("ESCAPE");
      await wait(30);
      await confirmDiscard(30);
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

      await keys.pressKeys(["TAB", "TAB"], 20); // -> key -> model
      await keys.typeText("alpha", 5);
      await wait();
      await renderOnce();
      expect(captureCharFrame()).toContain("alpha-model");
      keys.pressEnter();
      await wait();

      const [baseInput, , modelInput] = settingsInputs();
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

      await keys.pressKeys(["TAB", "TAB"], 20); // -> key -> model
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

  test("typing a provider name suggests its base URL, and Enter picks it and moves on", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s", apiKeyEnv: "OPENAI_API_KEY" });

    await keys.typeText("router", 5);
    await wait();
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame).toContain("https://openrouter.ai/api/v1");
    expect(frame).not.toContain("https://api.mistral.ai/v1");

    keys.pressEnter();
    await wait();
    await renderOnce();

    const [baseInput, keyInput] = settingsInputs();
    expect(baseInput?.value).toBe("https://openrouter.ai/api/v1");
    // The key variable is the user's to name; a preset never touches it.
    expect(keyInput?.value).toBe("OPENAI_API_KEY");
    expect(renderer.currentFocusedRenderable).toBe(keyInput!);
    frame = captureCharFrame();
    expect(frame).not.toContain("https://api.openai.com/v1");
  });

  test("Down browses every provider, starting on the current one, and Tab picks in place", async () => {
    await open({
      campaignsDir: "/tmp/x",
      oneshotsDir: "/tmp/o",
      sourcesDir: "/tmp/s",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
    });

    keys.pressKey("ARROW_DOWN");
    await wait();
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("OpenRouter");
    expect(frame).toContain("LM Studio (local)");

    // Browsing starts on the current provider (Groq); Ollama is five rows down.
    await keys.pressKeys(Array(5).fill("ARROW_DOWN"), 10);
    keys.pressKey("TAB");
    await wait();

    const [baseInput] = settingsInputs();
    expect(baseInput?.value).toBe("http://localhost:11434/v1");
    expect(renderer.currentFocusedRenderable).toBe(baseInput!);
  });

  test("a fully typed base URL leaves nothing to complete, so Tab moves on", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });

    await keys.typeText("https://api.openai.com/v1", 5);
    await wait();
    await renderOnce();
    expect(captureCharFrame()).not.toContain("OpenAI ");

    keys.pressKey("TAB");
    await wait();
    expect(renderer.currentFocusedRenderable).toBe(settingsInputs()[1]!);
  });

  test("escape closes the provider list before leaving the settings screen", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });

    keys.pressKey("ARROW_DOWN");
    await wait();
    await renderOnce();
    expect(captureCharFrame()).toContain("DeepSeek");

    keys.pressKey("ESCAPE");
    await wait();
    await renderOnce();
    expect(captureCharFrame()).not.toContain("DeepSeek");
    expect(wentBack).toBe(false);

    keys.pressKey("ESCAPE");
    await wait();
    expect(wentBack).toBe(true);
  });

  test("escape goes straight back when nothing was edited", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });
    keys.pressKey("ESCAPE");
    await wait();
    expect(wentBack).toBe(true);
    expect(saved).toBeNull();
  });

  test("escape with unsaved edits asks first, and Cancel returns to the edited field", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });
    await keys.typeText("zzz", 5);
    keys.pressKey("ESCAPE");
    await wait();
    await renderOnce();
    expect(captureCharFrame()).toContain("Discard changes to settings?");
    expect(wentBack).toBe(false);

    keys.pressEnter(); // Cancel holds focus
    await wait();
    await renderOnce();
    expect(captureCharFrame()).not.toContain("Discard changes to settings?");
    expect(wentBack).toBe(false);

    const [baseInput] = settingsInputs();
    expect(renderer.currentFocusedRenderable).toBe(baseInput!);
    expect(baseInput?.value).toBe("zzz");
  });

  test("confirming the discard leaves without saving", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });
    await keys.typeText("zzz", 5);
    keys.pressKey("ESCAPE");
    await wait();
    await confirmDiscard();
    expect(wentBack).toBe(true);
    expect(saved).toBeNull();
  });

  test("a pasted API key is refused, never saved, and taken off the screen", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });
    const [, keyInput] = settingsInputs();
    keyInput!.value = "sk-proj-abc123DEF456ghi789";

    await keys.pressKeys(["TAB", "TAB", "TAB", "TAB", "TAB", "TAB"], 10); // -> Save
    keys.pressEnter();
    await wait();
    await renderOnce();

    expect(saved).toBeNull();
    const frame = captureCharFrame();
    expect(frame).toContain("That looks like an API key");
    expect(frame).not.toContain("sk-proj");
    expect(keyInput?.value).toBe("");
    expect(renderer.currentFocusedRenderable).toBe(keyInput!);
  });

  test("a key variable that is not a valid name is refused but left to fix", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });
    const [, keyInput] = settingsInputs();
    keyInput!.value = "MY-KEY";

    await keys.pressKeys(["TAB", "TAB", "TAB", "TAB", "TAB", "TAB"], 10);
    keys.pressEnter();
    await wait();
    await renderOnce();

    expect(saved).toBeNull();
    expect(captureCharFrame()).toContain("can only use letters, digits, and underscores");
    expect(keyInput?.value).toBe("MY-KEY");
  });

  test("looksLikeApiKey tells keys from variable names", () => {
    expect(looksLikeApiKey("OPENROUTER_API_KEY")).toBe(false);
    expect(looksLikeApiKey("my_work_key")).toBe(false);
    expect(looksLikeApiKey("gsk_abcdef")).toBe(true);
    expect(looksLikeApiKey("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4")).toBe(true);
    // A name that resolves in the environment is a name, whatever it looks like.
    process.env["sk_local_test_variable_1"] = "x";
    try {
      expect(looksLikeApiKey("sk_local_test_variable_1")).toBe(false);
    } finally {
      delete process.env["sk_local_test_variable_1"];
    }
  });

  test("a relative directory is refused instead of resolving against the launch folder", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });
    const dirInput = settingsInputs()[3]!;
    dirInput.value = "~Scribe";

    await keys.pressKeys(Array(6).fill("TAB"), 10); // -> Save
    keys.pressEnter();
    await wait();
    await renderOnce();

    expect(saved).toBeNull();
    expect(captureCharFrame()).toContain("Campaigns directory must be a full path");
    expect(renderer.currentFocusedRenderable).toBe(dirInput);
  });

  test("directories under home show as ~/ and save as full paths", async () => {
    const home = homedir();
    await open({ campaignsDir: join(home, "Scribe"), oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });
    const dirInput = settingsInputs()[3]!;
    expect(dirInput.value).toBe("~/Scribe");

    await keys.pressKeys(Array(6).fill("TAB"), 10);
    keys.pressEnter();
    await wait();
    expect(saved?.campaignsDir).toBe(join(home, "Scribe"));
  });

  test("a base URL without a scheme is refused", async () => {
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });
    await keys.typeText("api.example.com/v1", 5);
    await keys.pressKeys(Array(6).fill("TAB"), 10);
    keys.pressEnter();
    await wait();
    await renderOnce();

    expect(saved).toBeNull();
    expect(captureCharFrame()).toContain("must start with http:// or https://");
    expect(renderer.currentFocusedRenderable).toBe(settingsInputs()[0]!);
  });

  describe("Test connection", () => {
    /** Tab from the base URL field to the Test connection button and press it. */
    async function pressTest(): Promise<void> {
      await keys.pressKeys(Array(7).fill("TAB"), 10);
      keys.pressEnter();
      await wait();
      await renderOnce();
    }

    test("asks the model in the fields for a reply, with the key from the named variable", async () => {
      const seen: { auth: string | null; model: unknown }[] = [];
      const server = Bun.serve({
        port: 0,
        async fetch(req) {
          if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
          const body = (await req.json()) as { model?: unknown };
          seen.push({ auth: req.headers.get("authorization"), model: body.model });
          return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n', {
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      process.env["SCRIBE_TEST_KEY"] = "secret-value";
      try {
        await open({
          campaignsDir: "/tmp/x",
          oneshotsDir: "/tmp/o",
          sourcesDir: "/tmp/s",
          baseUrl: `http://localhost:${server.port}/v1`,
          model: "llama3.1",
          apiKeyEnv: "SCRIBE_TEST_KEY",
        });
        await pressTest();

        expect(captureCharFrame()).toContain("Connected: llama3.1 replied.");
        expect(seen).toEqual([{ auth: "Bearer secret-value", model: "llama3.1" }]);
        expect(saved).toBeNull(); // testing never saves
      } finally {
        delete process.env["SCRIBE_TEST_KEY"];
        server.stop();
      }
    });

    test("a rejected key is explained in terms of the variable", async () => {
      const server = Bun.serve({ port: 0, fetch: () => new Response("bad key", { status: 401 }) });
      process.env["SCRIBE_TEST_KEY"] = "wrong";
      try {
        await open({
          campaignsDir: "/tmp/x",
          oneshotsDir: "/tmp/o",
          sourcesDir: "/tmp/s",
          baseUrl: `http://localhost:${server.port}/v1`,
          apiKeyEnv: "SCRIBE_TEST_KEY",
        });
        await pressTest();
        expect(captureCharFrame()).toContain("rejected the API key from SCRIBE_TEST_KEY");
      } finally {
        delete process.env["SCRIBE_TEST_KEY"];
        server.stop();
      }
    });

    test("an unset key variable is reported without making a request", async () => {
      let requests = 0;
      const server = Bun.serve({
        port: 0,
        fetch() {
          requests++;
          return new Response("{}");
        },
      });
      delete process.env["SCRIBE_UNSET_KEY"];
      try {
        await open({
          campaignsDir: "/tmp/x",
          oneshotsDir: "/tmp/o",
          sourcesDir: "/tmp/s",
          baseUrl: `http://localhost:${server.port}/v1`,
          apiKeyEnv: "SCRIBE_UNSET_KEY",
        });
        await pressTest();

        expect(captureCharFrame()).toContain("SCRIBE_UNSET_KEY is not set");
        expect(requests).toBe(0);
        expect(renderer.currentFocusedRenderable).toBe(settingsInputs()[1]!);
      } finally {
        server.stop();
      }
    });
  });

  test("the whole form fits an 80x24 terminal", async () => {
    renderer.destroy();
    ({ renderer, keys, captureCharFrame, renderOnce } = await setupRenderer({ width: 80, height: 24 }));
    await open({ campaignsDir: "/tmp/x", oneshotsDir: "/tmp/o", sourcesDir: "/tmp/s" });

    const lines = captureCharFrame().split("\n");
    const row = (text: string): number => lines.findIndex((line) => line.includes(text));
    expect(row("Sources directory")).toBeGreaterThan(row("Base URL"));
    // Buttons keep all three rows: border, label, border.
    expect(lines[row("Save") - 1]).toContain("┌");
    expect(lines[row("Save")]).toContain("│  Save  │");
    expect(lines[row("Save") + 1]).toContain("└");
  });
});
