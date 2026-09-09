// Animations require real renderable instances, not VNode factory proxies.
import type { Renderable, TextRenderable } from "@opentui/core";

const DISSOLVE_RAMP = ["░", "▒", "▓"] as const;

const FADE_STEPS = [0.2, 0.4, 0.65, 0.85, 1] as const;

export interface DissolveOptions {
  frameMs?: number;
  /** Max random start delay (in frames) before a character begins appearing. */
  spreadFrames?: number;
  onDone?: () => void;
}

/** Dissolve through shade glyphs at random offsets. Returns a cancellation function. */
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
  stepMs?: number;
  delayMs?: number;
  onDone?: () => void;
}

/** Fade through discrete opacity levels. Returns a cancellation function. */
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
