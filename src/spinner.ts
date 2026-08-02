/**
 * Braille spinner frames for "working / thinking" indicators. Two APIs:
 * `startSpinnerFrames` drives any callback, while `SpinnerRenderable` is a
 * self-contained renderable you can drop into any layout and start/stop.
 */
import { TextRenderable, type CliRenderer, type TextOptions } from "@opentui/core";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const DEFAULT_FRAME_MS = 80;

export function startSpinnerFrames(frameMs: number, onFrame: (frame: string) => void): () => void {
  let frame = 0;
  const timer = setInterval(() => {
    onFrame(FRAMES[frame % FRAMES.length] ?? "");
    frame += 1;
  }, frameMs);
  return () => clearInterval(timer);
}

export interface SpinnerRenderableOptions extends Omit<TextOptions, "content"> {
  /** ms per frame. Defaults to 80. */
  frameMs?: number;
}

/**
 * A spinner as a first-class renderable: add its `node` anywhere in a layout,
 * then `start()`/`stop()` it. The frame text only exists while running, so the
 * renderable collapses to empty when idle.
 */
export class SpinnerRenderable extends TextRenderable {
  private frameMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameIndex = 0;

  constructor(renderer: CliRenderer, options: SpinnerRenderableOptions = {}) {
    super(renderer, { content: "", ...options });
    this.frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
  }

  get spinning(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
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
  }

  override destroy(): void {
    this.stop();
    super.destroy();
  }
}
