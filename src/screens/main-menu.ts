import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  CliRenderEvents,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core";
import { enableSelectMouse } from "../components/ui.ts";
import * as consts from "../consts.ts";
import { chunkyFadeIn, dissolveIn } from "../intro.ts";
import { theme } from "../theme.ts";
import { truncate } from "../format.ts";
import { VERSION } from "../version.ts";
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

const MIN_MENU_WIDTH = 30;
/** Campaign names longer than this are cut so the system column stays in reach. */
const MAX_NAME_COLUMN = 40;
/** The row's left inset and selection marker, plus a column for the scroll indicator. */
const MENU_ROW_INSET = 4;

export function makeMainMenuScreen(renderer: CliRenderer, options: MainMenuOptions): Screen {
  const rootOptions: SelectOption[] = [
    { name: "Campaigns", description: "", value: MenuOptions.CAMPAIGNS },
    { name: "Drafting Table", description: "one-shot and ideas planner", value: MenuOptions.DRAFTING_TABLE },
    { name: "Settings", description: "", value: MenuOptions.SETTINGS },
    { name: "Quit", description: "", value: MenuOptions.QUIT },
  ];
  // Each campaign's system sits in an aligned column after its name. Rows are
  // cut to the menu's width in fit(), so keep these originals to cut from.
  const nameWidth = Math.min(MAX_NAME_COLUMN, Math.max(0, ...options.campaigns.map((c) => c.name.length)));
  const campaignRow = (c: Campaign): string =>
    c.system ? `${truncate(c.name, nameWidth).padEnd(nameWidth)}  ${c.system}` : c.name;
  const campaignOptions: SelectOption[] = [
    ...options.campaigns.map((c) => ({ name: campaignRow(c), description: c.system, value: MenuOptions.SHOW_CAMPAIGN })),
    { name: "Create Campaign", description: "", value: MenuOptions.CREATE },
    { name: "← Back", description: "", value: MenuOptions.BACK },
  ];
  let view: MainMenuView = options.initialView ?? "root";
  const initialOptions = view === "campaigns" ? campaignOptions : rootOptions;
  const rootSelectedIndex = 0;

  const mainMenu = new SelectRenderable(renderer, {
    width: MIN_MENU_WIDTH,
    height: initialOptions.length,
    showScrollIndicator: true,
    showDescription: false,
    options: initialOptions,
    selectedIndex: view === "root" ? rootSelectedIndex : 0,
    selectedBackgroundColor: theme.accent,
    selectedTextColor: theme.text,
  });

  enableSelectMouse(mainMenu);

  const menuPanel = new BoxRenderable(renderer, { alignItems: "center" });
  const noCampaigns = new TextRenderable(renderer, {
    content: "No campaigns yet. Create one to get started.",
    fg: theme.textMuted,
    marginBottom: 1,
  });
  menuPanel.add(noCampaigns);
  menuPanel.add(mainMenu);

  function showView(nextView: MainMenuView): void {
    view = nextView;
    const nextOptions = view === "campaigns" ? campaignOptions : rootOptions;
    mainMenu.options = nextOptions;
    mainMenu.setSelectedIndex(view === "root" ? rootSelectedIndex : 0);
    fit();
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
    const campaign = options.campaigns[index];
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
  const logoHeight = consts.logoBloody.split("\n").length;

  /**
   * Size the menu to the terminal: as wide as its longest row allows, and as
   * tall as its rows, until that would push past the screen. Then the logo
   * steps aside first, and only after that does the list scroll.
   */
  function fit(): void {
    const source = view === "campaigns" ? campaignOptions : rootOptions;
    const longest = Math.max(...source.map((option) => option.name.length));
    const width = Math.max(MIN_MENU_WIDTH, Math.min(longest + MENU_ROW_INSET, renderer.width - 4));
    mainMenu.width = width;
    const selected = mainMenu.getSelectedIndex();
    mainMenu.options = source.map((option) => ({ ...option, name: truncate(option.name, width - MENU_ROW_INSET) }));
    mainMenu.setSelectedIndex(selected);

    // Container padding, the version line, and the error with its margin.
    const errorLines = options.error ? Math.ceil(options.error.length / Math.max(1, renderer.width - 2)) + 1 : 0;
    noCampaigns.visible = view === "campaigns" && options.campaigns.length === 0;
    const room = renderer.height - 3 - errorLines - (noCampaigns.visible ? 2 : 0);
    logo.visible = room >= logoHeight + source.length;
    mainMenu.height = Math.max(1, Math.min(source.length, room - (logo.visible ? logoHeight : 0)));
  }

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
  container.add(new TextRenderable(renderer, { content: `v${VERSION}`, fg: theme.textMuted, alignSelf: "flex-end" }));

  fit();
  renderer.on(CliRenderEvents.RESIZE, fit);

  const stopAnimations = options.playIntro
    ? [dissolveIn(logo, consts.logoBloody), chunkyFadeIn(menuPanel, { delayMs: 500 })]
    : [];

  return {
    node: container,
    focus: () => mainMenu.focus(),
    dispose: () => {
      renderer.keyInput.off("keypress", onScreenKeypress);
      renderer.off(CliRenderEvents.RESIZE, fit);
      for (const stop of stopAnimations) stop();
    },
  };
}
