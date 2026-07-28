# Scribe — Project Plan

A bring-your-own-model TTRPG campaign builder and organizer, running as an
interactive terminal UI (Bun + TypeScript + OpenTUI). The user creates
campaigns for any system (D&D, Shadowdark, …), plans sessions with an LLM
agent in a chat-like harness, exports session notes as markdown to run at the
table, then reports outcomes afterwards — the agent appends to a running
campaign summary that becomes its memory for planning the next session.

## Locked decisions

- **Persistence: markdown-first.** Campaign data lives in plain markdown files
  with frontmatter, in a user-visible folder (default `~/Scribe`, configurable).
  The files the agent reads/writes are the same files the user owns and can
  open in any editor. No database, no export/sync layer.
- **Provider: OpenAI-compatible only (v1).** One streaming chat client with
  configurable `baseUrl` + `model`. Covers OpenAI, OpenRouter, Ollama,
  LM Studio, vLLM. API keys are referenced by env var *name* in the config
  file, never stored. The provider interface is a one-method seam so other
  providers (e.g. Anthropic-native) can be added later.
- **Campaign files: user-visible folder.** Default `~/Scribe`, configurable in
  settings.

## The core loop

The whole product is one repeating cycle:

```
plan → export → play (offline, at the table) → report → summary grows → plan next
```

A **Session** has three statuses:

1. `planning` — user chats with the agent; agent drafts session notes.
2. `ready` — notes finalized; the markdown file is what the user runs the
   session from at the table.
3. `played` — user reports the outcome; the agent appends a summary to the
   campaign's running summary ("The Story So Far"), which is the agent's
   memory for planning future sessions.

## Domain model

- **System** — freeform string ("D&D 5e", "Shadowdark"). Not an enum; UI may
  offer suggestions. Later: system-specific prompt hints.
- **Campaign** — name, system, background, running summary, session counter.
- **Session** — number, title, status, planning notes (markdown), outcome
  report, derived summary.
- **Conversation** — planning/report chat transcripts, kept so planning can
  span multiple sittings.
- **Settings** — provider, model, API key env var name, campaigns directory.

## On-disk layout

```
~/Scribe/
  Curse of Strahd/
    campaign.md              # frontmatter: name, system, created, nextSession
                             # body: ## Background … ## The Story So Far
    sessions/
      001-death-house.md     # frontmatter: number, title, status, dates
                             # body: plan; outcome + summary appended later
      002-village-of-barovia.md
    .scribe/
      chat-001.jsonl         # conversation logs (resumable), hidden
```

Frontmatter is kept to flat `key: value` lines so a tiny hand-rolled parser
suffices — no YAML dependency.

App settings (not campaign data): `~/.config/scribe/config.json`.

## The harness

Deliberately small: **one chat screen, two system prompts, a handful of file
tools.**

- **Provider abstraction** — one interface:
  `chat(messages, tools) → async stream of chunks`.
- **Agent loop** — standard tool-call loop: model streams text/tool calls →
  app executes tools → results fed back → repeat until done.
- **Tools, scoped strictly to the active campaign folder** (path-traversal
  guard):
  - `read_campaign_summary()`
  - `read_session_notes(n)` / `update_session_notes(n, content)`
  - `append_campaign_summary(entry)` — report phase only
  - `list_sessions()`
- **Two modes, two prompts:**
  - *Planning*: "You are a TTRPG co-designer. System: X. Background + story so
    far: … Help plan session N; keep `sessions/00N.md` updated via tools."
  - *Report*: "The user played session N. Ask what happened, then append a
    concise summary via `append_campaign_summary`."
- **Context assembly** — system prompt + background + running summary +
  current draft + chat history. Known future issue: the running summary grows
  unboundedly; add a compression step later (not v1).

UI notes: OpenTUI 0.4.5 already ships `Markdown` and `ScrollBox` renderables —
the chat transcript renders streamed markdown directly.

## Screens

```
Main menu          → list campaigns, create, settings, quit        (exists)
Campaign home      → system, story-so-far peek, session list w/ statuses,
                     actions: "Plan next session" / "Report outcome" / open folder
Chat screen        → shared by planning & report modes (different prompt/tools)
Settings           → provider, model, key env var, campaigns dir
```

## Roadmap

Each phase leaves the app runnable.

| Phase | Deliverable | Needs API key? |
|---|---|---|
| **0. Persistence** | Markdown store replaces `campaigns.ts` memory store; campaigns survive restarts; campaign home + manual session CRUD; "System" field in create dialog; settings store | No |
| **1. Provider client** | Settings screen + OpenAI-compatible streaming chat in a scratch screen | Yes |
| **2. Planning mode** | Chat + tools → agent writes `sessions/00N.md` | Yes |
| **3. Report mode** | Outcome chat → summary appended; session → `played` | Yes |
| **4. Polish** | Resume conversations, status guards, error handling, tests | — |

Phase 0 is a useful campaign organizer with zero AI risk and is fully testable
headlessly (`createTestRenderer` + temp dirs). Phases 2–3 are thin once 0–1
exist.

## Deferred / future ideas

- Running-summary compression when it outgrows the context window.
- Anthropic-native provider client.
- Search/stats across campaigns (would be the trigger to reconsider SQLite).
- Extra agent tools: dice roller, stat-block lookup, name generators.
- File-watching for external edits to campaign files while the app is open.
