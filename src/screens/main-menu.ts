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
  onQuit: () => void;
}

export function makeMainMenuScreen(renderer: CliRenderer, options: MainMenuOptions): Screen {
  const menuOptions: SelectOption[] = [
    { name: "Create New Campaign", description: "" },
    ...options.campaigns.map((c) => ({ name: c.name, description: c.system })),
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

  const menuPanel = new BoxRenderable(renderer, {});
  menuPanel.add(mainMenu);

  mainMenu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    if (index === 0) {
      options.onCreateCampaign();
      return;
    }
    if (index === menuOptions.length - 1) {
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
  container.add(new BoxRenderable(renderer, { flexGrow: 2 }));

  if (options.playIntro) {
    dissolveIn(logo, consts.logoBloody);
    chunkyFadeIn(menuPanel, { delayMs: 500 });
  }

  return { node: container, focus: () => mainMenu.focus() };
}
