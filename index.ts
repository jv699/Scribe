import { createCliRenderer, Box, Text, Input } from "@opentui/core";
import { makeButton } from "./ui.ts";
import * as consts from "./consts.ts";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});

renderer.console.show();
renderer.toggleDebugOverlay();

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

// renderer.setBackgroundColor("red");

renderer.root.add(
  Box(
    { width: "100%", height: "100%", borderStyle: "rounded", padding: 1 },
    Text({ content: consts.logoBloody }),
    Input({ placeholder: "Enter your name..." }),
  ),
);
