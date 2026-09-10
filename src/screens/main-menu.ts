import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core";
import { enableSelectMouse } from "../components/ui.ts";
import * as consts from "../consts.ts";
import { chunkyFadeIn, dissolveIn } from "../intro.ts";
import { theme } from "../theme.ts";
import type { Campaign } from "../store/campaigns.ts";
import type { Screen } from "./screen.ts";

export type MainMenuView = "root" | "campaigns";

export interface MainMenuOptions {
  campaigns: Campaign[];
  /** Menu stage shown initially. Defaults to the top-level menu. */
  initialView?: MainMenuView;
  playIntro: boolean;
  onCreateCampaign: () => void;
  onSelectCampaign: (campaign: Campaign) => void;
  onSettings: () => void;
  onOneshotPlanner: () => void;
  onQuit: () => void;
  /** Message from a failed navigation, shown under the menu. */
  error?: string | undefined;
}

enum MenuOptions {
  BACK,
  CREATE,
  SHOW_CAMPAIGN,
  CAMPAIGNS,
  DRAFTING_TABLE,
  SETTINGS,
  QUIT,
}

export function makeMainMenuScreen(renderer: CliRenderer, options: MainMenuOptions): Screen {
  const rootOptions: SelectOption[] = [
    { name: "Campaigns", description: "", value: MenuOptions.CAMPAIGNS },
    { name: "Drafting Table", description: "one-shot and ideas planner", value: MenuOptions.DRAFTING_TABLE },
    { name: "Settings", description: "", value: MenuOptions.SETTINGS },
    { name: "Quit", description: "", value: MenuOptions.QUIT },
  ];
  const campaignOptions: SelectOption[] = [
    ...options.campaigns.map((c) => ({ name: c.name, description: c.system, value: MenuOptions.SHOW_CAMPAIGN })),
    { name: "Create Campaign", description: "", value: MenuOptions.CREATE },
    { name: "← Back", description: "", value: MenuOptions.BACK },
  ];
  let view: MainMenuView = options.initialView ?? "root";
  const initialOptions = view === "campaigns" ? campaignOptions : rootOptions;
  const rootSelectedIndex = 0;

  const mainMenu = new SelectRenderable(renderer, {
    width: 30,
    height: initialOptions.length,
    showDescription: false,
    options: initialOptions,
    selectedIndex: view === "root" ? rootSelectedIndex : 0,
    selectedBackgroundColor: theme.accent,
    selectedTextColor: theme.text,
  });

  enableSelectMouse(mainMenu);

  const menuPanel = new BoxRenderable(renderer, {});
  menuPanel.add(mainMenu);

  function showView(nextView: MainMenuView): void {
    view = nextView;
    const nextOptions = view === "campaigns" ? campaignOptions : rootOptions;
    mainMenu.options = nextOptions;
    mainMenu.height = nextOptions.length;
    mainMenu.setSelectedIndex(view === "root" ? rootSelectedIndex : 0);
  }

  mainMenu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: SelectOption) => {
    if (view === "root") {
      if (option.value === MenuOptions.CAMPAIGNS) showView("campaigns");
      else if (option.value === MenuOptions.DRAFTING_TABLE) options.onOneshotPlanner();
      else if (option.value === MenuOptions.SETTINGS) options.onSettings();
      else if (option.value === MenuOptions.QUIT) options.onQuit();
      return;
    }

    if (option.value === MenuOptions.BACK) {
      showView("root");
      return;
    }
    if (option.value === MenuOptions.CREATE) {
      options.onCreateCampaign();
      return;
    }
    const campaign = options.campaigns[index - 2];
    if (campaign) options.onSelectCampaign(campaign);
  });

  const onScreenKeypress = (key: KeyEvent): void => {
    if (key.name === "escape" && view === "campaigns" && renderer.currentFocusedRenderable === mainMenu) {
      key.preventDefault();
      showView("root");
    }
  };
  renderer.keyInput.on("keypress", onScreenKeypress);

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

  const stopAnimations = options.playIntro
    ? [dissolveIn(logo, consts.logoBloody), chunkyFadeIn(menuPanel, { delayMs: 500 })]
    : [];

  return {
    node: container,
    focus: () => mainMenu.focus(),
    dispose: () => {
      renderer.keyInput.off("keypress", onScreenKeypress);
      for (const stop of stopAnimations) stop();
    },
  };
}
