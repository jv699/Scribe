import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { theme } from "./theme.ts";
import { makeCampaignDialog } from "./components/campaign-dialog.ts";
import { makeMainMenuScreen, type MainMenuView } from "./screens/main-menu.ts";
import { makeCampaignWorkspaceScreen, type SessionChatHost } from "./screens/campaign-workspace.ts";
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
import { buildOneshotSystemPrompt, buildPlanningSystemPrompt } from "./agent/context.ts";
import type { Session } from "./store/sessions.ts";
import { loadChatLog, saveChatLog } from "./store/chat-log.ts";
import { indexSources } from "./store/sources.ts";
import { campaignCompletions, oneshotCompletions } from "./completions.ts";

const renderer = await createCliRenderer({
  // Chat requires a second Ctrl+C to quit; other screens quit immediately.
  exitOnCtrlC: false,
});
renderer.setBackgroundColor(theme.background);

renderer.setTerminalTitle("Scribe");

let settings = await loadSettings();

// Warm the cache without letting indexing failures block startup.
void indexSources(settings.sourcesDir).catch(() => {});

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

// Report failures in the menu: console output is hidden behind the alt screen.
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
      onSelectCampaign: (campaign) => navigate(() => showCampaignWorkspace(campaign)),
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

/** Failed or unsupported metadata lookups leave the header showing the model ID. */
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

function makeChatOptions(): { provider: ChatProvider; model: string; modelInfo: Promise<ModelInfo | undefined> } {
  const model = settings.model ?? DEFAULT_MODEL;
  return {
    provider: createProviderFromSettings(settings),
    model,
    modelInfo: fetchModelInfo(model),
  };
}

async function showOneshotPlanner(): Promise<void> {
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

async function showCampaignWorkspace(campaign: Campaign): Promise<void> {
  // Re-read from disk so external edits (and our own changes) are reflected.
  const fresh = (await loadCampaign(campaign.dir)) ?? campaign;
  showScreen(
    await makeCampaignWorkspaceScreen(renderer, {
      campaign: fresh,
      onBack: () => navigate(() => showMainMenu("campaigns")),
      makeSessionChat: (session, host) => makeCampaignSessionChat(fresh, session, host),
    }),
  );
}

async function makeCampaignSessionChat(
  campaign: Campaign,
  session: Session,
  host: SessionChatHost,
): Promise<Awaited<ReturnType<typeof makeChatScreen>>> {
  const ask = makeAskChannel();
  return makeChatScreen(renderer, {
    ...makeChatOptions(),
    title: `Session ${String(session.number).padStart(3, "0")} — ${session.title}`,
    loadTurnContext: async () => {
      const fresh = (await loadCampaign(campaign.dir)) ?? campaign;
      return {
        systemPrompt: await buildPlanningSystemPrompt(fresh, session, settings),
        tools: toolsFor("planning", {
          campaign: fresh,
          session,
          ask,
          sourcesDir: settings.sourcesDir,
          defaultSystem: fresh.system,
        }),
      };
    },
    chatLog: makeChatLog(campaign, session),
    ask,
    completions: campaignCompletions(campaign, settings.sourcesDir),
    isInputActive: host.isInputActive,
    onInputFocus: host.onInputFocus,
    onStateChange: host.onStateChange,
    onBack: host.onBack,
  });
}

function makeChatLog(campaign: Campaign, session: Session): ChatLogStore {
  return {
    load: () => loadChatLog(campaign.dir, session.number, "plan"),
    save: (messages) => saveChatLog(campaign.dir, session.number, "plan", messages),
  };
}

const campaignDialog = makeCampaignDialog(renderer, {
  onSubmit: (input) => {
    navigate(async () => {
      const campaign = await createCampaign(settings.campaignsDir, input);
      await showCampaignWorkspace(campaign);
    });
  },
  onCancel: () => currentScreen?.focus?.(),
});
renderer.root.add(campaignDialog.layer);

await showMainMenu();
