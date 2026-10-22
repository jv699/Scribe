/**
 * Shared headless-renderer scaffolding for the UI tests.
 *
 * Must live inside the project so `@opentui/core` resolves to a single module
 * instance (see the CLAUDE.md gotchas) — the same reason the tests themselves
 * can't sit outside the repo.
 *
 * Destructure it in `beforeEach` so existing tests keep referring to bare
 * `renderer` / `keys` / `captureCharFrame` / `renderOnce`:
 *
 *   beforeEach(async () => {
 *     ({ renderer, keys, captureCharFrame, renderOnce } = await setupRenderer({ width: 80, height: 24 }));
 *   });
 */
import type { RGBA } from "@opentui/core";
import { createMockKeys, createTestRenderer, type TestRenderer } from "@opentui/core/testing";

export interface RendererHarness {
  renderer: TestRenderer;
  keys: ReturnType<typeof createMockKeys>;
  captureCharFrame: () => string;
  /** Per-cell colors, for assertions a character frame can't make. */
  captureSpans: Awaited<ReturnType<typeof createTestRenderer>>["captureSpans"];
  renderOnce: () => Promise<void>;
  /**
   * The colors of the cell where `text` first starts on screen, searching
   * only the first `columns` columns of each row when given (e.g. a sidebar).
   */
  cellAt: (text: string, columns?: number) => { fg: RGBA; bg: RGBA };
}

export interface SetupRendererOptions {
  width: number;
  height: number;
}

export async function setupRenderer(options: SetupRendererOptions): Promise<RendererHarness> {
  const setup = await createTestRenderer({ width: options.width, height: options.height });
  const cellAt = (text: string, columns?: number): { fg: RGBA; bg: RGBA } => {
    const lines = setup.captureCharFrame().split("\n");
    const y = lines.findIndex((line) => line.slice(0, columns).includes(text));
    if (y < 0) throw new Error(`"${text}" is not on screen`);
    const x = lines[y]!.indexOf(text);
    let column = 0;
    for (const span of setup.captureSpans().lines[y]!.spans) {
      if (x < column + span.width) return { fg: span.fg, bg: span.bg };
      column += span.width;
    }
    throw new Error(`no span at ${x},${y}`);
  };
  return {
    cellAt,
    renderer: setup.renderer,
    keys: createMockKeys(setup.renderer),
    captureCharFrame: setup.captureCharFrame,
    captureSpans: setup.captureSpans,
    renderOnce: setup.renderOnce,
  };
}

/** Let timers, streams, and animations advance before asserting on a frame. */
export const wait = (ms = 300): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));
