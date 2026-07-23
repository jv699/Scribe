# Agent Notes for Scribe

A small Bun + TypeScript terminal UI project. Keep it simple.

## Project basics

- **Runtime**: Bun (`bun` v1.3+).
- **Entry point**: `index.ts`.
- **Only dependency**: `@opentui/core` (TUI component library).
- **No tests, lint, formatter, or CI** are configured yet.

## Common commands

```bash
# Install dependencies
bun install

# Run the app (interactive terminal UI)
bun run index.ts

# Watch mode during dev
bun --watch index.ts

# Type check (no emit; tsconfig sets "noEmit": true)
bunx tsc --noEmit
```

## TypeScript / Bun specifics

- `tsconfig.json` targets Bun: `"types": ["bun"]`, `"module": "Preserve"`, `"moduleResolution": "bundler"`, `"noEmit": true`.
- Strict mode is on, including `noUncheckedIndexedAccess` and `noImplicitOverride`.
- Imports use `.ts` extensions (e.g., `./ui.ts`, `./consts.ts`); this is required by `allowImportingTsExtensions`.

## Entrypoints and architecture

- `index.ts`: wires up the OpenTUI renderer, builds the main menu, and starts the interactive loop.
- `ui.ts`: helper for creating focusable/mouse-aware buttons (`makeButton`).
- `consts.ts`: ASCII art logos.
- `intro.ts`: startup animation helpers — `dissolveIn` (per-character shade-ramp dissolve for text) and `chunkyFadeIn` (stepped opacity fade). Driven by `setInterval`, need real renderable instances (not the `Box()`/`Text()` VNode factory proxies).
- `dialog.ts`: generic centered modal primitive (`makeDialog`) — absolute full-screen layer + `zIndex`, toggled via `visible`. Callers handle focus.
- `campaign-dialog.ts`: "New Campaign" form (`makeCampaignDialog`) built on `dialog.ts`. Name `InputRenderable` + description `TextareaRenderable` + `makeButton` buttons. Global `keypress` listener (while open) traps Tab/Shift+Tab/Escape; `onSubmit`/`onCancel` callbacks.
- `campaigns.ts`: `Campaign` type + in-memory store (`addCampaign`/`listCampaigns`). No persistence by design — this module is the seam for adding it later.

## Gotchas

- The app is an interactive TUI. Running it in a non-TTY or automated context may fail or hang.
- `bun run` without a script name is not configured; use `bun run index.ts` or `bun index.ts`.
- Key names: the main Enter key reports `key.name === "return"` (`"enter"` is the keypad-enter alias). Escape is `"escape"`, Tab is `"tab"` (check `key.shift` for Shift+Tab).
- Headless testing: use `createTestRenderer` + `createMockKeys` from `@opentui/core/testing`. The test script MUST live inside the project — if run from outside, Bun resolves a second copy of `@opentui/core` from its global cache and rendering silently breaks (boxes draw, text never paints).
