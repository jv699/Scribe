/**
 * Startup animations: `dissolveIn` (per-character shade-ramp dissolve) and
 * `chunkyFadeIn` (stepped opacity fade). Both are 90's-style, driven by
 * setInterval. They need real renderable instances, not VNode factory proxies.
 */
import type { Renderable, TextRenderable } from "@opentui/core";

/** Classic shade ramp for the dissolve effect (DOS "materialize" look). */
const DISSOLVE_RAMP = ["░", "▒", "▓"] as const;

/** Discrete opacity levels for the chunky fade (SNES brightness-step look). */
const FADE_STEPS = [0.2, 0.4, 0.65, 0.85, 1] as const;

export interface DissolveOptions {
  /** ms per animation frame. Higher = chunkier. */
  frameMs?: number;
  /** Max random start delay (in frames) before a character begins appearing. */
  spreadFrames?: number;
  onDone?: () => void;
}

/**
 * 90's DOS-style dissolve-in: each character pops in at a random frame and
 * cycles through the shade ramp (░ → ▒ → ▓) before settling on its final glyph.
 */
export function dissolveIn(target: TextRenderable, finalText: string, options: DissolveOptions = {}): () => void {
  const frameMs = options.frameMs ?? 55;
  const spreadFrames = options.spreadFrames ?? 12;
  const rampLength = DISSOLVE_RAMP.length;

  const chars = [...finalText];
  const delays = chars.map((ch) => (ch.trim() === "" ? -1 : Math.floor(Math.random() * spreadFrames)));

  const renderFrame = (frame: number): string => {
    let out = "";
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const delay = delays[i]!;
      if (delay < 0) {
        out += ch; // whitespace (incl. newlines) stays put, keeping layout stable
        continue;
      }
      const local = frame - delay;
      if (local <= 0) {
        out += " ";
      } else if (local <= rampLength) {
        out += DISSOLVE_RAMP[local - 1] ?? ch;
      } else {
        out += ch;
      }
    }
    return out;
  };

  // Blank frame immediately so the final text never flashes before frame 1.
  target.content = renderFrame(0);

  let frame = 0;
  const totalFrames = spreadFrames + rampLength + 1;
  let stopped = false;

  const timer = setInterval(() => {
    if (target.isDestroyed) {
      stop();
      return;
    }
    frame += 1;
    if (frame >= totalFrames) {
      stop();
      target.content = finalText;
      options.onDone?.();
      return;
    }
    target.content = renderFrame(frame);
  }, frameMs);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }

  return stop;
}

export interface ChunkyFadeOptions {
  /** ms between opacity steps. Higher = chunkier. */
  stepMs?: number;
  /** Delay in ms before the fade starts. */
  delayMs?: number;
  onDone?: () => void;
}

/**
 * SNES-style stepped fade: opacity jumps through a few discrete levels
 * instead of interpolating smoothly.
 */
export function chunkyFadeIn(target: Renderable, options: ChunkyFadeOptions = {}): () => void {
  const stepMs = options.stepMs ?? 90;
  const delayMs = options.delayMs ?? 0;

  target.opacity = 0;
  let interval: ReturnType<typeof setInterval> | undefined;
  let delay: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const start = () => {
    if (stopped || target.isDestroyed) return;
    let step = 0;
    interval = setInterval(() => {
      if (target.isDestroyed) {
        stop();
        return;
      }
      target.opacity = FADE_STEPS[step] ?? 1;
      step += 1;
      if (step >= FADE_STEPS.length) {
        stop();
        target.opacity = 1;
        options.onDone?.();
      }
    }, stepMs);
  };

  if (delayMs > 0) {
    delay = setTimeout(start, delayMs);
  } else {
    start();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (delay) clearTimeout(delay);
    if (interval) clearInterval(interval);
  }

  return stop;
}
