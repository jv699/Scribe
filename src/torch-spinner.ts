/**
 * Torch spinner: a fire/torch "thinking" indicator rendered by painting a
 * flame directly into a framebuffer (per-pixel fire gradient + ember glow).
 * `TorchSpinnerRenderable` is a drop-in for the plain spinner — `start()`
 * shows it, `stop()` hides it so it never leaves a gap in the layout.
 *
 * Each terminal cell renders two vertical pixels via half-blocks (▀/▄), giving
 * a 6×8 pixel canvas. The flame is a teardrop profile that breathes in height
 * and sways, with a solid flat base and a dim ember halo for a "burning" look.
 */
import { FrameBufferRenderable, type CliRenderer, type OptimizedBuffer } from "@opentui/core";
import { theme } from "./theme.ts";

const CELL_WIDTH = 6;
const CELL_HEIGHT = 4;
const PIXEL_HEIGHT = CELL_HEIGHT * 2;
const BASE_ROW = PIXEL_HEIGHT - 1;

type Rgb = readonly [number, number, number];

function hexToRgb(hex: string): Rgb {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b] as const;
}

function shade(rgb: Rgb, factor: number): Rgb {
  return [
    Math.round(rgb[0] * factor),
    Math.round(rgb[1] * factor),
    Math.round(rgb[2] * factor),
  ] as const;
}

/** Fire color ramp derived from the theme: deep ember → burnt orange → amber core. */
const FIRE_STOPS: { at: number; rgb: Rgb }[] = [
  { at: 0.2, rgb: shade(hexToRgb(theme.flameEmber), 0.55) },
  { at: 0.38, rgb: hexToRgb(theme.flameEmber) },
  { at: 0.58, rgb: hexToRgb(theme.accent) },
  { at: 0.78, rgb: hexToRgb(theme.accentHover) },
  { at: 1.0, rgb: hexToRgb(theme.flameCore) },
];

/** Dim ember halo painted around the flame silhouette. */
const GLOW: Rgb = shade(hexToRgb(theme.flameEmber), 0.4);

/** Flame silhouette: half-width per row from tip to base (7 rows). */
const PROFILE = [0.3, 0.7, 1.2, 1.6, 1.9, 2.0, 1.9] as const;

function ramp(heat: number): Rgb {
  for (let i = 1; i < FIRE_STOPS.length; i++) {
    const to = FIRE_STOPS[i]!;
    const from = FIRE_STOPS[i - 1]!;
    if (heat <= to.at) {
      const f = (heat - from.at) / (to.at - from.at);
      return [
        Math.round(from.rgb[0] + (to.rgb[0] - from.rgb[0]) * f),
        Math.round(from.rgb[1] + (to.rgb[1] - from.rgb[1]) * f),
        Math.round(from.rgb[2] + (to.rgb[2] - from.rgb[2]) * f),
      ] as const;
    }
  }
  return FIRE_STOPS[FIRE_STOPS.length - 1]!.rgb;
}

function profileAt(u: number): number {
  const p = u * (PROFILE.length - 1);
  const i = Math.min(Math.floor(p), PROFILE.length - 2);
  const f = p - i;
  return PROFILE[i]! + (PROFILE[i + 1]! - PROFILE[i]!) * f;
}

export interface TorchSpinnerOptions {
  /** ms per animation tick. Defaults to 70. */
  frameMs?: number;
  /** Right margin, e.g. to space the flame off following text. */
  marginRight?: number;
}

function paintFrame(b: OptimizedBuffer["buffers"], t: number): void {
  const rawH = 5.0 + 1.5 * (0.5 + 0.5 * Math.sin(t * 3.4));
  const tipRow = 2 * Math.round((BASE_ROW - (rawH - 1)) / 2); // even row → pointy ▀ tip
  const h = BASE_ROW - tipRow + 1;
  const centerX = (CELL_WIDTH - 1) / 2 + 0.3 * Math.sin(t * 2.6);

  const pixel = (x: number, py: number): Rgb | null => {
    const rowIn = py - tipRow;
    if (rowIn < 0) return null;
    const u = Math.min(rowIn / (h - 1), 1);
    const halfWidth = profileAt(u) + 0.1 * Math.sin(t * 5.0 + x * 2.2) * (0.3 + u);
    const dx = Math.abs(x - centerX) / Math.max(halfWidth, 0.01);
    if (dx >= 1.5) return null;
    if (dx >= 1) return GLOW;
    const heat = (0.34 + 0.66 * Math.pow(u, 1.15)) * Math.pow(1 - Math.pow(dx, 2.0), 1.2);
    return heat >= 0.2 ? ramp(heat) : GLOW;
  };

  for (let cy = 0; cy < CELL_HEIGHT; cy++) {
    for (let x = 0; x < CELL_WIDTH; x++) {
      const index = cy * CELL_WIDTH + x;
      const offset = index * 4;
      const pyTop = cy * 2;
      const pyBottom = cy * 2 + 1;
      // Solid flat base: the bottom pixel row is always lit across the base width.
      const top = pixel(x, pyTop);
      const bottom =
        cy === CELL_HEIGHT - 1 && Math.abs(x - centerX) <= profileAt(1) ? ramp(0.85) : pixel(x, pyBottom);

      if (!top && !bottom) {
        b.char[index] = 32;
        b.fg[offset + 3] = 0;
        b.bg[offset + 3] = 0;
        continue;
      }
      b.fg[offset] = top ? top[0] : 0;
      b.fg[offset + 1] = top ? top[1] : 0;
      b.fg[offset + 2] = top ? top[2] : 0;
      b.fg[offset + 3] = top ? 255 : 0;
      b.bg[offset] = bottom ? bottom[0] : 0;
      b.bg[offset + 1] = bottom ? bottom[1] : 0;
      b.bg[offset + 2] = bottom ? bottom[2] : 0;
      b.bg[offset + 3] = bottom ? 255 : 0;
      b.char[index] = top ? 0x2580 : 0x2584; // ▀ if top lit, ▄ if only bottom
    }
  }
}

/**
 * A torch flame as a first-class renderable: add it anywhere in a layout, then
 * `start()`/`stop()` it. Starting makes it visible and animates the flame into
 * the framebuffer; stopping clears it and hides it so the layout collapses.
 */
export class TorchSpinnerRenderable extends FrameBufferRenderable {
  private frameMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private elapsed = 0;

  constructor(renderer: CliRenderer, options: TorchSpinnerOptions = {}) {
    super(renderer, { width: CELL_WIDTH, height: CELL_HEIGHT, respectAlpha: true, visible: false });
    this.frameMs = options.frameMs ?? 70;
    if (options.marginRight !== undefined) this.marginRight = options.marginRight;
  }

  get spinning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.visible = true;
    this.timer = setInterval(() => {
      this.elapsed += this.frameMs / 1000;
      paintFrame(this.frameBuffer.buffers, this.elapsed);
      this.requestRender();
    }, this.frameMs);
    paintFrame(this.frameBuffer.buffers, this.elapsed);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.visible = false;
    const b = this.frameBuffer.buffers;
    for (let i = 0; i < CELL_WIDTH * CELL_HEIGHT; i++) {
      const o = i * 4;
      b.char[i] = 32;
      b.fg[o + 3] = 0;
      b.bg[o + 3] = 0;
    }
  }

  override destroy(): void {
    this.stop();
    super.destroy();
  }
}
