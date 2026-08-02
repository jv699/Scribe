/**
 * Braille spinner frames for "working / thinking" indicators. Use
 * `SpinnerRenderable` for a self-contained, layout-placeable spinner: add it
 * to any row, then `start()`/`stop()` it. It hides itself while stopped so
 * it never leaves a gap in the layout.
 */
import { TextRenderable, type CliRenderer, type TextOptions } from "@opentui/core";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const DEFAULT_FRAME_MS = 80;

export interface SpinnerRenderableOptions extends Omit<TextOptions, "content"> {
  /** ms per frame. Defaults to 80. */
  frameMs?: number;
}

/**
 * A spinner as a first-class renderable: add it anywhere in a layout, then
 * `start()`/`stop()` it. Starting makes it visible and cycles braille frames;
 * stopping clears the frame and hides the renderable.
 */
export class SpinnerRenderable extends TextRenderable {
  private frameMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;

  constructor(renderer: CliRenderer, options: SpinnerRenderableOptions = {}) {
    super(renderer, { content: "", ...options });
    this.frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
    this.visible = options.visible ?? false;
  }

  get spinning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.visible = true;
    this.frameIndex = 0;
    this.timer = setInterval(() => {
      this.content = FRAMES[this.frameIndex % FRAMES.length] ?? "";
      this.frameIndex += 1;
    }, this.frameMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.content = "";
    this.visible = false;
  }

  override destroy(): void {
    this.stop();
    super.destroy();
  }
}
