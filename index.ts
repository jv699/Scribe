import {
  createCliRenderer,
  Box,
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type SelectOption,
} from "@opentui/core";
import { makeButton } from "./ui.ts";
import * as consts from "./consts.ts";
import { chunkyFadeIn, dissolveIn } from "./intro.ts";
import { addCampaign } from "./campaigns.ts";
import { makeCampaignDialog } from "./campaign-dialog.ts";
import { main } from "bun";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});

// renderer.console.show();
// renderer.toggleDebugOverlay();

renderer.setTerminalTitle("Scribe");

//get theme
const mode = await renderer.waitForThemeMode(1000);
console.log(mode);

const mainMenu = new SelectRenderable(renderer, {
  width: 30,
  height: 2,
  showDescription: false,
  options: [
    { name: "Create New Campaign", description: "" },
    { name: "Option 2", description: "" },
  ],
  selectedBackgroundColor: "#333333",
  selectedTextColor: "#FFFFFF",
});

const menuPanel = new BoxRenderable(renderer, {});
menuPanel.add(mainMenu);

const campaignDialog = makeCampaignDialog(renderer, {
  onSubmit: (campaign) => {
    addCampaign(campaign);
    mainMenu.options = [
      ...mainMenu.options,
      { name: campaign.name, description: campaign.description },
    ];
    mainMenu.focus();
  },
  onCancel: () => {
    mainMenu.focus();
  },
});
renderer.root.add(campaignDialog.layer);

mainMenu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: SelectOption) => {
  if (index === 0) {
    campaignDialog.open();
    return;
  }
  console.log(`Selected index ${index}: ${option.name}`)
});

const logo = new TextRenderable(renderer, { content: consts.logoBloody });

renderer.root.add(
  Box(
    {
      width: "100%",
      height: "100%",
      padding: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    Box({ flexGrow: 0.5 }),
    logo,
    menuPanel,
    Box({ flexGrow: 2 }),
  ),
);

// 90's videogame intro: logo dissolves in char-by-char through the shade
// ramp, then the menu fades up in discrete brightness steps.
dissolveIn(logo, consts.logoBloody);
chunkyFadeIn(menuPanel, { delayMs: 500 });

mainMenu.focus();
