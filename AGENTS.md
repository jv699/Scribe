# Agent Notes for Scribe

A small Bun + TypeScript terminal UI project. Keep it simple.

## What Scribe is

Scribe is (becoming) a bring-your-own-model TTRPG campaign builder and
organizer: users create campaigns for any system, plan sessions with an LLM
agent in a chat-like harness, run sessions from generated markdown notes, then
report outcomes so the agent maintains a running campaign summary it uses to
plan future sessions. **Read `PLAN.md` before making architectural decisions**
— it contains the full design and roadmap.

Locked design decisions (don't revisit without asking):

- **Persistence is markdown-first**: campaign data lives in user-visible
  markdown files with frontmatter (default `~/Scribe`), not a database. The
  files the agent reads/writes are the same files the user owns.
- **Frontmatter is flat `key: value` lines**, parsed by a tiny hand-rolled
  parser — do not add a YAML dependency.
- **Model access is OpenAI-compatible only** (configurable `baseUrl`/`model`,
  covers OpenAI/OpenRouter/Ollama/LM Studio). API keys are referenced by env
  var name in `~/.config/scribe/config.json` — never store keys.
- Current roadmap phase: **Phase 1 (provider client)** — Phase 0
  (persistence) is done; see `PLAN.md`.

## Project basics

- **Runtime**: Bun (`bun` v1.3+).
- **Entry point**: `src/index.ts`.
- **Only dependency**: `@opentui/core` (TUI component library).
- **Tests**: `bun:test` in `tests/`. No lint, formatter, or CI yet.

## Common commands

```bash
# Install dependencies
bun install

# Run the app (interactive terminal UI)
bun run src/index.ts

# Watch mode during dev
bun --watch src/index.ts

# Type check (no emit; tsconfig sets "noEmit": true)
bunx tsc --noEmit

# Run tests (store unit tests + headless UI flow test)
bun test
```

## TypeScript / Bun specifics

- `tsconfig.json` targets Bun: `"types": ["bun"]`, `"module": "Preserve"`, `"moduleResolution": "bundler"`, `"noEmit": true`.
- Strict mode is on, including `noUncheckedIndexedAccess` and `noImplicitOverride`.
- Imports use `.ts` extensions (e.g., `./ui.ts`, `./consts.ts`); this is required by `allowImportingTsExtensions`.

## Entrypoints and architecture

- `src/index.ts`: entry point + screen manager. One `Screen` at a time under the renderer root (dispose → remove → destroy → add). Also owns the campaign-create dialog and app-level wiring.
- `src/screens/screen.ts`: `Screen` interface (`node` + optional `focus()`/`dispose()`).
- `src/screens/main-menu.ts`: main menu — create / campaign list (loaded from disk) / quit, plus the intro animation on first show.
- `src/screens/campaign-home.ts`: campaign view — background & story-so-far peeks, session list with statuses, new-session dialog, session detail dialog (mark ready/played, trash), Escape goes back.
- `src/ui.ts`: helper for creating focusable/mouse-aware buttons (`makeButton`).
- `src/theme.ts`: unified palette (`theme`) — burnt-orange accent over flat dark surfaces. ALL UI colors come from here; never hardcode hex literals.
- `src/consts.ts`: ASCII art logos.
- `src/intro.ts`: startup animation helpers — `dissolveIn` (per-character shade-ramp dissolve for text) and `chunkyFadeIn` (stepped opacity fade). Driven by `setInterval`, need real renderable instances (not the `Box()`/`Text()` VNode factory proxies).
- `src/dialog.ts`: generic centered modal primitive (`makeDialog`) — absolute full-screen layer + `zIndex`, toggled via `visible`. Callers handle focus.
- `src/campaign-dialog.ts`: "New Campaign" form (`makeCampaignDialog`) built on `dialog.ts`. Name + system `InputRenderable`s + background `TextareaRenderable` + `makeButton` buttons. Global `keypress` listener (while open) traps Tab/Shift+Tab/Escape; `onSubmit`/`onCancel` callbacks.
- `src/session-dialog.ts`: "New Session" form (`makeSessionDialog`), same pattern, single title field.
- `src/store/`: markdown-first persistence (Phase 0). Campaign data lives in `<campaignsDir>/<Campaign Name>/campaign.md` + `sessions/00N-slug.md`; settings in `~/.config/scribe/config.json` (`campaignsDir`, default `~/Scribe`).
  - `frontmatter.ts`: flat `key: value` frontmatter parse/serialize (no YAML).
  - `naming.ts`: folder-name sanitize, session-file slugify, collision-proof `uniqueName`. Regex classes use `\xNN` escapes — do not paste raw control chars into source.
  - `settings.ts`: `loadSettings()` — creates config + campaigns dir on first run, expands `~`.
  - `campaigns.ts`: `Campaign` type, `createCampaign`/`listCampaigns`/`loadCampaign`/`updateCampaignMeta`. `campaign.md` body holds Background + The Story So Far sections.
  - `sessions.ts`: `Session` type, `createSession` (bumps campaign `nextSession`), `listSessions`, `setSessionStatus` (stamps dates), `trashSession` (soft-delete to `.scribe/trash/`).

## Gotchas

- The app is an interactive TUI. Running it in a non-TTY or automated context may fail or hang.
- `bun run` without a script name is not configured; use `bun run src/index.ts` or `bun src/index.ts`.
- Key names: the main Enter key reports `key.name === "return"` (`"enter"` is the keypad-enter alias). Escape is `"escape"`, Tab is `"tab"` (check `key.shift` for Shift+Tab).
- Headless testing: use `createTestRenderer` + `createMockKeys` from `@opentui/core/testing`. The test script MUST live inside the project — if run from outside, Bun resolves a second copy of `@opentui/core` from its global cache and rendering silently breaks (boxes draw, text never paints).
