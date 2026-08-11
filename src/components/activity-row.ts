import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { formatDuration } from "../format.ts";
import { theme } from "../theme.ts";

/** A compact DOS-style pulse for a live activity. */
const FRAMES = ["░", "▒", "▓", "▒"] as const;
const FRAME_MS = 160;

export interface ActivityRow {
  node: BoxRenderable;
  /** Settle the activity into its past-tense label and elapsed time. Idempotent. */
  finish(): void;
  /** Stop the animation without changing the row, ready for its owner to destroy it. */
  dispose(): void;
}

/**
 * A single animated activity row. While live it shows an accent-colored shade
 * pulse beside muted present-tense text; once finished it becomes a static,
 * past-tense duration line.
 */
export function makeActivityRow(
  renderer: CliRenderer,
  present: string,
  past: string,
): ActivityRow {
  const node = new BoxRenderable(renderer, {
    width: "100%",
    flexDirection: "row",
    flexShrink: 0,
  });
  const pulse = new TextRenderable(renderer, {
    content: FRAMES[0],
    fg: theme.accent,
    marginRight: 1,
  });
  const label = new TextRenderable(renderer, {
    content: `${present}…`,
    fg: theme.textMuted,
  });
  node.add(pulse);
  node.add(label);

  const startedAt = Date.now();
  let frame = 0;
  let settled = false;
  let disposed = false;
  const timer = setInterval(() => {
    if (pulse.isDestroyed) {
      dispose();
      return;
    }
    frame = (frame + 1) % FRAMES.length;
    pulse.content = FRAMES[frame]!;
  }, FRAME_MS);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
  }

  function finish(): void {
    if (settled) return;
    settled = true;
    dispose();
    if (label.isDestroyed) return;
    node.remove(pulse);
    pulse.destroyRecursively();
    label.content = `${past} · ${formatDuration(Date.now() - startedAt)}`;
  }

  return { node, finish, dispose };
}
