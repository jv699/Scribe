import { BoxRenderable, RenderableEvents, TextRenderable, type RenderContext } from "@opentui/core";

export interface ButtonOptions {
  label: string;
  onClick?: () => void;
  variant?: "primary" | "ghost";
}

const BUTTON_COLORS = {
  primary: { border: "#00AAFF", bg: "#003355", fg: "#FFFFFF" },
  ghost: { border: "#FFFFFF", bg: "#222222", fg: "#FFFFFF" },
  hover: "#333333",
} as const;

export function makeButton(ctx: RenderContext, options: ButtonOptions): BoxRenderable {
  const colors = BUTTON_COLORS[options.variant ?? "ghost"];

  const button = new BoxRenderable(ctx, {
    backgroundColor: colors.bg,
    padding: 1,
    focusable: true,
  });

  const label = new TextRenderable(ctx, {
    content: options.label,
    fg: colors.fg,
  });
  button.add(label);

  button.onMouseDown = () => {
    options.onClick?.();
  };
  button.onMouseOver = () => {
    button.backgroundColor = BUTTON_COLORS.hover;
  };
  button.onMouseOut = () => {
    button.backgroundColor = colors.bg;
  };
  button.on(RenderableEvents.FOCUSED, () => {
    button.backgroundColor = BUTTON_COLORS.hover;
  });
  button.on(RenderableEvents.BLURRED, () => {
    button.backgroundColor = colors.bg;
  });

  return button;
}
