import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRenderer, createMockKeys, type TestRenderer } from "@opentui/core/testing";
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

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  const setup = await createTestRenderer({ width: 90, height: 24 });
  renderer = setup.renderer;
  captureCharFrame = setup.captureCharFrame;
  renderOnce = setup.renderOnce;
  keys = createMockKeys(renderer);
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
    await keys.pressKeys(["TAB", "TAB", "TAB", "TAB", "TAB"], 20); // -> key, dir, one-shots, sources, Save
    keys.pressEnter();
    await wait();

    expect(saved?.baseUrl).toBe("https://ollama.local/v1");
    expect(saved?.model).toBe("llama3.1");
    expect(saved?.campaignsDir).toBe("/tmp/x"); // untouched field preserved
    expect(saved?.oneshotsDir).toBe("/tmp/o"); // untouched field preserved
    expect(saved?.sourcesDir).toBe("/tmp/s"); // untouched field preserved
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
