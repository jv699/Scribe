import type { Renderable } from "@opentui/core";

/**
 * A screen is a renderable subtree plus lifecycle hooks. `index.ts` swaps the
 * current screen under the renderer root (dispose → remove → destroy → add).
 */
export interface Screen {
  node: Renderable;
  /** Focus the screen's primary control. */
  focus?: () => void;
  /** Detach listeners / remove dialog layers before the node is destroyed. */
  dispose?: () => void;
}
