/**
 * Two-stage main menu: top-level app destinations, then campaign creation and
 * the campaign list, with the 90's intro animation on first show.
 */
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

// Campaign building remains available behind the root menu so it can keep
// evolving without being exposed in the initial release.
const CAMPAIGNS_ENABLED: boolean = false;

export interface MainMenuOptions {
  campaigns: Campaign[];
  /** Menu stage shown initially. Defaults to the top-level menu. */
  initialView?: MainMenuView;
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
  const rootOptions: SelectOption[] = [
    { name: CAMPAIGNS_ENABLED ? "Campaigns" : "Campaigns (Coming Soon)", description: "" },
    { name: "Drafting Table", description: "one-shot and ideas planner" },
    { name: "Settings", description: "" },
    { name: "Quit", description: "" },
  ];
  const campaignOptions: SelectOption[] = [
    { name: "Back", description: "" },
    { name: "Create Campaign", description: "" },
    ...options.campaigns.map((c) => ({ name: c.name, description: c.system })),
  ];
  let view: MainMenuView = options.initialView ?? "root";
  const initialOptions = view === "campaigns" ? campaignOptions : rootOptions;
  const rootSelectedIndex = CAMPAIGNS_ENABLED ? 0 : 1;

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

  mainMenu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    if (view === "root") {
      if (index === 0 && CAMPAIGNS_ENABLED) showView("campaigns");
      else if (index === 1) options.onOneshotPlanner();
      else if (index === 2) options.onSettings();
      else if (index === 3) options.onQuit();
      return;
    }

    if (index === 0) {
      showView("root");
      return;
    }
    if (index === 1) {
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
