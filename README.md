# Scribe

A bring-your-own-model TTRPG campaign builder and organizer. Scribe is an
interactive terminal UI (Bun + TypeScript + OpenTUI): you create campaigns for
any system, plan sessions with an LLM agent in a chat harness, export the
session notes as markdown to run at the table, then report what happened so
the agent appends to a running campaign summary — its memory for planning the
next session.

The core loop:

```
plan → export → play (offline, at the table) → report → summary grows → plan next
```

## Install and run

```bash
# Install dependencies
bun install

# Run the app (interactive terminal UI)
bun run src/index.ts

# Watch mode during dev
bun --watch src/index.ts
```

Requires Bun v1.3+. Scribe is an interactive TUI — run it in a real terminal,
not a non-TTY or automated context. Other useful commands: `bunx tsc --noEmit`
(type check) and `bun test` (run all tests).

## Configuring model access

Scribe talks to any OpenAI-compatible chat API (OpenAI, OpenRouter, Ollama,
LM Studio, vLLM, …) via a configurable base URL and model, set from the
in-app Settings screen (which also offers a "Browse..." picker that lists
models from the configured provider). API keys are never stored — you point
Scribe at the *name* of an environment variable holding the key, and it reads
that env var at request time. App settings live in
`~/.config/scribe/config.json`.

## On-disk layout

Campaign data is markdown-first: plain files with flat `key: value`
frontmatter, in a user-visible folder (default `~/Scribe`) that you can open
in any editor — no database.

```
~/Scribe/
  Curse of Strahd/
    campaign.md          # frontmatter: name, system, created, nextSession
                          # body: ## Background … ## The Story So Far
    sessions/
      001-death-house.md # frontmatter: number, title, status, dates
      002-village-of-barovia.md
    .scribe/              # conversation logs (resumable), hidden
  One-Shots/               # saved standalone session plans
  Sources/
    Shadowdark/
      Shadowdark Core Rules.pdf
      extracted/          # cached extracted text, visible
```

## Learn more

- `AGENTS.md` — the authoritative, actively-maintained map of the codebase:
  per-module notes, invariants, and gotchas.
- `PLAN.md` — product design, domain model, and roadmap.
- `CLAUDE.md` — condensed entry point for AI coding agents working in this
  repo.
