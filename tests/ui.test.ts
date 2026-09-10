import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMockMouse, type createMockKeys, type TestRenderer } from "@opentui/core/testing";
import { setupRenderer, wait } from "./helpers/renderer.ts";
import { TextareaRenderable, type KeyEvent } from "@opentui/core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeButton } from "../src/components/ui.ts";
import { makeCampaignDialog } from "../src/components/campaign-dialog.ts";
import { makeMainMenuScreen, type MainMenuView } from "../src/screens/main-menu.ts";
import { makeCampaignWorkspaceScreen } from "../src/screens/campaign-workspace.ts";
import { makeChatScreen } from "../src/screens/chat.ts";
import type { Screen } from "../src/screens/screen.ts";
import type { ChatProvider } from "../src/provider/types.ts";
import { createCampaign, listCampaigns, loadCampaign, type Campaign } from "../src/store/campaigns.ts";
import { createSession, setSessionStatus } from "../src/store/sessions.ts";
import { listCharacters } from "../src/store/characters.ts";
import { makeAskChannel } from "../src/agent/ask.ts";
import { resolveTools } from "../src/agent/tools/index.ts";

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
      onSelectCampaign: (c) => void showCampaignWorkspace(c),
      onSettings: () => {},
      onOneshotPlanner: () => {},
      onQuit: () => {},
    }),
  );
}

const provider: ChatProvider = {
  async *streamChat() {
    yield { type: "text", delta: "Ready to plan." };
  },
};

async function showCampaignWorkspace(campaign: Campaign): Promise<void> {
  const fresh = (await loadCampaign(campaign.dir)) ?? campaign;
  showScreen(
    await makeCampaignWorkspaceScreen(renderer, {
      campaign: fresh,
      onBack: () => void showMainMenu("campaigns"),
      makeSessionChat: (session, host) =>
        makeChatScreen(renderer, {
          provider,
          title: `Session ${String(session.number).padStart(3, "0")} — ${session.title}`,
          isInputActive: host.isInputActive,
          onInputFocus: host.onInputFocus,
          onBack: host.onBack,
        }),
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
        await showCampaignWorkspace(campaign);
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

describe("campaign workspace flow", () => {
  test.each(["Characters", "Story So Far", "Settings"])("clicking back into %s restores editor keyboard navigation", async (destination) => {
    const campaign = await createCampaign(campaignsDir, { name: "Focus", system: "5e", description: "" });
    await showCampaignWorkspace(campaign);
    await renderOnce();
    const lines = captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes(destination));
    const mouse = createMockMouse(renderer);
    await mouse.click(lines[y]!.indexOf(destination), y);
    await wait(40);
    if (destination !== "Settings") {
      keys.pressEnter(); // Add character / Add campaign history
      await wait(20);
    }
    await renderOnce();
    const editor = renderer.currentFocusedRenderable!;
    keys.pressKey("ESCAPE");
    await wait(20);
    await renderOnce();
    expect(renderer.currentFocusedRenderable?.constructor.name).toBe("SelectRenderable");
    await mouse.click(editor.x + 1, editor.y);
    expect(renderer.currentFocusedRenderable === editor).toBe(true);
    await keys.pressKeys(["TAB"], 20);
    expect(renderer.currentFocusedRenderable === editor).toBe(false);
    expect(renderer.currentFocusedRenderable?.constructor.name).not.toBe("SelectRenderable");
    keys.pressTab({ shift: true });
    await wait(20);
    expect(renderer.currentFocusedRenderable === editor).toBe(true);
    if (destination === "Settings") {
      await renderOnce();
      const frame = captureCharFrame().split("\n");
      const cancelY = frame.findIndex((line) => line.includes("Cancel"));
      await mouse.click(frame[cancelY]!.indexOf("Cancel"), cancelY);
      await keys.pressKeys(["TAB"], 20);
      expect(renderer.currentFocusedRenderable?.constructor.name).toBe("SelectRenderable");
    }
  });

  test("a rejected story heading leaves the draft available to correct and save", async () => {
    const campaign = await createCampaign(campaignsDir, { name: "History", system: "", description: "" });
    await showCampaignWorkspace(campaign);
    await renderOnce();
    const lines = captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Story So Far"));
    await createMockMouse(renderer).click(lines[y]!.indexOf("Story So Far"), y);
    await wait(20);
    keys.pressEnter();
    await wait(20);
    const editor = renderer.currentFocusedRenderable as TextareaRenderable;
    const draft = "Opening\n\n## Session 1\n\nThe party arrived.";
    editor.setText(draft);
    await keys.pressKeys(["TAB"], 20);
    keys.pressEnter();
    await wait(40);
    await renderOnce();
    expect(captureCharFrame()).toContain("Use ###");
    expect(editor.plainText).toBe(draft);
    expect((await loadCampaign(campaign.dir))?.storySoFar).toBe("");
    editor.focus();
    editor.setText(draft.replace("## Session", "### Session"));
    expect(editor.plainText).toBe(draft.replace("## Session", "### Session"));
    await keys.pressKeys(["TAB"], 20);
    keys.pressEnter();
    await wait(40);
    expect((await loadCampaign(campaign.dir))?.storySoFar).toBe(draft.replace("## Session", "### Session"));
  });

  test("repeatedly discarding campaign settings restores multiline fields each time", async () => {
    const campaign = await createCampaign(campaignsDir, { name: "Discard", system: "5e", description: "Original background" });
    await showCampaignWorkspace(campaign);
    await renderOnce();
    const lines = captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.includes("Settings"));
    await createMockMouse(renderer).click(lines[y]!.indexOf("Settings"), y);
    await wait(30);
    for (const text of ["First draft", "Second draft"]) {
      await keys.pressKeys(["TAB", "TAB", "TAB"], 10);
      const background = renderer.currentFocusedRenderable as TextareaRenderable;
      background.setText(text);
      keys.pressKey("ESCAPE");
      await wait(20);
      await keys.pressKeys(["TAB"], 10); // Cancel -> Discard
      keys.pressEnter();
      await wait(20);
      expect(background.plainText).toBe("Original background");
      expect(renderer.currentFocusedRenderable?.constructor.name).toBe("SelectRenderable");
      keys.pressEnter(); // Return to the same editor.
      await wait(20);
    }
    expect((await loadCampaign(campaign.dir))?.description).toBe("Original background");
  });

  test.each(["working", "awaiting-answer"])("switching sessions clears a disposed chat's %s indicator", async (state) => {
    const campaign = await createCampaign(campaignsDir, { name: "Activity", system: "", description: "" });
    await createSession(campaign, "First");
    await createSession(campaign, "Second");
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    showScreen(await makeCampaignWorkspaceScreen(renderer, {
      campaign,
      onBack: () => {},
      makeSessionChat: (session, host) => {
        const ask = makeAskChannel();
        return makeChatScreen(renderer, {
          ...host,
          title: session.title,
          ask,
          tools: state === "awaiting-answer" ? resolveTools(["ask_user"], { ask }) : [],
          provider: {
            async *streamChat(messages) {
              if (state === "awaiting-answer" && !messages.some((message) => message.role === "tool")) {
                yield { type: "tool_call", toolCall: {
                  index: 0, id: "question", name: "ask_user",
                  arguments: JSON.stringify({ question: "Which road?", options: [{ label: "Forest" }, { label: "Coast" }] }),
                } };
                return;
              }
              await pending;
              yield { type: "text", delta: "Finished" };
            },
          },
        });
      },
    }));
    try {
      await keys.typeText("plan", 1);
      keys.pressEnter();
      await wait(40);
      await renderOnce();
      const indicator = state === "working" ? "…" : "?";
      expect(captureCharFrame()).toContain(`${indicator} 002 Second`);
      const lines = captureCharFrame().split("\n");
      const y = lines.findIndex((line) => line.includes("001 First"));
      await createMockMouse(renderer).click(lines[y]!.indexOf("001 First"), y);
      await wait(40);
      await renderOnce();
      expect(captureCharFrame()).toContain("002 Second [planning]");
      expect(captureCharFrame()).not.toContain(`${indicator} 002 Second`);
      release();
      await wait(40);
      await renderOnce();
      expect(captureCharFrame()).not.toContain(`${indicator} 002 Second`);
    } finally {
      release();
      await wait(20);
    }
  });

  test("create campaign -> create session -> chat -> sidebar -> persistence", async () => {
    // Campaigns is the initially selected, live main-menu destination.
    keys.pressEnter();
    await renderOnce();
    let frame = captureCharFrame();
    expect(frame.includes("Back") && frame.includes("Create Campaign")).toBe(true);

    // With no campaigns, Create Campaign is the first row.
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
    expect(frame.includes("D&D 5e")).toBe(true);
    expect(frame.includes("No sessions yet")).toBe(true);
    expect(frame.includes("Settings")).toBe(true);

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
    frame = captureCharFrame();
    expect(frame.includes("001 Death House [planning]")).toBe(true);
    expect(frame.includes("Session 001 — Death House")).toBe(true);
    expect(frame.includes("Mark Ready")).toBe(false);
    expect(frame.includes("Report outcome")).toBe(false);
    expect(frame.includes("Move to Trash")).toBe(false);

    // First Escape warns; the chat keeps focus and the workspace remains.
    keys.pressKey("ESCAPE");
    await wait(100);
    await renderOnce();
    expect(captureCharFrame().includes("Session 001 — Death House")).toBe(true);
    expect(captureCharFrame().includes("Press Escape again to go back")).toBe(true);

    // A quick second Escape moves from chat to the sidebar.
    keys.pressKey("ESCAPE");
    await wait(100);

    // Escape from the sidebar returns to the campaign submenu.
    keys.pressKey("ESCAPE");
    await wait(300);
    await renderOnce();
    frame = captureCharFrame();
    expect(frame.includes("Create Campaign")).toBe(true);
    expect(frame.includes("Curse of Strahd")).toBe(true);

    // The saved campaign is now the first row; reopen it from disk.
    keys.pressEnter();
    await wait();
    await renderOnce();
    frame = captureCharFrame();
    expect(frame.includes("Curse of Strahd")).toBe(true);
    expect(frame.includes("D&D 5e")).toBe(true);
    expect(frame.includes("Session 001 — Death House")).toBe(true);
  }, 15000);

  test("opens the newest session and keeps legacy statuses display-only", async () => {
    const campaign = await createCampaign(campaignsDir, {
      name: "Long Road",
      system: "Shadowdark",
      description: "",
    });
    const first = await createSession(campaign, "The Gate");
    const second = await createSession(campaign, "The Keep");
    await setSessionStatus(first, "ready");
    await setSessionStatus(second, "played");

    const opened: number[] = [];
    const fresh = (await loadCampaign(campaign.dir)) ?? campaign;
    showScreen(
      await makeCampaignWorkspaceScreen(renderer, {
        campaign: fresh,
        onBack: () => {},
        makeSessionChat: async (session, host) => {
          opened.push(session.number);
          return makeChatScreen(renderer, {
            provider,
            title: `Session ${String(session.number).padStart(3, "0")} — ${session.title}`,
            chatLog: {
              load: async () => [{ role: "assistant", content: `History for ${session.title}` }],
              save: async () => {},
            },
            isInputActive: host.isInputActive,
            onInputFocus: host.onInputFocus,
            onBack: host.onBack,
          });
        },
      }),
    );
    await renderOnce();

    let frame = captureCharFrame();
    expect(opened).toEqual([2]);
    expect(frame).toContain("001 The Gate [ready]");
    expect(frame).toContain("002 The Keep [played]");
    expect(frame).toContain("Session 002 — The Keep");
    expect(frame).toContain("History for The Keep");
    expect(frame).not.toContain("Report outcome");

    // Double Escape hands control to the selected sidebar row; choose the prior one.
    keys.pressKey("ESCAPE");
    await wait(30);
    keys.pressKey("ESCAPE");
    await wait(30);
    await keys.pressKeys(["ARROW_UP"], 20);
    keys.pressEnter();
    await wait(100);
    await renderOnce();
    frame = captureCharFrame();
    expect(opened).toEqual([2, 1]);
    expect(frame).toContain("Session 001 — The Gate");
    expect(frame).toContain("History for The Gate");
  });

  test("a slower session load cannot replace a newer selection", async () => {
    const campaign = await createCampaign(campaignsDir, {
      name: "Crossroads",
      system: "5e",
      description: "",
    });
    await createSession(campaign, "Slow Road");
    await createSession(campaign, "Fast Road");
    const disposedSessions: number[] = [];
    let fastLoads = 0;

    showScreen(
      await makeCampaignWorkspaceScreen(renderer, {
        campaign,
        onBack: () => {},
        makeSessionChat: async (session, host) => {
          if (session.number === 1) await wait(120);
          if (session.number === 2 && fastLoads++ > 0) await wait(10);
          const chat = await makeChatScreen(renderer, {
            provider,
            title: `Session ${String(session.number).padStart(3, "0")} — ${session.title}`,
            isInputActive: host.isInputActive,
            onInputFocus: host.onInputFocus,
            onBack: host.onBack,
          });
          const dispose = chat.dispose;
          chat.dispose = () => {
            disposedSessions.push(session.number);
            dispose?.();
          };
          return chat;
        },
      }),
    );

    // Start loading session 1, then select session 2 before the first load
    // resolves. Session 1's eventual chat must be discarded as stale.
    keys.pressKey("ESCAPE");
    await wait(30);
    keys.pressKey("ESCAPE");
    await wait(30);
    await keys.pressKeys(["ARROW_UP"], 10);
    keys.pressEnter();
    await keys.pressKeys(["ARROW_DOWN"], 10);
    keys.pressEnter();
    await wait(180);
    await renderOnce();

    const frame = captureCharFrame();
    expect(frame).toContain("Session 002 — Fast Road");
    expect(frame).not.toContain("Session 001 — Slow Road");
    expect(disposedSessions).toContain(1);
  });

  test("creates a character and edits story and campaign details from sidebar destinations", async () => {
    const campaign = await createCampaign(campaignsDir, {
      name: "Ember Company",
      system: "Shadowdark",
      description: "A dangerous frontier.",
    });
    await showCampaignWorkspace(campaign);
    await renderOnce();

    // The session list contains only + New Session. Down crosses into the
    // pinned campaign destinations and selects Characters.
    keys.pressKey("ARROW_DOWN");
    keys.pressEnter();
    await wait(80);
    await renderOnce();
    expect(captureCharFrame()).toContain("No party characters yet");

    keys.pressEnter(); // + Add Character
    await wait(30);
    await keys.typeText("Mara", 3);
    await keys.pressKeys(["TAB"], 20);
    await keys.typeText("Fighter", 3);
    await keys.pressKeys(["TAB"], 20);
    await keys.typeText("Carries the broken crown.", 2);
    await keys.pressKeys(["TAB"], 20);
    keys.pressEnter(); // Save
    await wait(100);
    await renderOnce();
    expect(captureCharFrame()).toContain("Mara — Fighter");
    expect((await listCharacters(campaign))[0]?.description).toBe("Carries the broken crown.");

    keys.pressKey("ESCAPE"); // back to destination list
    await wait(20);
    keys.pressKey("ARROW_DOWN");
    keys.pressEnter(); // Story So Far
    await wait(60);
    await renderOnce();
    expect(captureCharFrame()).toContain("Nothing has been recorded yet");
    keys.pressEnter(); // Add campaign history
    await keys.typeText("The company opened the ash gate.", 2);
    await keys.pressKeys(["TAB"], 20);
    keys.pressEnter(); // Save
    await wait(80);
    await renderOnce();
    expect(captureCharFrame()).toContain("company opened the ash gate");

    keys.pressKey("ESCAPE");
    await wait(20);
    keys.pressKey("ARROW_DOWN");
    keys.pressEnter(); // Campaign Settings
    await wait(60);
    await renderOnce();
    expect(captureCharFrame()).toContain("Campaign Settings");
    await keys.typeText(" Revised", 2);
    await keys.pressKeys(["TAB", "TAB"], 20);
    await keys.typeText("Heroes against the dying light.", 2);
    await keys.pressKeys(["TAB", "TAB"], 20);
    await keys.typeText("Favor hard choices.", 2);
    await keys.pressKeys(["TAB"], 20);
    keys.pressEnter();
    await wait(100);

    const saved = (await loadCampaign(campaign.dir))!;
    expect(saved.name).toBe("Ember Company Revised");
    expect(saved.shortDescription).toBe("Heroes against the dying light.");
    expect(saved.planningPreferences).toBe("Favor hard choices.");
    expect(saved.storySoFar).toBe("The company opened the ash gate.");
    await renderOnce();
    expect(captureCharFrame()).toContain("Ember Company Revised");
  }, 15000);

  test("keeps a session chat and its draft alive while campaign sections are open", async () => {
    const campaign = await createCampaign(campaignsDir, {
      name: "Crossroads",
      system: "5e",
      description: "",
    });
    await createSession(campaign, "The Gate");
    showScreen(
      await makeCampaignWorkspaceScreen(renderer, {
        campaign,
        onBack: () => {},
        makeSessionChat: (session, host) => makeChatScreen(renderer, {
          provider: {
            async *streamChat() {
              await wait(220);
              yield { type: "text", delta: "The reply finished in the background." };
            },
          },
          title: session.title,
          isInputActive: host.isInputActive,
          onInputFocus: host.onInputFocus,
          onStateChange: host.onStateChange,
          onBack: host.onBack,
        }),
      }),
    );
    await keys.typeText("keep this draft", 2);

    // Hand control to the sidebar, cross + New Session, and open Characters.
    keys.pressKey("ESCAPE");
    await wait(20);
    keys.pressKey("ESCAPE");
    await wait(20);
    keys.pressKey("ARROW_DOWN");
    keys.pressKey("ARROW_DOWN");
    keys.pressEnter();
    await wait(70);
    keys.pressKey("ESCAPE");
    await wait(20);
    keys.pressKey("ARROW_UP");
    keys.pressKey("ARROW_UP");
    keys.pressEnter();
    await wait(40);
    await renderOnce();
    expect(captureCharFrame()).toContain("keep this draft");

    // Send it, then visit Characters while the provider is still streaming.
    keys.pressEnter();
    await wait(20);
    keys.pressKey("ESCAPE");
    await wait(20);
    keys.pressKey("ESCAPE");
    await wait(20);
    keys.pressKey("ARROW_DOWN");
    keys.pressKey("ARROW_DOWN");
    keys.pressEnter();
    await wait(60);
    await renderOnce();
    expect(captureCharFrame()).toContain("… 001 The Gate");

    await wait(240);
    const mouse = createMockMouse(renderer);
    const lines = captureCharFrame().split("\n");
    const sessionY = lines.findIndex((line) => line.includes("001 The Gate"));
    expect(sessionY).toBeGreaterThanOrEqual(0);
    await mouse.click(lines[sessionY]!.indexOf("001 The Gate"), sessionY);
    await wait(50);
    await renderOnce();
    expect(captureCharFrame()).toContain("reply finished in the background");
  }, 15000);

  test("guards unsaved campaign-view edits before returning to the sidebar", async () => {
    const campaign = await createCampaign(campaignsDir, {
      name: "Unwritten",
      system: "",
      description: "",
    });
    await showCampaignWorkspace(campaign);
    keys.pressKey("ARROW_DOWN");
    keys.pressEnter();
    await wait(60);
    keys.pressEnter();
    await keys.typeText("Unsaved Hero", 2);
    keys.pressKey("ESCAPE");
    await wait(40);
    await renderOnce();
    expect(captureCharFrame()).toContain("Discard character changes?");

    keys.pressKey("ESCAPE"); // Cancel the discard dialog.
    await wait(30);
    await renderOnce();
    expect(captureCharFrame()).toContain("Unsaved Hero");
    keys.pressKey("ESCAPE");
    await wait(20);
    await keys.pressKeys(["TAB"], 20); // Cancel -> Discard
    keys.pressEnter();
    await wait(40);
    expect(await listCharacters(campaign)).toEqual([]);
    await renderOnce();
    expect(captureCharFrame()).not.toContain("Unsaved Hero");
  });
});

describe("campaign workspace failures", () => {
  test("a failed session creation returns focus to the session menu", async () => {
    const campaign = await createCampaign(campaignsDir, {
      name: "Broken Campaign",
      system: "5e",
      description: "",
    });
    await rm(join(campaign.dir, "sessions"), { recursive: true });
    await showCampaignWorkspace(campaign);

    keys.pressEnter(); // + New Session
    await wait(60);
    await keys.typeText("Lost Session", 3);
    keys.pressEnter();
    await wait(100);
    await renderOnce();
    expect(captureCharFrame()).toContain("Failed to create:");

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

  test("the Campaigns entry opens the campaign list with keyboard and mouse", async () => {
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
    expect(captureCharFrame().includes("Create Campaign")).toBe(true);

    // Back follows Create Campaign in an empty campaign list.
    await keys.pressKeys(["ARROW_DOWN"], 20);
    keys.pressEnter();
    await renderOnce();
    expect(captureCharFrame().includes("Drafting Table")).toBe(true);
    keys.pressEnter();
    await renderOnce();
    expect(captureCharFrame().includes("Create Campaign")).toBe(true);
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
  test("campaign rows select their matching campaigns before Create and Back", async () => {
    const first = await createCampaign(campaignsDir, { name: "First Campaign", system: "5e", description: "" });
    const second = await createCampaign(campaignsDir, { name: "Second Campaign", system: "5e", description: "" });
    const selected: Campaign[] = [];
    showScreen(makeMainMenuScreen(renderer, {
      campaigns: [first, second],
      initialView: "campaigns",
      playIntro: false,
      onCreateCampaign: () => {},
      onSelectCampaign: (campaign) => selected.push(campaign),
      onSettings: () => {},
      onOneshotPlanner: () => {},
      onQuit: () => {},
    }));
    await renderOnce();

    keys.pressEnter();
    await keys.pressKeys(["ARROW_DOWN"], 20);
    keys.pressEnter();
    expect(selected).toEqual([first, second]);
  });

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
    const rootOrder = ["Campaigns", "Drafting Table", "Settings", "Quit"].map((label) =>
      rootLines.findIndex((line) => line.includes(label)),
    );
    expect(rootOrder.every((row, index) => index === 0 || row > rootOrder[index - 1]!)).toBe(true);
    expect(rootLines.find((line) => line.includes("Campaigns"))).toContain("▶ Campaigns");

    await showMainMenu("campaigns");
    await renderOnce();
    expect(captureCharFrame().includes("Create Campaign")).toBe(true);

    await keys.pressKeys(["ARROW_DOWN"], 20);
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
    keys.pressEnter();
    await wait(100);
    await renderOnce();
    expect(captureCharFrame()).toContain("New Campaign");

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
