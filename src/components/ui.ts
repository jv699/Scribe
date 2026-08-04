/**
 * Shared UI primitives: `makeButton` — flat, borderless buttons colored from
 * the app theme, with hover/focus highlight and click + Enter support — and
 * `tabWalk` — Tab / Shift+Tab focus traversal along a chain of renderables.
 */
import {
  BoxRenderable,
  RenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type RenderContext,
} from "@opentui/core";
import { theme } from "../theme.ts";

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
  button.onKeyDown = (key) => {
    if (key.name === "return") options.onClick?.();
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

/**
 * Walk focus along a chain of renderables for Tab / Shift+Tab. Returns true
 * if the key was a handled Tab (so callers can return early).
 */
export function tabWalk(renderer: CliRenderer, focusChain: readonly Renderable[], key: KeyEvent): boolean {
  if (key.name !== "tab" || focusChain.length === 0) return false;
  key.preventDefault();
  const index = focusChain.indexOf(renderer.currentFocusedRenderable as Renderable);
  const direction = key.shift ? -1 : 1;
  focusChain[(index + direction + focusChain.length) % focusChain.length]?.focus();
  return true;
}
