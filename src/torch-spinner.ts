/**
 * Torch spinner: a fire/torch "thinking" indicator built on `opentui-spinner`.
 * A braille flame that flickers (tall, medium, leaning, short) while a pulsing
 * fire gradient plays over it. `TorchSpinnerRenderable` is a drop-in for the
 * plain `SpinnerRenderable` — `start()` shows it, `stop()` hides it so it
 * never leaves a gap in the layout.
 */
import { createPulse, SpinnerRenderable } from "opentui-spinner";
import type { CliRenderer } from "@opentui/core";
import { theme } from "./theme.ts";

/**
 * Flicker cycle drawn on a 3-cell braille canvas (6×4 dots): a teardrop flame
 * that burns tall, leans, dips, and leans back — like a torch catching air.
 * The left/right cells sit low so the flame rests on a flat bottom.
 */
const TORCH_FRAMES = ["⢠⣿⡄", "⢀⣾⡄", "⢀⣶⡀", "⢠⣷⡀"] as const;

/** Fire gradient, tip to base (coolest to hottest). */
const TORCH_COLORS = [theme.flameEmber, theme.accent, theme.flameCore] as const;

export interface TorchSpinnerOptions {
  /** ms per frame. Defaults to 110 — a slow flicker reads more like fire. */
  frameMs?: number;
  /** Right margin, e.g. to space the flame off following text. */
  marginRight?: number;
}

export class TorchSpinnerRenderable extends SpinnerRenderable {
  constructor(renderer: CliRenderer, options: TorchSpinnerOptions = {}) {
    super(renderer, {
      frames: [...TORCH_FRAMES],
      interval: options.frameMs ?? 110,
      autoplay: false,
      visible: false,
      color: createPulse([...TORCH_COLORS], 0.5),
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
