/**
 * Shared UI primitives: `makeAccentPanel` — the accent-strip surface used by
 * the prompt box and user chat messages — `makeButton` — flat, borderless
 * buttons colored from the app theme, with hover/focus highlight and click +
 * Enter support — `enableSelectMouse` — hover/click/scroll support for
 * `SelectRenderable` menus — and `tabWalk` — Tab / Shift+Tab focus traversal
 * along a chain of renderables.
 */
import {
  BoxRenderable,
  RenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type RenderContext,
  type SelectRenderable,
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
  primary: {
    idle: theme.accent,
    active: theme.flameCore,
    text: theme.text,
  },
  ghost: {
    idle: theme.textMuted,
    active: theme.flameCore,
    text: theme.text,
  },
} as const;

export function makeButton(ctx: RenderContext, options: ButtonOptions): BoxRenderable {
  const colors = BUTTON_COLORS[options.variant ?? "ghost"];

  const button = new BoxRenderable(ctx, {
    borderColor: colors.idle,
    paddingLeft: 2,
    paddingRight: 2,
    border: true,
    focusable: true,
  });

  const label = new TextRenderable(ctx, {
    content: options.label,
    fg: colors.text,
  });
  button.add(label);

  function setActive(active: boolean): void {
    // OpenTUI destroys children before blurring their parent. Do not repaint
    // the label once either half of the button has begun destruction.
    if (button.isDestroyed || label.isDestroyed) return;

    const color = active ? colors.active : colors.idle;
    button.borderColor = color;
    label.fg = active ? colors.active : colors.text;
  }

  button.onMouseDown = () => {
    options.onClick?.();
  };
  button.onKeyDown = (key) => {
    if (key.name === "return" || key.name === "kpenter") options.onClick?.();
  };
  button.onMouseOver = () => setActive(true);
  button.onMouseOut = () => setActive(false);
  button.on(RenderableEvents.FOCUSED, () => setActive(true));
  button.on(RenderableEvents.BLURRED, () => setActive(false));

  return button;
}

/**
 * `SelectRenderable` draws its rows into one frame buffer rather than as child
 * renderables, so there is nothing per-row to attach a click handler to. These
 * are the layout fields it uses to place rows; we read them back to map a
 * mouse y-coordinate to an option index.
 */
interface SelectRowLayout {
  /** Index of the first visible option. */
  scrollOffset: number;
  /** Terminal rows each option occupies (name + description + itemSpacing). */
  linesPerItem: number;
}

/**
 * Make a `SelectRenderable`'s rows mouse-driven: hover highlights an option,
 * click selects it (same as Enter), and the wheel moves the selection. Keyboard
 * behaviour is untouched, so this is purely additive.
 */
export function enableSelectMouse(select: SelectRenderable, isEnabled: () => boolean = () => true): void {
  const layout = select as unknown as SelectRowLayout;

  /** The option under an absolute terminal y, or null if the row is empty. */
  function optionAt(y: number): number | null {
    if (!isEnabled()) return null;
    const row = y - select.y;
    if (row < 0 || layout.linesPerItem <= 0) return null;
    const index = layout.scrollOffset + Math.floor(row / layout.linesPerItem);
    return index < select.options.length ? index : null;
  }

  select.onMouseMove = (event) => {
    const index = optionAt(event.y);
    if (index !== null) select.setSelectedIndex(index);
  };
  select.onMouseDown = (event) => {
    const index = optionAt(event.y);
    if (index === null) return;
    // Click implies intent to drive this list — take focus so the arrow keys
    // keep working afterwards (dialogs and prompts may hold focus otherwise).
    select.focus();
    select.setSelectedIndex(index);
    select.selectCurrent();
  };
  select.onMouseScroll = (event) => {
    if (!isEnabled()) return;
    if (event.scroll?.direction === "up") select.moveUp();
    else if (event.scroll?.direction === "down") select.moveDown();
  };
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
