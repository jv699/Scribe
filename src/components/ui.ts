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
  marginTop?: number;
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
}

export interface AccentPanel {
  node: BoxRenderable;
  /** Add panel content here. */
  panel: BoxRenderable;
}

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

// Select rows share one frame buffer; these internal fields enable mouse hit-testing.
interface SelectRowLayout {
  scrollOffset: number;
  linesPerItem: number;
}

export function enableSelectMouse(select: SelectRenderable, isEnabled: () => boolean = () => true): void {
  const layout = select as unknown as SelectRowLayout;

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
    // Keep subsequent arrow keys on the clicked list.
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

export function tabWalk(renderer: CliRenderer, focusChain: readonly Renderable[], key: KeyEvent): boolean {
  if (key.name !== "tab" || focusChain.length === 0) return false;
  key.preventDefault();
  const index = focusChain.indexOf(renderer.currentFocusedRenderable as Renderable);
  const direction = key.shift ? -1 : 1;
  focusChain[(index + direction + focusChain.length) % focusChain.length]?.focus();
  return true;
}
