/**
 * Dice spinner: a rolling die for the "thinking" indicator, built on
 * `opentui-spinner`. Cycles the six faces (tumbling, not counting) in a fire
 * gradient — the fates decide. `DiceSpinnerRenderable` is a drop-in for the
 * plain spinner — `start()` shows it, `stop()` hides it so it never leaves a
 * gap in the layout.
 */
import { createPulse, SpinnerRenderable } from "opentui-spinner";
import type { CliRenderer } from "@opentui/core";
import { theme } from "../theme.ts";

/** Die faces in a tumbling order, so it reads like a roll rather than a count. */
const DICE_FRAMES = ["⚀", "⚄", "⚁", "⚅", "⚃", "⚂"] as const;

/** Fire gradient, tip to base (coolest to hottest). */
const DICE_COLORS = [theme.flameEmber, theme.accent, theme.flameCore] as const;

export interface DiceSpinnerOptions {
  /** ms per face. Defaults to 140 — a deliberate tumble. */
  frameMs?: number;
  /** Right margin, e.g. to space the die off following text. */
  marginRight?: number;
}

export class DiceSpinnerRenderable extends SpinnerRenderable {
  constructor(renderer: CliRenderer, options: DiceSpinnerOptions = {}) {
    super(renderer, {
      frames: [...DICE_FRAMES],
      interval: options.frameMs ?? 140,
      autoplay: false,
      visible: false,
      color: createPulse([...DICE_COLORS], 0.5),
    });
    if (options.marginRight !== undefined) this.marginRight = options.marginRight;
  }

  override start(): void {
    this.visible = true;
    super.start();
  }

  override stop(): void {
    super.stop();
    this.visible = false;
  }
}
