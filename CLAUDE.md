# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read `AGENTS.md` in full before making architectural decisions** — it is the authoritative, actively-maintained map of this codebase (per-module notes, invariants, and gotchas). Read `PLAN.md` for the product design and roadmap. This file is a condensed entry point; when it and `AGENTS.md` disagree, trust `AGENTS.md`.

## What Scribe is

A bring-your-own-model TTRPG campaign builder and organizer: an interactive terminal UI (Bun + TypeScript + OpenTUI) where users create campaigns, plan sessions with an LLM agent in a chat harness, export session notes as markdown to run at the table, then report outcomes so the agent maintains a running campaign summary it uses to plan future sessions. Roadmap phases 0–6 are complete; see `PLAN.md` for deferred/future ideas.

## Locked design decisions (don't revisit without asking)

- **Persistence is markdown-first**: campaign data lives in user-visible markdown files with frontmatter (default `~/Scribe`), not a database. The files the agent reads/writes are the same files the user owns.
- **Frontmatter is flat `key: value` lines**, parsed by a tiny hand-rolled parser (`src/store/frontmatter.ts`) — do not add a YAML dependency.
- **Model access is OpenAI-compatible only** (configurable `baseUrl`/`model`, covers OpenAI/OpenRouter/Ollama/LM Studio). API keys are referenced by env var name in `~/.config/scribe/config.json` — never store keys.
- **Tools never accept filesystem paths from the model.** Resources are addressed by identity (session number, active campaign) and resolved through `src/store/`, which confines reads/writes to the campaign folder.

## Commands

```bash
# Install dependencies
bun install

# Run the app (interactive terminal UI)
bun run src/index.ts

# Watch mode during dev
bun --watch src/index.ts

# Type check (no emit; tsconfig sets "noEmit": true)
bunx tsc --noEmit

# Run all tests (store unit tests + headless UI flow tests)
bun test

# Run a single test file
bun test tests/chat.test.ts
```

There is no lint, formatter, or CI configured.

## TypeScript / Bun specifics

- `tsconfig.json` targets Bun: `"types": ["bun"]`, `"module": "Preserve"`, `"moduleResolution": "bundler"`, `"noEmit": true`.
- Strict mode is on, including `noUncheckedIndexedAccess` and `noImplicitOverride`.
- Imports use `.ts` extensions (e.g. `./ui.ts`, `./consts.ts`) — required by `allowImportingTsExtensions`.
- Only runtime dependencies: `@opentui/core` (TUI component library) and `opentui-spinner` (spinner animations).

## Architecture overview

- **`src/index.ts`** — entry point + screen manager. One `Screen` at a time under the renderer root (dispose → remove → destroy → add).
- **`src/screens/`** — `main-menu.ts`, `campaign-home.ts`, `chat.ts` (the shared planning/report harness screen), `settings.ts`.
- **`src/components/`** — reusable OpenTUI widgets: generic dialogs (`dialog.ts`, `action-dialog.ts`), form dialogs (`campaign-dialog.ts`, `session-dialog.ts`), the chat `prompt.ts`, the `ask_user` question widget (`ask-widget.ts`), the `/`-command and `@`-mention completion popup (`autocomplete.ts`).
- **`src/agent/`** — the harness core:
  - `loop.ts` — `runAgent`, the tool-call loop (stream → execute tools → feed back → repeat).
  - `ask.ts` — the `ask_user` channel seam between the agent loop and the chat screen.
  - `agents.ts` — **the gateway**: maps each agent (`planning` / `report` / `oneshot`) to the tool names it may call. This is the one place to read when auditing what an agent can do.
  - `tools/` — one file per tool (`ToolSpec`), explicit registry in `tools/index.ts` (not filesystem discovery, so `ToolName` is a compile-time union). Adding a tool: new file + one line in `index.ts` + grant it in `agents.ts`.
  - `prompts.ts` — the code-owned core prompts (never written to disk, so they always ship current).
  - `context.ts` — system prompt builders per mode: core → campaign/session context → the user's optional instructions file.
- **`src/provider/`** — model provider abstraction: `types.ts` (`ChatMessage`, `ToolCall`, `ChatEvent`, `ChatProvider`), `openai.ts` (OpenAI-compatible SSE client).
- **`src/store/`** — markdown-first persistence: `campaigns.ts`, `sessions.ts`, `frontmatter.ts`, `naming.ts`, `settings.ts`, `instructions.ts` (the user's optional, never-created instruction files), `chat-log.ts` (JSONL conversation resume), `oneshots.ts`.
- **`src/theme.ts`** — unified palette; all UI colors must come from here, never hardcode hex literals.

On-disk layout, the full per-file architecture notes (including UI event-handling patterns, `ask_user` semantics, and dialog composition), and known gotchas (headless testing setup, key-name quirks, `visible`/absolute-positioning tricks, `MarkdownRenderable` streaming requirements) are documented in detail in `AGENTS.md` — read it before touching `src/agent/`, `src/components/`, or `src/screens/chat.ts`.
