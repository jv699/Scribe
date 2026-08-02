/**
 * Entry point: sets up the renderer, loads settings, and owns the screen
 * manager (one `Screen` at a time under the renderer root) plus the
 * campaign-create dialog and app-level navigation wiring.
 */
import { createCliRenderer } from "@opentui/core";
import { makeCampaignDialog } from "./components/campaign-dialog.ts";
import { makeMainMenuScreen } from "./screens/main-menu.ts";
import { makeCampaignHomeScreen } from "./screens/campaign-home.ts";
import { makeSettingsScreen } from "./screens/settings.ts";
import { makeChatScreen, type ChatLogStore } from "./screens/chat.ts";
import type { Screen } from "./screens/screen.ts";
import { loadSettings, saveSettings } from "./store/settings.ts";
import { createCampaign, listCampaigns, loadCampaign, type Campaign } from "./store/campaigns.ts";
import { createProviderFromSettings, DEFAULT_MODEL } from "./provider/openai.ts";
import { makeCampaignTools } from "./agent/tools.ts";
import { buildPlanningSystemPrompt, buildReportSystemPrompt } from "./agent/context.ts";
import type { Session } from "./store/sessions.ts";
import { clearChatLog, loadChatLog, saveChatLog, type ChatLogMode } from "./store/chat-log.ts";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});

renderer.setTerminalTitle("Scribe");

let settings = await loadSettings();

// --- Screen management: one screen at a time under the renderer root ---
let currentScreen: Screen | null = null;

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

let introPlayed = false;

/** Navigate safely: if building a screen throws, log and fall back to the menu. */
function navigate(fn: () => Promise<unknown>): void {
  void fn().catch((err: unknown) => {
    console.error("Navigation failed:", err);
    void showMainMenu();
  });
}

async function showMainMenu(): Promise<void> {
  const campaigns = await listCampaigns(settings.campaignsDir);
  showScreen(
    makeMainMenuScreen(renderer, {
      campaigns,
      playIntro: !introPlayed,
      onCreateCampaign: () => campaignDialog.open(),
      onSelectCampaign: (campaign) => navigate(() => showCampaignHome(campaign)),
      onSettings: () => navigate(showSettingsScreen),
      onChat: () => navigate(showChatScreen),
      onQuit: () => {
        renderer.destroy();
        process.exit(0);
      },
    }),
  );
  introPlayed = true;
}

async function showSettingsScreen(): Promise<void> {
  showScreen(
    await makeSettingsScreen(renderer, {
      settings,
      onSaved: async (next) => {
        await saveSettings(next);
        settings = next;
        await navigate(showMainMenu);
      },
      onBack: () => navigate(showMainMenu),
    }),
  );
}

async function showChatScreen(): Promise<void> {
  showScreen(
    await makeChatScreen(renderer, {
      provider: createProviderFromSettings(settings),
      model: settings.model ?? DEFAULT_MODEL,
      onBack: () => navigate(showMainMenu),
    }),
  );
}

async function showCampaignHome(campaign: Campaign): Promise<void> {
  // Re-read from disk so external edits (and our own changes) are reflected.
  const fresh = (await loadCampaign(campaign.dir)) ?? campaign;
  showScreen(
    await makeCampaignHomeScreen(renderer, {
      campaign: fresh,
      onBack: () => navigate(showMainMenu),
      onChanged: () => navigate(() => showCampaignHome(fresh)),
      onPlan: (session) => navigate(() => showPlanningChat(fresh, session)),
      onReport: (session) => navigate(() => showReportChat(fresh, session)),
    }),
  );
}

async function showPlanningChat(campaign: Campaign, session: Session): Promise<void> {
  const [systemPrompt, tools] = await Promise.all([
    buildPlanningSystemPrompt(campaign, session),
    makeCampaignTools(campaign.dir),
  ]);
  showScreen(
    await makeChatScreen(renderer, {
      provider: createProviderFromSettings(settings),
      model: settings.model ?? DEFAULT_MODEL,
      title: `Plan Session ${session.number} — ${session.title}`,
      systemPrompt,
      tools,
      chatLog: makeChatLog(campaign, session, "plan"),
      onBack: () => navigate(() => showCampaignHome(campaign)),
    }),
  );
}

async function showReportChat(campaign: Campaign, session: Session): Promise<void> {
  const [systemPrompt, tools] = await Promise.all([
    buildReportSystemPrompt(campaign, session),
    makeCampaignTools(campaign.dir, { report: true }),
  ]);
  showScreen(
    await makeChatScreen(renderer, {
      provider: createProviderFromSettings(settings),
      model: settings.model ?? DEFAULT_MODEL,
      title: `Report Session ${session.number} — ${session.title}`,
      systemPrompt,
      tools,
      chatLog: makeChatLog(campaign, session, "report"),
      onBack: () => navigate(() => showCampaignHome(campaign)),
    }),
  );
}

function makeChatLog(campaign: Campaign, session: Session, mode: ChatLogMode): ChatLogStore {
  return {
    load: () => loadChatLog(campaign.dir, session.number, mode),
    save: (messages) => saveChatLog(campaign.dir, session.number, mode, messages),
    clear: () => clearChatLog(campaign.dir, session.number, mode),
  };
}

const campaignDialog = makeCampaignDialog(renderer, {
  onSubmit: (input) => {
    navigate(async () => {
      const campaign = await createCampaign(settings.campaignsDir, input);
      await showCampaignHome(campaign);
    });
  },
  onCancel: () => currentScreen?.focus?.(),
});
renderer.root.add(campaignDialog.layer);

await showMainMenu();
