import type { Renderable } from "@opentui/core";

/** Screen swaps run dispose → remove → destroy → add. */
export interface Screen {
  node: Renderable;
  /** Focus the screen's primary control. */
  focus?: () => void;
  /** Handle Ctrl+C before the app falls back to its normal immediate quit. */
  handleInterrupt?: () => "handled" | "quit";
  /** Detach listeners / remove dialog layers before the node is destroyed. */
  dispose?: () => void;
}
