/**
 * Main menu screen: create campaign / campaign list (loaded from disk) /
 * quit, with the 90's intro animation on first show.
 */
import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type SelectOption,
} from "@opentui/core";
import { enableSelectMouse } from "../components/ui.ts";
import * as consts from "../consts.ts";
import { chunkyFadeIn, dissolveIn } from "../intro.ts";
import { theme } from "../theme.ts";
import type { Campaign } from "../store/campaigns.ts";
import type { Screen } from "./screen.ts";

export interface MainMenuOptions {
  campaigns: Campaign[];
  /** Play the 90's intro animation (only on first show). */
  playIntro: boolean;
  onCreateCampaign: () => void;
  onSelectCampaign: (campaign: Campaign) => void;
  onSettings: () => void;
  /** Open the one-shot planner (Drafting Table) — free-form ideas chat. */
  onOneshotPlanner: () => void;
  onQuit: () => void;
  /** Message from a failed navigation, shown under the menu. */
  error?: string | undefined;
}

export function makeMainMenuScreen(renderer: CliRenderer, options: MainMenuOptions): Screen {
  const menuOptions: SelectOption[] = [
    { name: "Create New Campaign", description: "" },
    ...options.campaigns.map((c) => ({ name: c.name, description: c.system })),
    { name: "Settings", description: "" },
    { name: "Drafting Table", description: "one-shot and ideas planner" },
    { name: "Quit", description: "" },
  ];

  const mainMenu = new SelectRenderable(renderer, {
    width: 30,
    height: menuOptions.length,
    showDescription: false,
    options: menuOptions,
    selectedBackgroundColor: theme.accent,
    selectedTextColor: theme.text,
  });

  enableSelectMouse(mainMenu);

  const menuPanel = new BoxRenderable(renderer, {});
  menuPanel.add(mainMenu);

  const createIndex = 0;
  const settingsIndex = 1 + options.campaigns.length;
  const oneshotIndex = settingsIndex + 1;
  const quitIndex = oneshotIndex + 1;

  mainMenu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    if (index === createIndex) {
      options.onCreateCampaign();
      return;
    }
    if (index === settingsIndex) {
      options.onSettings();
      return;
    }
    if (index === oneshotIndex) {
      options.onOneshotPlanner();
      return;
    }
    if (index === quitIndex) {
      options.onQuit();
      return;
    }
    const campaign = options.campaigns[index - 1];
    if (campaign) options.onSelectCampaign(campaign);
  });

  const logo = new TextRenderable(renderer, { content: consts.logoBloody, fg: theme.text });

  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    padding: 1,
    justifyContent: "center",
    alignItems: "center",
  });
  container.add(new BoxRenderable(renderer, { flexGrow: 0.5 }));
  container.add(logo);
  container.add(menuPanel);
  if (options.error) {
    container.add(new TextRenderable(renderer, { content: options.error, fg: theme.danger, marginTop: 1 }));
  }
  container.add(new BoxRenderable(renderer, { flexGrow: 2 }));

  if (options.playIntro) {
    dissolveIn(logo, consts.logoBloody);
    chunkyFadeIn(menuPanel, { delayMs: 500 });
  }

  // No dispose(): this screen registers no renderer-level listeners of its own
  // (SelectRenderable handles its own focus). Anything added here that does —
  // a keypress handler, a timer — must be torn down like the other screens do.
  return { node: container, focus: () => mainMenu.focus() };
}
