import { createCliRenderer, Box, Text } from "@opentui/core";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});

renderer.console.show();
renderer.setTerminalTitle("Scribe")

//get theme
const mode = await renderer.waitForThemeMode(1000);
console.log(mode);

// renderer.setBackgroundColor("red");

renderer.root.add(
  Box(
    { borderStyle: "rounded", padding: 1, flexDirection: "column", gap: 1 },
    Text({ content: "Welcome", fg: "#FFFF00" }),
    Text({ content: "Press Ctrl+C to exit" }),
  ),
);
