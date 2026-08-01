/**
 * Braille spinner frames for "working / thinking" indicators. Drive a
 * spinner with `startSpinnerFrames` and decide what each frame updates;
 * returns a stop function.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function startSpinnerFrames(frameMs: number, onFrame: (frame: string) => void): () => void {
  let frame = 0;
  const timer = setInterval(() => {
    onFrame(FRAMES[frame % FRAMES.length] ?? "");
    frame += 1;
  }, frameMs);
  return () => clearInterval(timer);
}
