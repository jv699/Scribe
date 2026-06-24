import {
  createCliRenderer,
  Box,
  TextRenderable,
  Input,
  createTimeline,
  engine,
} from "@opentui/core";
import { makeButton } from "./ui.ts";
import * as consts from "./consts.ts";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});

engine.attach(renderer);

renderer.console.show();
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

const logo = new TextRenderable(renderer, {
  content: consts.logoBloody,
  fg: "#333333",
});

createTimeline()
  .add(logo, {
    duration: 10000,
    ease: "outExpo",
    onUpdate: (anim) => {
      const steps = 5;
      const stepped = Math.round(anim.progress * steps) / steps;
      const dim = { r: 51, g: 51, b: 51 };
      const bright = { r: 255, g: 255, b: 255 };
      const r = Math.round(dim.r + (bright.r - dim.r) * stepped);
      const g = Math.round(dim.g + (bright.g - dim.g) * stepped);
      const b = Math.round(dim.b + (bright.b - dim.b) * stepped);
      logo.fg = `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
      renderer.requestRender();
    },
  })
  .play();

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
    Input({ placeholder: "Enter your name..." }),
    Box({ flexGrow: 2 }),
  ),
);
