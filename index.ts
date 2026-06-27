import { createCliRenderer, Box, Text, SelectRenderable } from "@opentui/core";
import { makeButton } from "./ui.ts";
import * as consts from "./consts.ts";
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

const button = makeButton(renderer, {
  label: "Click me!",
  onClick: () => {
    console.log("test");
  },
});

const mainMenu = new SelectRenderable(renderer, {
  width: 30,
  height: 8,
  options: [
    { name: "Create New Campaign", description: "test desc" },
    { name: "Option 2", description: "test" },
  ],
});

const menuPanel = Box(
  {
    borderStyle: "single",
    borderColor: "#666",
  },
  mainMenu,
)

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
