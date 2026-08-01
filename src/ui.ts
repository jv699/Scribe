/**
 * Shared UI primitive: `makeButton` — flat, borderless buttons colored from
 * the app theme, with hover/focus highlight and click + Enter support.
 */
import { BoxRenderable, RenderableEvents, TextRenderable, type RenderContext } from "@opentui/core";
import { theme } from "./theme.ts";

export interface ButtonOptions {
  label: string;
  onClick?: () => void;
  variant?: "primary" | "ghost";
}

const BUTTON_COLORS = {
  primary: { bg: theme.accent, fg: theme.text, hover: theme.accentHover },
  ghost: { bg: theme.surfaceRaised, fg: theme.text, hover: theme.surfaceActive },
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
    button.backgroundColor = colors.hover;
  };
  button.onMouseOut = () => {
    button.backgroundColor = colors.bg;
  };
  button.on(RenderableEvents.FOCUSED, () => {
    button.backgroundColor = colors.hover;
  });
  button.on(RenderableEvents.BLURRED, () => {
    button.backgroundColor = colors.bg;
  });

  return button;
}
