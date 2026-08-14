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
- **Settings** — provider (base URL), model (a free-form field with inline
  suggestions from the configured provider), API key env var name, campaigns
  directory, one-shots directory, sources directory.

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
  Sources/
    Shadowdark/
      Shadowdark Core Rules.pdf
      extracted/             # text cache, visible: nothing hidden from the user
        shadowdark-core-rules.md
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
- **Tools, scoped strictly to the active campaign folder** — confined by
  addressing resources by identity (session number) and resolving them through
  the store, never by accepting model-supplied paths:
  - `read_campaign_summary()`
  - `read_session_notes(n)` / `update_session_notes(n, content)`
  - `append_campaign_summary(entry)` — report phase only
  - `list_sessions()`

  Plus, added in later phases: `save_session` (one-shot only, on explicit user
  request), `list_oneshots` / `read_oneshot` / `update_oneshot` (one-shot only;
  safely continue a saved plan with wholesale body replacement), and the source-document tools `list_sources` / `search_sources` /
  `read_source_pages` (granted to planning and one-shot, not report). See
  `AGENTS.md` for the full current tool list and per-agent grants.
- **Asking the user** — `ask_user(question, options)` blocks the turn on a
  multiple-choice question shown where the prompt box was, so the agent
  resolves a genuine fork by asking rather than guessing. Granted to every
  agent; it declines when no UI is attached, and turns spent only on it don't
  count against the runaway-iteration budget.
- **Tool registry + agent gateway** — tools live one-per-file in
  `src/agent/tools/` and are granted to agents by name in `src/agent/agents.ts`.
  Access is a declaration, not a branch; names are compile-time checked.
- **Two modes, two prompts:**
  - *Planning*: "You are a TTRPG co-designer. System: X. Background + story so
    far: … Help plan session N; keep `sessions/00N.md` updated via tools."
  - *Report*: "The user played session N. Ask what happened, then append a
    concise summary via `append_campaign_summary`."
- **System prompt is code-owned, layered with an optional user file** — the
  core prompts (`CORE_CAMPAIGN_PROMPT` / `CORE_ONESHOT_PROMPT`) live in
  `src/agent/prompts.ts` and are never written to disk, so prompt changes
  always ship current rather than freezing at whatever version a user file was
  created from. `src/agent/context.ts` composes each mode's system prompt in
  three layers, always in this order: **core** (code-owned, or wholesale
  replaced via the config-file-only `systemPromptOverride` /
  `oneshotPromptOverride` escape hatch) → **context** (campaign
  background/story-so-far + source-document summary + the mode's framing —
  session draft notes for planning, "you just played session N" for report,
  nothing for one-shot) → **user instructions**, an optional, read-only file
  (`~/.config/scribe/instructions.md`, or `oneshot-instructions.md` for
  one-shots — see `src/store/instructions.ts`) appended last so it wins on
  tone and house rules without being able to delete the tool rules above it.
  These instruction files are never created by the app; if absent they
  contribute nothing.
- **Context assembly** — system prompt (as above) + campaign background +
  running summary + current draft + chat history. Known future issue: the
  running summary grows unboundedly; add a compression step later (not v1).

UI notes: OpenTUI 0.4.5 already ships `Markdown` and `ScrollBox` renderables —
the chat transcript renders streamed markdown directly.

## Screens

```
Main menu          → app destinations; nested campaign list/create (exists)
Campaign home      → system, story-so-far peek, session list w/ statuses,
                     actions: "Plan next session" / "Report outcome" / open folder
Chat screen        → shared by planning & report modes (different prompt/tools);
                     agent questions replace the prompt box until answered;
                     `/` commands and `@` mentions complete in a popup above it
Settings           → provider, model (inline provider-backed suggestions), key env var,
                     campaigns/one-shots/sources dirs
```

## Roadmap

Each phase leaves the app runnable.

| Phase | Deliverable | Status |
|---|---|---|
| **0. Persistence** | Markdown store; campaign home + manual session CRUD; "System" field; settings store | ✅ done |
| **1. Provider client** | Settings screen + OpenAI-compatible streaming chat | ✅ done |
| **2. Planning mode** | Agent loop + campaign tools + system-prompt file → agent writes `sessions/00N.md` | ✅ done |
| **3. Report mode** | Outcome chat → summary appended; session → `played` | ✅ done |
| **4. Polish** | Resume conversations, status guards (trash confirm), error handling, tests | ✅ done |
| **5. Interaction** | `ask_user` question widget (agent asks, turn blocks) + prompt completion popup (`/` commands, `@` campaign mentions) | ✅ done |
| **6. Source documents** | `~/Scribe/Sources` PDF library, cached as page-marked markdown; `list_sources` / `search_sources` / `read_source_pages` for the planning and one-shot agents | ✅ done |

Roadmap complete through phase 6. Remaining ideas are in **Deferred / future
ideas** below.

Phase 0 is a useful campaign organizer with zero AI risk and is fully testable
headlessly (`createTestRenderer` + temp dirs). Phases 2–3 are thin once 0–1
exist.

## Deferred / future ideas

- Running-summary compression when it outgrows the context window.
- Anthropic-native provider client.
- Search/stats across campaigns (would be the trigger to reconsider SQLite).
  Note the source library already does keyword search over cached page text
  without a database (`src/store/sources.ts`) — the same BM25-lite approach
  would likely serve campaigns too.
- OCR for scanned PDFs. Extraction is text-layer only today, so an image-only
  scan indexes as an empty document.
- A sources browser screen (list indexed documents, force a re-index). The
  library is agent-and-Finder-managed for now.
- Extra agent tools: dice roller, stat-block lookup, name generators. These
  now have a defined landing spot — add a `ToolSpec` file under
  `src/agent/tools/`, register it, and grant it in `src/agent/agents.ts`. The
  context-free ones (dice, names) are candidates for the `oneshot` agent
  (which has save/continue tools and `ask_user` today). Plan export shipped as
  `save_session`: the Drafting Table saves a one-shot to the configured
  one-shots directory, only on the user's explicit request.
- File-watching for external edits to campaign files while the app is open.
