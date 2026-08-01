/**
 * Entry point: sets up the renderer, loads settings, and owns the screen
 * manager (one `Screen` at a time under the renderer root) plus the
 * campaign-create dialog and app-level navigation wiring.
 */
import { createCliRenderer } from "@opentui/core";
import { makeCampaignDialog } from "./campaign-dialog.ts";
import { makeMainMenuScreen } from "./screens/main-menu.ts";
import { makeCampaignHomeScreen } from "./screens/campaign-home.ts";
import { makeSettingsScreen } from "./screens/settings.ts";
import { makeChatScreen } from "./screens/chat.ts";
import type { Screen } from "./screens/screen.ts";
import { loadSettings, saveSettings } from "./store/settings.ts";
import { createCampaign, listCampaigns, loadCampaign, type Campaign } from "./store/campaigns.ts";
import { createProviderFromSettings, DEFAULT_MODEL } from "./provider/openai.ts";

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

async function showMainMenu(): Promise<void> {
  const campaigns = await listCampaigns(settings.campaignsDir);
  showScreen(
    makeMainMenuScreen(renderer, {
      campaigns,
      playIntro: !introPlayed,
      onCreateCampaign: () => campaignDialog.open(),
      onSelectCampaign: (campaign) => void showCampaignHome(campaign),
      onSettings: () => void showSettingsScreen(),
      onChat: () => void showChatScreen(),
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
        await showMainMenu();
      },
      onBack: () => void showMainMenu(),
    }),
  );
}

async function showChatScreen(): Promise<void> {
  showScreen(
    await makeChatScreen(renderer, {
      provider: createProviderFromSettings(settings),
      model: settings.model ?? DEFAULT_MODEL,
      onBack: () => void showMainMenu(),
    }),
  );
}

async function showCampaignHome(campaign: Campaign): Promise<void> {
  // Re-read from disk so external edits (and our own changes) are reflected.
  const fresh = (await loadCampaign(campaign.dir)) ?? campaign;
  showScreen(
    await makeCampaignHomeScreen(renderer, {
      campaign: fresh,
      onBack: () => void showMainMenu(),
      onChanged: () => void showCampaignHome(fresh),
    }),
  );
}

const campaignDialog = makeCampaignDialog(renderer, {
  onSubmit: (input) => {
    void (async () => {
      const campaign = await createCampaign(settings.campaignsDir, input);
      await showCampaignHome(campaign);
    })();
  },
  onCancel: () => currentScreen?.focus?.(),
});
renderer.root.add(campaignDialog.layer);

await showMainMenu();
