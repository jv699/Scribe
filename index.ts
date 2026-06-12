import { createCliRenderer, Box, Text, BoxRenderable, Input } from "@opentui/core";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});

renderer.console.show();
renderer.toggleDebugOverlay();

renderer.setTerminalTitle("Scribe");

//get theme
const mode = await renderer.waitForThemeMode(1000);
console.log(mode);

// renderer.setBackgroundColor("red");

const button = new BoxRenderable(renderer, {
  id: "button",
  border: true,
  onMouseDown: (event) => {
    console.log("Clicked at", event.x, event.y)
  },
  onMouseOver: (event) => {
    button.borderColor = "#FFFF00"
  },
  onMouseOut: (event) => {
    button.borderColor = "#FFFFFF"
  },
});


renderer.root.add(
  Box(
    { width: 40, height: 10, borderStyle: "rounded", padding: 1 },
    Text({ content: "Welcome!" }),
    Input({ placeholder: "Enter your name..." }),
    button
  ),
);
