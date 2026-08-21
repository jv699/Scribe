import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMockMouse, type createMockKeys, type TestRenderer } from "@opentui/core/testing";
import { setupRenderer, wait } from "./helpers/renderer.ts";
import type { KeyEvent } from "@opentui/core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeButton } from "../src/components/ui.ts";
import { makeCampaignDialog } from "../src/components/campaign-dialog.ts";
import { makeMainMenuScreen, type MainMenuView } from "../src/screens/main-menu.ts";
import { makeCampaignHomeScreen } from "../src/screens/campaign-home.ts";
import type { Screen } from "../src/screens/screen.ts";
import { createCampaign, listCampaigns, loadCampaign, type Campaign } from "../src/store/campaigns.ts";

/**
 * End-to-end UI flow test — must live inside the project so @opentui/core
 * resolves to a single module instance (see AGENTS.md gotchas).
 */

let campaignsDir: string;
let renderer: TestRenderer;
let keys: ReturnType<typeof createMockKeys>;
let captureCharFrame: () => string;
let renderOnce: () => Promise<void>;
let currentScreen: Screen | null = null;
let campaignDialog: { layer: Parameters<TestRenderer["root"]["add"]>[0]; open: () => void };

function showScreen(screen: Screen): void {
  if (currentScreen) {
    currentScreen.dispose?.();
    renderer.root.remove(currentScreen.node);
    currentScreen.node.destroyRecursively();
  }
  currentScreen = screen;
  renderer.root.add(screen.node);
  screen.focus?.();
}

async function showMainMenu(initialView: MainMenuView = "root"): Promise<void> {
  const campaigns = await listCampaigns(campaignsDir);
  showScreen(
    makeMainMenuScreen(renderer, {
      campaigns,
      initialView,
      playIntro: false,
      onCreateCampaign: () => campaignDialog.open(),
      onSelectCampaign: (c) => void showCampaignHome(c),
      onSettings: () => {},
      onOneshotPlanner: () => {},
      onQuit: () => {},
    }),
  );
}

async function showCampaignHome(campaign: Campaign): Promise<void> {
  const fresh = (await loadCampaign(campaign.dir)) ?? campaign;
  showScreen(
    await makeCampaignHomeScreen(renderer, {
      campaign: fresh,
      onBack: () => void showMainMenu("campaigns"),
      onChanged: () => void showCampaignHome(fresh),
      onPlan: () => {},
      onReport: () => {},
    }),
  );
}


beforeEach(async () => {
  // `currentScreen` spans tests, but each test owns a fresh renderer. Never
  // ask the new renderer to remove a node belonging to the previous one.
  currentScreen = null;
  campaignsDir = await mkdtemp(join(tmpdir(), "scribe-ui-test-"));
  ({ renderer, keys, captureCharFrame, renderOnce } = await setupRenderer({ width: 100, height: 30 }));

  campaignDialog = makeCampaignDialog(renderer, {
    onSubmit: (input) => {
      void (async () => {
        const campaign = await createCampaign(campaignsDir, input);
        await showCampaignHome(campaign);
      })();
    },
    onCancel: () => currentScreen?.focus?.(),
  });
  renderer.root.add(campaignDialog.layer);
  await showMainMenu();
});

afterEach(async () => {
  currentScreen?.dispose?.();
  currentScreen = null;
  renderer.destroy();
  await rm(campaignsDir, { recursive: true, force: true });
});

describe("phase-0 ui flow", () => {
  test("create campaign -> plan session -> status transitions -> trash -> persistence", async () => {
    // Campaign UI remains exercised directly while its release-menu entry is disabled.
    await showMainMenu("campaigns");
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame.includes("Back") && frame.includes("Create Campaign")).toBe(true);

    // Create a campaign through the dialog.
    await keys.pressKeys(["ARROW_DOWN"], 20);
    keys.pressEnter();
    await wait(100);
    await keys.typeText("Curse of Strahd", 5);
    await keys.pressKeys(["TAB"], 20);
    await keys.typeText("D&D 5e", 5);
    await keys.pressKeys(["TAB"], 20);
    await keys.typeText("Gothic horror.", 5);
    await keys.pressKeys(["TAB"], 20);
    keys.pressEnter();
    await wait();
    await renderOnce();

    frame = captureCharFrame();
    expect(frame.includes("Curse of Strahd")).toBe(true);
    expect(frame.includes("System: D&D 5e")).toBe(true);
    expect(frame.includes("Gothic horror.")).toBe(true);
    expect(frame.includes("(nothing yet)")).toBe(true);

    const onDisk = await listCampaigns(campaignsDir);
    expect(onDisk.length).toBe(1);
    const rawMd = await readFile(join(onDisk[0]!.dir, "campaign.md"), "utf8");
    expect(rawMd.includes("system: D&D 5e") && rawMd.includes("nextSession: 1")).toBe(true);

    // create a session (Enter submits directly)
    keys.pressEnter();
    await wait(100);
    await keys.typeText("Death House", 5);
    keys.pressEnter();
    await wait();
    await renderOnce();
    expect(captureCharFrame().includes("001 — Death House [planning]")).toBe(true);

    // mark ready via the detail dialog (first button is now "Plan with Agent")
    keys.pressEnter();
    await wait(100);
    await keys.pressKeys(["TAB"], 20); // Plan with Agent -> Mark Ready
    keys.pressEnter();
    await wait();
    await renderOnce();
    expect(captureCharFrame().includes("001 — Death House [ready]")).toBe(true);

    // trash it (ready: buttons = [Report outcome, Mark Played, Move to Trash, Close]),
    // then confirm the trash dialog
    keys.pressEnter();
    await wait(100);
    await keys.pressKeys(["TAB", "TAB"], 20);
    keys.pressEnter(); // -> confirm dialog, "Trash" focused
    await wait(100);
    keys.pressEnter(); // confirm
    await wait();
    await renderOnce();
    expect(captureCharFrame().includes("Death House")).toBe(false);

    // escape back to the campaign submenu — campaign is listed
    keys.pressKey("ESCAPE");
    await wait(500);
    await renderOnce();
    frame = captureCharFrame();
    expect(frame.includes("Create Campaign")).toBe(true);
    expect(frame.includes("Curse of Strahd")).toBe(true);

    // navigate back in — loaded from disk
    await keys.pressKeys(["ARROW_DOWN", "ARROW_DOWN"], 20);
    keys.pressEnter();
    await wait();
    await renderOnce();
    frame = captureCharFrame();
    expect(frame.includes("Curse of Strahd")).toBe(true);
    expect(frame.includes("System: D&D 5e")).toBe(true);
  }, 15000);
});

describe("campaign home failures", () => {
  test("a failed session creation returns focus to the session menu", async () => {
    const campaign = await createCampaign(campaignsDir, {
      name: "Broken Campaign",
      system: "5e",
      description: "",
    });
    await rm(join(campaign.dir, "sessions"), { recursive: true });
    await showCampaignHome(campaign);

    keys.pressEnter(); // + New Session
    await wait(60);
    await keys.typeText("Lost Session", 3);
    keys.pressEnter();
    await wait(100);
    await renderOnce();
    expect(captureCharFrame()).toContain("Failed to create session");

    // Enter should operate the menu again, reopening the form. Previously the
    // hidden title input kept focus and swallowed it.
    keys.pressEnter();
    await wait(60);
    await renderOnce();
    expect(captureCharFrame()).toContain("New Session 1");
  });
});

describe("select mouse support", () => {
  /** Terminal coordinates of a rendered row, found by its label in the frame. */
  function locate(label: string): { x: number; y: number } {
    const lines = captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(label));
    expect(y).toBeGreaterThanOrEqual(0);
    return { x: lines[y]!.indexOf(label), y };
  }

  test("clicking a main-menu row runs that row's action", async () => {
    let settings = 0;
    let quits = 0;
    showScreen(
      makeMainMenuScreen(renderer, {
        campaigns: [],
        playIntro: false,
        onCreateCampaign: () => {},
        onSelectCampaign: () => {},
        onSettings: () => settings++,
        onOneshotPlanner: () => {},
        onQuit: () => quits++,
      }),
    );
    await renderOnce();

    const mouse = createMockMouse(renderer);
    const quit = locate("Quit");
    await mouse.click(quit.x, quit.y);
    expect(quits).toBe(1);
    expect(settings).toBe(0);

    const settingsRow = locate("Settings");
    await mouse.click(settingsRow.x, settingsRow.y);
    expect(settings).toBe(1);
    expect(quits).toBe(1);
  });

  test("the coming-soon campaign entry is inert for keyboard and mouse", async () => {
    let creates = 0;
    showScreen(
      makeMainMenuScreen(renderer, {
        campaigns: [],
        playIntro: false,
        onCreateCampaign: () => creates++,
        onSelectCampaign: () => {},
        onSettings: () => {},
        onOneshotPlanner: () => {},
        onQuit: () => {},
      }),
    );
    await renderOnce();

    const mouse = createMockMouse(renderer);
    const campaigns = locate("Campaigns");
    await mouse.click(campaigns.x, campaigns.y);
    await renderOnce();
    expect(captureCharFrame().includes("Create Campaign")).toBe(false);

    keys.pressEnter();
    await renderOnce();
    expect(captureCharFrame().includes("Create Campaign")).toBe(false);
    expect(creates).toBe(0);
  });

  test("hovering a main-menu row moves the selection", async () => {
    await renderOnce();
    const mouse = createMockMouse(renderer);
    const quit = locate("Quit");
    await mouse.moveTo(quit.x, quit.y);
    await renderOnce();
    // The selection indicator sits just left of the hovered row's label.
    expect(captureCharFrame().split("\n")[quit.y]).toContain("▶ Quit");
  });
});

describe("two-stage main menu", () => {
  test("disposing the first menu cancels its intro animations", async () => {
    const intro = makeMainMenuScreen(renderer, {
      campaigns: [],
      playIntro: true,
      onCreateCampaign: () => {},
      onSelectCampaign: () => {},
      onSettings: () => {},
      onOneshotPlanner: () => {},
      onQuit: () => {},
    });
    renderer.root.add(intro.node);

    intro.dispose?.();
    renderer.root.remove(intro.node);
    intro.node.destroyRecursively();
    await wait(150);

    expect(intro.node.isDestroyed).toBe(true);
  });

  test("Back and Escape both return the campaign stage to the root", async () => {
    await renderOnce();
    const rootLines = captureCharFrame().split("\n");
    const rootOrder = ["Campaigns (Coming Soon)", "Drafting Table", "Settings", "Quit"].map((label) =>
      rootLines.findIndex((line) => line.includes(label)),
    );
    expect(rootOrder.every((row, index) => index === 0 || row > rootOrder[index - 1]!)).toBe(true);
    expect(rootLines.find((line) => line.includes("Drafting Table"))).toContain("▶ Drafting Table");

    await showMainMenu("campaigns");
    await renderOnce();
    expect(captureCharFrame().includes("Create Campaign")).toBe(true);

    keys.pressEnter();
    await renderOnce();
    expect(captureCharFrame().includes("Drafting Table")).toBe(true);
    expect(captureCharFrame().includes("Create Campaign")).toBe(false);

    await showMainMenu("campaigns");
    await renderOnce();
    keys.pressKey("ESCAPE");
    await wait(100);
    await renderOnce();
    expect(captureCharFrame().includes("Drafting Table")).toBe(true);
    expect(captureCharFrame().includes("Create Campaign")).toBe(false);
  });

  test("cancelling campaign creation stays in the campaign stage", async () => {
    await showMainMenu("campaigns");
    await renderOnce();
    await keys.pressKeys(["ARROW_DOWN"], 20);
    keys.pressEnter();
    await wait(100);

    keys.pressKey("ESCAPE");
    await wait(100);
    await renderOnce();
    expect(captureCharFrame().includes("New Campaign")).toBe(false);
    expect(captureCharFrame().includes("Create Campaign")).toBe(true);
    expect(captureCharFrame().includes("Drafting Table")).toBe(false);
  });
});

describe("makeButton", () => {
  test("destroys cleanly while focused", () => {
    const button = makeButton(renderer, { label: "Back" });
    renderer.root.add(button);
    button.focus();

    expect(() => button.destroyRecursively()).not.toThrow();
  });

  // Numpad Enter is a distinct key name from Return; every other Enter-sensitive
  // widget accepts both, and makeButton backs every button in the app.
  test("activates on both Return and numpad Enter", () => {
    let clicks = 0;
    const button = makeButton(renderer, { label: "Go", onClick: () => clicks++ });
    renderer.root.add(button);

    button.onKeyDown?.({ name: "return" } as KeyEvent);
    expect(clicks).toBe(1);

    button.onKeyDown?.({ name: "kpenter" } as KeyEvent);
    expect(clicks).toBe(2);

    button.onKeyDown?.({ name: "a" } as KeyEvent);
    expect(clicks).toBe(2);
  });
});
