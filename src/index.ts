/**
 * Entry point: sets up the renderer, loads settings, and owns the screen
 * manager (one `Screen` at a time under the renderer root) plus the
 * campaign-create dialog and app-level navigation wiring.
 */
import { createCliRenderer } from "@opentui/core";
import { theme } from "./theme.ts";
import { makeCampaignDialog } from "./components/campaign-dialog.ts";
import { makeMainMenuScreen } from "./screens/main-menu.ts";
import { makeCampaignHomeScreen } from "./screens/campaign-home.ts";
import { makeSettingsScreen } from "./screens/settings.ts";
import { makeChatScreen, type ChatLogStore } from "./screens/chat.ts";
import type { Screen } from "./screens/screen.ts";
import { loadSettings, saveSettings } from "./store/settings.ts";
import { createCampaign, listCampaigns, loadCampaign, type Campaign } from "./store/campaigns.ts";
import { createProviderFromSettings, DEFAULT_BASE_URL, DEFAULT_MODEL, listModelInfos } from "./provider/openai.ts";
import type { ChatProvider, ModelInfo } from "./provider/types.ts";
import { toolsFor } from "./agent/agents.ts";
import { makeAskChannel } from "./agent/ask.ts";
import { buildOneshotSystemPrompt, buildPlanningSystemPrompt, buildReportSystemPrompt } from "./agent/context.ts";
import { listSessions, type Session } from "./store/sessions.ts";
import { loadChatLog, saveChatLog, type ChatLogMode } from "./store/chat-log.ts";
import { indexSources, listSources } from "./store/sources.ts";
import type { CompletionItem, CompletionSource } from "./components/autocomplete.ts";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
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
      onOneshotPlanner: () => navigate(showOneshotPlanner),
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
  showScreen(
    await makeChatScreen(renderer, {
      ...makeChatOptions(),
      title: "Drafting Table",
      systemPrompt: await buildOneshotSystemPrompt(settings.sourcesDir),
      // Granted save_session via the gateway; declined when no one-shots dir is configured.
      tools: toolsFor("oneshot", { oneshotsDir: settings.oneshotsDir, sourcesDir: settings.sourcesDir, ask }),
      ask,
      completions: sourceCompletions(settings.sourcesDir),
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
  const systemPrompt = await buildPlanningSystemPrompt(campaign, session, settings.sourcesDir);
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
  const systemPrompt = await buildReportSystemPrompt(campaign, session);
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

/**
 * Case-insensitive filter over label+description, shared by every `@` source
 * below so each one only has to build its full item list.
 */
function filterCompletions(items: CompletionItem[], query: string): CompletionItem[] {
  const needle = query.toLowerCase();
  if (needle === "") return items;
  return items.filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(needle));
}

/**
 * `@` items for the source-document library: one per PDF, picking one inserts
 * a plain-language reference — "the ... source document" — rather than the
 * `@slug` markup, because that is what `search_sources`/`read_source_pages`
 * can act on, not a token the model has never been taught.
 */
async function sourceItems(sourcesDir: string): Promise<CompletionItem[]> {
  const docs = await listSources(sourcesDir);
  return docs.map((doc) => ({
    label: `@${doc.slug}`,
    description: `${doc.system} · ${doc.pages} page${doc.pages === 1 ? "" : "s"}`,
    insert: `the "${doc.title}" source document`,
  }));
}

/** `@` completions for the Drafting Table, which has no campaign — sources only. */
function sourceCompletions(sourcesDir: string): CompletionSource[] {
  return [
    {
      trigger: "@",
      items: async (query) => filterCompletions(await sourceItems(sourcesDir), query),
    },
  ];
}

/**
 * `@` mentions for a campaign chat: the campaign's two summary documents,
 * every session, and the source-document library. Picking one inserts a
 * plain-language reference rather than a markup token, because that is what
 * the agent can act on — "session 3 ("The Bell Tower")" points straight at
 * `read_session_notes(3)`, whereas `@session-3` would be syntax the model has
 * never been taught.
 *
 * Resolved on each keystroke rather than snapshotted, so sessions added while
 * the chat is open (or edited on disk) show up.
 */
function campaignCompletions(campaign: Campaign, sourcesDir: string): CompletionSource[] {
  return [
    {
      trigger: "@",
      items: async (query) => {
        const fresh = (await loadCampaign(campaign.dir)) ?? campaign;
        const sessions = await listSessions(fresh);
        const items: CompletionItem[] = [
          {
            label: "@background",
            description: "The campaign premise",
            insert: "the campaign background",
          },
          {
            label: "@story-so-far",
            description: "The running campaign summary",
            insert: "the campaign's story so far",
          },
          ...sessions.map((session) => ({
            label: `@session-${session.number}`,
            description: `${session.title} · ${session.status}`,
            insert: `session ${session.number} ("${session.title}")`,
          })),
          ...(await sourceItems(sourcesDir)),
        ];

        // Match titles too, so "@bell" finds the session called "The Bell
        // Tower" and not just labels that happen to start that way.
        return filterCompletions(items, query);
      },
    },
  ];
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
