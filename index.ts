import { createCliRenderer, Box, Text, SelectRenderable, SelectRenderableEvents, type SelectOption } from "@opentui/core";
import { makeButton } from "./ui.ts";
import * as consts from "./consts.ts";
import { main } from "bun";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});

renderer.console.show();
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

const menuPanel = Box(
  {
  },
  mainMenu,
);

mainMenu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: SelectOption) => {
  console.log(`Selected index ${index}: ${option.name}`)
});

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
    Text({ content: consts.logoBloody }),
    menuPanel,
    Box({ flexGrow: 2 }),
  ),
);

mainMenu.focus();
