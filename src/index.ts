/**
 * Entry point: sets up the renderer, loads settings, and owns the screen
 * manager (one `Screen` at a time under the renderer root) plus the
 * campaign-create dialog and app-level navigation wiring.
 */
import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { theme } from "./theme.ts";
import { makeCampaignDialog } from "./components/campaign-dialog.ts";
import { makeMainMenuScreen, type MainMenuView } from "./screens/main-menu.ts";
import { makeCampaignHomeScreen } from "./screens/campaign-home.ts";
import { makeSettingsScreen } from "./screens/settings.ts";
import { makeChatScreen, type ChatLogStore } from "./screens/chat.ts";
import type { Screen } from "./screens/screen.ts";
import { loadSettings, saveSettings } from "./store/settings.ts";
import { createCampaign, listCampaigns, loadCampaign, type Campaign } from "./store/campaigns.ts";
import { createProviderFromSettings, DEFAULT_BASE_URL, DEFAULT_MODEL, listModelInfos } from "./provider/openai.ts";
import type { ChatProvider, ModelInfo } from "./provider/types.ts";
import { toolsFor } from "./agent/agents.ts";
import type { ActiveOneshot } from "./agent/tools/types.ts";
import { makeAskChannel } from "./agent/ask.ts";
import { buildOneshotSystemPrompt, buildPlanningSystemPrompt, buildReportSystemPrompt } from "./agent/context.ts";
import type { Session } from "./store/sessions.ts";
import { loadChatLog, saveChatLog, type ChatLogMode } from "./store/chat-log.ts";
import { indexSources } from "./store/sources.ts";
import { campaignCompletions, oneshotCompletions } from "./completions.ts";

const renderer = await createCliRenderer({
  // Scribe owns Ctrl+C so chat can use a first press to clear the prompt and
  // require a second press to quit. Other screens still quit immediately.
  exitOnCtrlC: false,
});
renderer.setBackgroundColor(theme.background);

renderer.setTerminalTitle("Scribe");

let settings = await loadSettings();

// Warm the source-document cache in the background so the first search a
// session runs is usually instant. Extraction failures for individual PDFs
// are already swallowed inside indexSources; this catch is only for
// unexpected errors (e.g. an unreadable sourcesDir), which must never crash
// startup or block the UI from appearing.
void indexSources(settings.sourcesDir).catch(() => {});

// --- Screen management: one screen at a time under the renderer root ---
let currentScreen: Screen | null = null;

function quitApp(): void {
  currentScreen?.dispose?.();
  renderer.destroy();
  process.exit(0);
}

const onAppKeypress = (key: KeyEvent): void => {
  if (key.name !== "c" || !key.ctrl || key.shift || key.meta || key.option) return;

  // Keep Ctrl+C out of the focused textarea/dialog. A held key should not
  // count as the deliberate second press when the terminal can identify it.
  key.preventDefault();
  key.stopPropagation();
  if (key.eventType === "repeat" || key.repeated) return;

  if (currentScreen?.handleInterrupt?.() === "handled") return;
  quitApp();
};
renderer.keyInput.on("keypress", onAppKeypress);

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

let introPlayed = false;

/** Set by a failed navigation, shown once on the menu it falls back to. */
let pendingError: string | undefined;

/**
 * Navigate safely: if building a screen throws, fall back to the menu and
 * report there — console output is invisible behind the alt screen.
 */
function navigate(fn: () => Promise<unknown>): void {
  void fn().catch((err: unknown) => {
    pendingError = `Navigation failed: ${err instanceof Error ? err.message : String(err)}`;
    void showMainMenu();
  });
}

async function showMainMenu(initialView: MainMenuView = "root"): Promise<void> {
  const campaigns = await listCampaigns(settings.campaignsDir);
  const error = pendingError;
  pendingError = undefined;
  showScreen(
    makeMainMenuScreen(renderer, {
      campaigns,
      initialView,
      error,
      playIntro: !introPlayed,
      onCreateCampaign: () => campaignDialog.open(),
      onSelectCampaign: (campaign) => navigate(() => showCampaignHome(campaign)),
      onSettings: () => navigate(showSettingsScreen),
      onOneshotPlanner: () => navigate(showOneshotPlanner),
      onQuit: quitApp,
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
        navigate(showMainMenu);
      },
      onBack: () => navigate(showMainMenu),
    }),
  );
}

/**
 * Look up the current model's metadata (display name, context window,
 * pricing) from the provider's `/models` listing. Never throws — a failed or
 * unsupported lookup just leaves the chat header showing the bare model id.
 */
async function fetchModelInfo(model: string): Promise<ModelInfo | undefined> {
  try {
    const infos = await listModelInfos({
      baseUrl: settings.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: settings.apiKeyEnv ? (process.env[settings.apiKeyEnv] ?? "") : "",
    });
    return infos.find((info) => info.id === model);
  } catch {
    return undefined;
  }
}

/** Build a ChatProvider + model from the current settings. */
function makeChatOptions(): { provider: ChatProvider; model: string; modelInfo: Promise<ModelInfo | undefined> } {
  const model = settings.model ?? DEFAULT_MODEL;
  return {
    provider: createProviderFromSettings(settings),
    model,
    modelInfo: fetchModelInfo(model),
  };
}

async function showOneshotPlanner(): Promise<void> {
  // One channel per chat screen: the tools ask through it, the screen answers.
  // It has to exist before either, since tools are resolved up front.
  const ask = makeAskChannel();
  const activeOneshot: ActiveOneshot = { current: null };
  const screen = await makeChatScreen(renderer, {
    ...makeChatOptions(),
    title: "Drafting Table",
    systemPrompt: await buildOneshotSystemPrompt(settings),
    tools: toolsFor("oneshot", {
      oneshotsDir: settings.oneshotsDir,
      activeOneshot,
      sourcesDir: settings.sourcesDir,
      ask,
    }),
    ask,
    completions: oneshotCompletions(settings.oneshotsDir, settings.sourcesDir),
    onBack: () => navigate(showMainMenu),
  });
  activeOneshot.onRead = (oneshot) => screen.setTitle(`Drafting Table • ${oneshot.displayName}`);
  showScreen(screen);
}

async function showCampaignHome(campaign: Campaign): Promise<void> {
  // Re-read from disk so external edits (and our own changes) are reflected.
  const fresh = (await loadCampaign(campaign.dir)) ?? campaign;
  showScreen(
    await makeCampaignHomeScreen(renderer, {
      campaign: fresh,
      onBack: () => navigate(() => showMainMenu("campaigns")),
      onChanged: () => navigate(() => showCampaignHome(fresh)),
      onPlan: (session) => navigate(() => showPlanningChat(fresh, session)),
      onReport: (session) => navigate(() => showReportChat(fresh, session)),
    }),
  );
}

async function showPlanningChat(campaign: Campaign, session: Session): Promise<void> {
  const systemPrompt = await buildPlanningSystemPrompt(campaign, session, settings);
  const ask = makeAskChannel();
  const tools = toolsFor("planning", {
    campaign,
    session,
    ask,
    sourcesDir: settings.sourcesDir,
    defaultSystem: campaign.system,
  });
  showScreen(
    await makeChatScreen(renderer, {
      ...makeChatOptions(),
      title: `Plan Session ${session.number} — ${session.title}`,
      systemPrompt,
      tools,
      chatLog: makeChatLog(campaign, session, "plan"),
      ask,
      completions: campaignCompletions(campaign, settings.sourcesDir),
      onBack: () => navigate(() => showCampaignHome(campaign)),
    }),
  );
}

async function showReportChat(campaign: Campaign, session: Session): Promise<void> {
  const systemPrompt = await buildReportSystemPrompt(campaign, session, settings);
  const ask = makeAskChannel();
  const tools = toolsFor("report", { campaign, session, ask });
  showScreen(
    await makeChatScreen(renderer, {
      ...makeChatOptions(),
      title: `Report Session ${session.number} — ${session.title}`,
      systemPrompt,
      tools,
      chatLog: makeChatLog(campaign, session, "report"),
      ask,
      completions: campaignCompletions(campaign, settings.sourcesDir),
      onBack: () => navigate(() => showCampaignHome(campaign)),
    }),
  );
}

function makeChatLog(campaign: Campaign, session: Session, mode: ChatLogMode): ChatLogStore {
  return {
    load: () => loadChatLog(campaign.dir, session.number, mode),
    save: (messages) => saveChatLog(campaign.dir, session.number, mode, messages),
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
