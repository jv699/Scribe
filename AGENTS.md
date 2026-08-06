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
- Current roadmap phase: **roadmap complete (all phases done)** — see
  `PLAN.md` for deferred/future ideas.

## Project basics

- **Runtime**: Bun (`bun` v1.3+).
- **Entry point**: `src/index.ts`.
- **Only dependencies**: `@opentui/core` (TUI component library) and `opentui-spinner` (spinner animations).
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
- `src/screens/campaign-home.ts`: campaign view — background & story-so-far peeks, session list with statuses, new-session dialog, session detail dialog ("Plan with Agent" for planning sessions, "Report outcome" for ready sessions, mark ready/played, trash), Escape goes back.
- `src/screens/settings.ts`: settings screen — edit base URL, model, API key env var, campaigns dir; persists to config.json via `saveSettings`.
- `src/screens/chat.ts`: chat screen (harness) — markdown transcript + prompt (via `makePrompt` from `components/prompt.ts`). Streams assistant replies from any `ChatProvider`; surfaces provider errors. When `tools` is **non-empty** (planning/report) sends run through `runAgent`; when omitted or empty, plain streaming with `systemPrompt` prepended to a local copy. With a `chatLog` store it **resumes** the conversation.
- `src/components/`: reusable UI widgets (opencode-style).
  - `ui.ts`: shared primitives — focusable/mouse-aware buttons (`makeButton`, click + Enter) and Tab/Shift+Tab focus traversal (`tabWalk`).
  - `dialog.ts`: generic centered modal primitive (`makeDialog`) — absolute full-screen layer + `zIndex`, toggled via `visible`. Callers handle focus.
  - `action-dialog.ts`: generic modal with a body + button row (`makeActionDialog`) — owns layer lifecycle, Tab/Shift+Tab traversal, Escape-to-close, initial focus; `onClose` returns focus.
  - `campaign-dialog.ts`: "New Campaign" form (`makeCampaignDialog`) built on `dialog.ts`. Name + system `InputRenderable`s + background `TextareaRenderable` + `makeButton` buttons. Global `keypress` listener (while open) traps Tab/Shift+Tab/Escape; `onSubmit`/`onCancel` callbacks.
  - `session-dialog.ts`: "New Session" form (`makeSessionDialog`), same pattern, single title field.
  - `prompt.ts`: `makePrompt` — opencode-style prompt widget (accent-bordered panel with a multi-line `TextareaRenderable`: Enter sends, Shift+Enter newline, hint footer). Callers own submission and textarea state.
  - `dice-spinner.ts`: `DiceSpinnerRenderable` — rolling-die "thinking" indicator built on `opentui-spinner` (tumbling die faces in a pulsing fire gradient).
- `src/agent/`: the harness core (Phase 2).
  - `loop.ts`: `runAgent` — tool-call loop (stream → execute tools → feed back → repeat until a text answer), `AgentTool`.
  - `agents.ts`: **the gateway** — `AGENTS` maps each agent (`planning` / `report` / `oneshot`) to the tool names it may call, and `toolsFor(agent, ctx)` resolves them. This is the one place to read when auditing what an agent can do. Tool names are checked against the registry at compile time, so a typo is a `tsc` error.
  - `tools/`: one file per tool, each exporting a `ToolSpec` (`name` + `definition` + `create(ctx)`).
    - `types.ts`: `ToolContext` (optional `campaign` / `session`) and `ToolSpec`. `create` returns `null` when a tool can't run in the given context — that's how campaign tools drop out of a campaign-less agent.
    - `index.ts`: the `registry` object literal, `ToolName` (derived from its keys), and `resolveTools(names, ctx)`. Explicit literal, **not** filesystem discovery — that's what makes `ToolName` a compile-time union.
    - `shared.ts`: arg coercion (`stringArg` / `numberArg`) and `findSession` / `freshCampaign`, which re-read from disk so the agent observes its own writes mid-run.
    - Tools: `list-sessions.ts`, `read-campaign-summary.ts`, `read-session-notes.ts`, `update-session-notes.ts`, `append-campaign-summary.ts`.
  - `context.ts`: `buildPlanningSystemPrompt` / `buildReportSystemPrompt` / `buildOneshotSystemPrompt` — base system prompt file + campaign background/story + session draft (or report framing). Prompts are deliberately **not** owned by the gateway.

  Adding a tool: new file in `tools/` + one line in `tools/index.ts`. Granting it: one string in `agents.ts`. Adding an agent: one entry in `AGENTS` + a prompt builder in `context.ts`.

  **Tool security invariant**: tools never accept filesystem paths from the model. Resources are addressed by identity (session *number*, the active campaign) and resolved through `src/store/`, which is what confines reads and writes to the campaign folder. A future tool needing a path must resolve it internally, not take it as an argument.
- `src/provider/`: model provider abstraction (Phase 1).
  - `types.ts`: `ChatMessage`, `ToolCall`/`ToolDefinition`, `ChatEvent` (`text` | `tool_call`), `ChatProvider.streamChat(messages, options?)`.
  - `openai.ts`: OpenAI-compatible client (SSE streaming + JSON fallback) and `createProviderFromSettings`. `DEFAULT_BASE_URL`/`DEFAULT_MODEL`.
- `src/theme.ts`: unified palette (`theme`) — burnt-orange accent over flat dark surfaces. ALL UI colors come from here; never hardcode hex literals.
- `src/consts.ts`: ASCII art logos.
- `src/intro.ts`: startup animation helpers — `dissolveIn` (per-character shade-ramp dissolve for text) and `chunkyFadeIn` (stepped opacity fade). Driven by `setInterval`, need real renderable instances (not the `Box()`/`Text()` VNode factory proxies).
- `src/store/`: markdown-first persistence (Phase 0). Campaign data lives in `<campaignsDir>/<Campaign Name>/campaign.md` + `sessions/00N-slug.md`; settings in `~/.config/scribe/config.json` (`campaignsDir`, default `~/Scribe`).
  - `frontmatter.ts`: flat `key: value` frontmatter parse/serialize (no YAML).
  - `naming.ts`: folder-name sanitize, session-file slugify, collision-proof `uniqueName`. Regex classes use `\xNN` escapes — do not paste raw control chars into source.
  - `settings.ts`: `loadSettings()`/`saveSettings()` — creates config + campaigns dir on first run, expands `~`.
  - `system-prompt.ts`: user-owned base system prompt file (`~/.config/scribe/system-prompt.md`), created with a default if missing.
  - `campaigns.ts`: `Campaign` type, `createCampaign`/`listCampaigns`/`loadCampaign`/`updateCampaignMeta`/`appendStorySoFar`. `campaign.md` body holds Background + The Story So Far sections.
  - `sessions.ts`: `Session` type, `createSession` (bumps campaign `nextSession`), `listSessions`, `setSessionStatus` (stamps dates), `trashSession` (soft-delete to `.scribe/trash/`).
  - `chat-log.ts`: conversation persistence per session+mode as JSONL in `.scribe/` (`loadChatLog`/`saveChatLog`/`clearChatLog`) — resumes planning/report chats across app sessions.

## Gotchas

- The app is an interactive TUI. Running it in a non-TTY or automated context may fail or hang.
- `bun run` without a script name is not configured; use `bun run src/index.ts` or `bun src/index.ts`.
- Key names: the main Enter key reports `key.name === "return"` (`"enter"` is the keypad-enter alias). Escape is `"escape"`, Tab is `"tab"` (check `key.shift` for Shift+Tab).
- Headless testing: use `createTestRenderer` + `createMockKeys` from `@opentui/core/testing`. The test script MUST live inside the project — if run from outside, Bun resolves a second copy of `@opentui/core` from its global cache and rendering silently breaks (boxes draw, text never paints).
- `MarkdownRenderable` must always be created with `streaming: true`, and never toggled back off. It only builds a synchronous first paint (`initialStyledText`) while streaming is on; with it off, every block waits on an async tree-sitter highlight and paints blank for a frame. Turning it off also rebuilds every block, so a `true -> false` flip blanks the whole transcript for a frame. Settled output is identical either way. Covered by the "markdown never blanks out" tests in `tests/chat.test.ts`.
