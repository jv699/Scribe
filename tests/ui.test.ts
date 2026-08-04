import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTestRenderer, createMockKeys, type TestRenderer } from "@opentui/core/testing";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeCampaignDialog } from "../src/components/campaign-dialog.ts";
import { makeMainMenuScreen } from "../src/screens/main-menu.ts";
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
    renderer.root.remove(currentScreen.node.id);
    currentScreen.node.destroyRecursively();
  }
  currentScreen = screen;
  renderer.root.add(screen.node);
  screen.focus?.();
}

async function showMainMenu(): Promise<void> {
  const campaigns = await listCampaigns(campaignsDir);
  showScreen(
    makeMainMenuScreen(renderer, {
      campaigns,
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
      onBack: () => void showMainMenu(),
      onChanged: () => void showCampaignHome(fresh),
      onPlan: () => {},
      onReport: () => {},
    }),
  );
}

const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  campaignsDir = await mkdtemp(join(tmpdir(), "scribe-ui-test-"));
  const setup = await createTestRenderer({ width: 100, height: 30 });
  renderer = setup.renderer;
  captureCharFrame = setup.captureCharFrame;
  renderOnce = setup.renderOnce;
  keys = createMockKeys(renderer);

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
  renderer.destroy();
  await rm(campaignsDir, { recursive: true, force: true });
});

describe("phase-0 ui flow", () => {
  test("create campaign -> plan session -> status transitions -> trash -> persistence", async () => {
    // main menu
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame.includes("Create New Campaign") && frame.includes("Quit")).toBe(true);

    // create a campaign through the dialog
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

    // escape back to the main menu — campaign is listed
    keys.pressKey("ESCAPE");
    await wait(500);
    await renderOnce();
    frame = captureCharFrame();
    expect(frame.includes("Create New Campaign")).toBe(true);
    expect(frame.includes("Curse of Strahd")).toBe(true);

    // navigate back in — loaded from disk
    await keys.pressKeys(["ARROW_DOWN"], 20);
    keys.pressEnter();
    await wait();
    await renderOnce();
    frame = captureCharFrame();
    expect(frame.includes("Curse of Strahd")).toBe(true);
    expect(frame.includes("System: D&D 5e")).toBe(true);
  }, 15000);
});
