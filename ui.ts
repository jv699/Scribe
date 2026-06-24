import { BoxRenderable, TextRenderable, type RenderContext } from "@opentui/core";

export interface ButtonOptions {
  label: string;
  onClick?: () => void;
  variant?: "primary" | "ghost";
}

const BUTTON_COLORS = {
  primary: { border: "#00AAFF", bg: "#003355", fg: "#FFFFFF" },
  ghost: { border: "#FFFFFF", bg: "#222222", fg: "#FFFFFF" },
  hover: "#FFFF00",
} as const;

export function makeButton(ctx: RenderContext, options: ButtonOptions): BoxRenderable {
  const colors = BUTTON_COLORS[options.variant ?? "ghost"];

  const button = new BoxRenderable(ctx, {
    border: true,
    borderStyle: "rounded",
    borderColor: colors.border,
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
    button.borderColor = BUTTON_COLORS.hover;
  };
  button.onMouseOut = () => {
    button.borderColor = colors.border;
  };

  return button;
}
