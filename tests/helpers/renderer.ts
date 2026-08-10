/**
 * Shared headless-renderer scaffolding for the UI tests.
 *
 * Must live inside the project so `@opentui/core` resolves to a single module
 * instance (see the AGENTS.md gotchas) — the same reason the tests themselves
 * can't sit outside the repo.
 *
 * Destructure it in `beforeEach` so existing tests keep referring to bare
 * `renderer` / `keys` / `captureCharFrame` / `renderOnce`:
 *
 *   beforeEach(async () => {
 *     ({ renderer, keys, captureCharFrame, renderOnce } = await setupRenderer({ width: 80, height: 24 }));
 *   });
 */
import { createMockKeys, createTestRenderer, type TestRenderer } from "@opentui/core/testing";

export interface RendererHarness {
  renderer: TestRenderer;
  keys: ReturnType<typeof createMockKeys>;
  captureCharFrame: () => string;
  renderOnce: () => Promise<void>;
}

export interface SetupRendererOptions {
  width: number;
  height: number;
}

export async function setupRenderer(options: SetupRendererOptions): Promise<RendererHarness> {
  const setup = await createTestRenderer({ width: options.width, height: options.height });
  return {
    renderer: setup.renderer,
    keys: createMockKeys(setup.renderer),
    captureCharFrame: setup.captureCharFrame,
    renderOnce: setup.renderOnce,
  };
}

/** Let timers, streams, and animations advance before asserting on a frame. */
export const wait = (ms = 300): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));
