/**
 * Shared UI primitives: `makeAccentPanel` — the accent-strip surface used by
 * the prompt box and user chat messages — `makeButton` — flat, borderless
 * buttons colored from the app theme, with hover/focus highlight and click +
 * Enter support — and `tabWalk` — Tab / Shift+Tab focus traversal along a
 * chain of renderables.
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

export interface AccentPanelOptions {
  /** Vertical spacing above the panel. Defaults to 1. */
  marginTop?: number;
  /** Padding inside the surface. Defaults to { left: 2, right: 2, top: 1, bottom: 1 }. */
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
}

export interface AccentPanel {
  /** Accent-bordered outer box — add this to a column layout. */
  node: BoxRenderable;
  /** Inner padded surface — add content here. */
  panel: BoxRenderable;
}

/**
 * The accent-strip panel that gives the prompt box its look: a burnt-orange
 * line down the left edge over a raised surface. Extracted so user chat
 * messages (and anything else) can share the same treatment.
 */
export function makeAccentPanel(ctx: RenderContext, options: AccentPanelOptions = {}): AccentPanel {
  const node = new BoxRenderable(ctx, {
    width: "100%",
    flexShrink: 0,
    border: ["left"],
    borderColor: theme.accent,
    marginTop: options.marginTop ?? 1,
  });

  const panel = new BoxRenderable(ctx, {
    width: "100%",
    flexDirection: "column",
    paddingLeft: options.padding?.left ?? 2,
    paddingRight: options.padding?.right ?? 2,
    paddingTop: options.padding?.top ?? 1,
    paddingBottom: options.padding?.bottom ?? 1,
    backgroundColor: theme.surfaceActive,
  });
  node.add(panel);

  return { node, panel };
}

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
