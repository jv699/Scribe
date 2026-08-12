import {
  StyledText,
  TextRenderable,
  parseColor,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core";

export interface ShimmerTextOptions {
  text: string;
  baseColor: string;
  edgeColor: string;
  highlightColor: string;
  frameMs?: number;
}

export interface ShimmerText {
  node: TextRenderable;
  /** Stop shimmering and optionally replace the text. Idempotent. */
  stop(finalText?: string): void;
}

/**
 * A fixed-width text label with a three-character color highlight sweeping
 * across it. Only styling changes between frames, so surrounding layout never
 * moves.
 */
export function makeShimmerText(
  renderer: CliRenderer,
  options: ShimmerTextOptions,
): ShimmerText {
  const chars = [...options.text];
  const colors = {
    base: parseColor(options.baseColor),
    edge: parseColor(options.edgeColor),
    highlight: parseColor(options.highlightColor),
  };
  const node = new TextRenderable(renderer, { content: options.text, fg: options.baseColor });
  const travel = chars.length + 7;
  let frame = 0;
  let stopped = false;

  function render(): void {
    const center = (frame % travel) - 3;
    const chunks: TextChunk[] = chars.map((char, index) => ({
      __isChunk: true,
      text: char,
      fg:
        index === center
          ? colors.highlight
          : Math.abs(index - center) === 1
            ? colors.edge
            : colors.base,
    }));
    node.content = new StyledText(chunks);
    frame += 1;
  }

  render();
  const timer = setInterval(() => {
    if (node.isDestroyed) {
      stop();
      return;
    }
    render();
  }, options.frameMs ?? 90);

  function stop(finalText: string = options.text): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (!node.isDestroyed) node.content = finalText;
  }

  return { node, stop };
}
