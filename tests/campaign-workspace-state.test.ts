import { afterEach, beforeEach, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createMockMouse, type TestRenderer } from "@opentui/core/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeCampaignWorkspaceScreen, type SessionChatHost } from "../src/screens/campaign-workspace.ts";
import type { ChatScreen } from "../src/screens/chat.ts";
import type { Screen } from "../src/screens/screen.ts";
import { createCampaign } from "../src/store/campaigns.ts";
import { createSession } from "../src/store/sessions.ts";
import { setupRenderer, wait } from "./helpers/renderer.ts";

let renderer: TestRenderer;
let captureCharFrame: () => string;
let renderOnce: () => Promise<void>;
let testDir: string;
let screen: Screen | null;

beforeEach(async () => {
  ({ renderer, captureCharFrame, renderOnce } = await setupRenderer({ width: 100, height: 30 }));
  testDir = await mkdtemp(join(tmpdir(), "scribe-workspace-state-"));
  screen = null;
});

afterEach(async () => {
  screen?.dispose?.();
  await renderer.destroy();
  await rm(testDir, { recursive: true, force: true });
});

test("a campaign view immediately detaches state from a canceled pending chat", async () => {
  const campaign = await createCampaign(testDir, { name: "Crossroads", system: "5e", description: "" });
  await createSession(campaign, "Slow Road");
  await createSession(campaign, "Open Road");
  let pendingHost: SessionChatHost | null = null;
  let rejectPending!: (error: Error) => void;

  screen = await makeCampaignWorkspaceScreen(renderer, {
    campaign,
    onBack: () => {},
    makeSessionChat: (session, host) => {
      if (session.number === 1) {
        pendingHost = host;
        return new Promise<ChatScreen>((_resolve, reject) => { rejectPending = reject; });
      }
      return Promise.resolve({
        node: new BoxRenderable(renderer, { width: "100%", height: "100%" }),
        setTitle: () => {},
      });
    },
  });
  renderer.root.add(screen.node);
  await renderOnce();

  const mouse = createMockMouse(renderer);
  let lines = captureCharFrame().split("\n");
  let y = lines.findIndex((line) => line.includes("001 Slow Road"));
  await mouse.click(lines[y]!.indexOf("001 Slow Road"), y);
  await wait(20);
  await renderOnce();

  lines = captureCharFrame().split("\n");
  y = lines.findIndex((line) => line.includes("Characters"));
  await mouse.click(lines[y]!.indexOf("Characters"), y);
  await wait(20);

  pendingHost!.onStateChange("working");
  await renderOnce();
  expect(captureCharFrame()).not.toContain("… 001 Slow Road");

  rejectPending(new Error("late failure"));
  await wait(30);
  await renderOnce();

  expect(captureCharFrame()).toContain("Characters");
  expect(captureCharFrame()).not.toContain("… 001 Slow Road");
});

test("a mounted chat keeps updating its state while hidden behind a campaign view", async () => {
  const campaign = await createCampaign(testDir, { name: "Crossroads", system: "5e", description: "" });
  await createSession(campaign, "Open Road");
  let chatHost!: SessionChatHost;

  screen = await makeCampaignWorkspaceScreen(renderer, {
    campaign,
    onBack: () => {},
    makeSessionChat: (_session, host) => {
      chatHost = host;
      return Promise.resolve({
        node: new BoxRenderable(renderer, { width: "100%", height: "100%" }),
        setTitle: () => {},
      });
    },
  });
  renderer.root.add(screen.node);

  chatHost.onStateChange("working");
  await renderOnce();
  expect(captureCharFrame()).toContain("… 001 Open Road");

  const lines = captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes("Characters"));
  await createMockMouse(renderer).click(lines[y]!.indexOf("Characters"), y);
  await wait(20);

  chatHost.onStateChange("awaiting-answer");
  await renderOnce();
  expect(captureCharFrame()).toContain("? 001 Open Road");
  expect(captureCharFrame()).not.toContain("… 001 Open Road");

  chatHost.onStateChange("idle");
  await renderOnce();
  expect(captureCharFrame()).toContain("001 Open Road [planning]");
  expect(captureCharFrame()).not.toContain("? 001 Open Road");
});
