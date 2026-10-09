# Scribe

A bring-your-own-model TTRPG campaign builder and organizer for the terminal.
You create campaigns for any system, plan sessions with an LLM agent in a chat,
export the session notes as markdown to run at the table, then report what
happened so the agent appends to a running campaign summary — its memory for
planning the next session.

The core loop:

```
plan → export → play (offline, at the table) → report → summary grows → plan next
```

Everything Scribe writes is a plain markdown file in a folder you own. There is
no database and no account.

## Install

Download the archive for your platform from the
[latest release](https://github.com/jv699/Scribe/releases/latest), unpack it,
and put `scribe` somewhere on your `PATH`.

| Platform              | File                         |
| --------------------- | ---------------------------- |
| macOS (Apple Silicon) | `scribe-darwin-arm64.tar.gz` |
| macOS (Intel)         | `scribe-darwin-x64.tar.gz`   |
| Linux (x64)           | `scribe-linux-x64.tar.gz`    |
| Linux (arm64)         | `scribe-linux-arm64.tar.gz`  |
| Windows (x64)         | `scribe-windows-x64.zip`     |

```bash
tar -xzf scribe-darwin-arm64.tar.gz
./scribe
```

The binaries are not signed or notarized. On macOS, a downloaded binary is
quarantined and Gatekeeper will refuse to open it until you clear the flag:

```bash
xattr -d com.apple.quarantine ./scribe
```

Each release includes a `SHA256SUMS` file if you want to verify a download.
The macOS Apple Silicon build is the one tested by hand; the others are built
and published but have had less use — please open an issue if one misbehaves.

Scribe is an interactive app and needs a real terminal. `scribe --help` and
`scribe --version` are the only command-line options.

### From source

Requires [Bun](https://bun.sh) v1.3+.

```bash
git clone https://github.com/jv699/Scribe.git
cd Scribe
bun install
bun start
```

## Quick start

### 1. Point Scribe at a model

Scribe talks to any OpenAI-compatible chat API. Open **Settings** from the main
menu and fill in the base URL, the model, and the *name* of the environment
variable that holds your API key. Scribe never stores the key itself — it reads
that variable each time it makes a request, so export it in the shell you
launch Scribe from.

| Provider   | Base URL                       | Example model       | API key env var      |
| ---------- | ------------------------------ | ------------------- | -------------------- |
| OpenAI     | `https://api.openai.com/v1`    | `gpt-4o-mini`       | `OPENAI_API_KEY`     |
| OpenRouter | `https://openrouter.ai/api/v1` | any model it lists  | `OPENROUTER_API_KEY` |
| Ollama     | `http://localhost:11434/v1`    | a model you pulled  | leave blank          |
| LM Studio  | `http://localhost:1234/v1`     | the loaded model    | leave blank          |

The model field lists what your provider offers once the base URL and key are
set. The env var name is yours to choose; the ones above are just conventions.

```bash
export OPENAI_API_KEY=sk-...
scribe
```

### 2. Run a campaign

1. **Campaigns → create a campaign.** Give it a name and a system.
2. **+ New Session**, then chat with the agent to plan it. The agent drafts
   the session notes into a markdown file in the campaign folder.
3. Run the session at the table from that file — open it in any editor, print
   it, or put it on a tablet.
4. Come back and tell the agent what happened. It appends to the campaign's
   **Story So Far**, which it reads when you plan the next session.

In the chat, type `/` for commands and `@` to mention a session or source.

### One-shots

The **Drafting Table** plans a standalone session with no campaign behind it.
`/save` saves the plan to your one-shots folder and `/map` draws a full-page
ASCII map of it. Saved drafts can be reopened and continued.

## Rulebooks as sources

Put PDFs in `~/Scribe/Sources/<System>/`, one folder per system, where the
folder name matches the campaign's **System** field. Scribe extracts the text
on launch and the agent can search and cite pages while planning.

Extraction reads the PDF's text layer only. A scanned, image-only PDF indexes
as empty; there is no OCR.

## Where your data lives

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

All three folders can be moved from the Settings screen. App settings live in
`~/.config/scribe/config.json`; set `SCRIBE_CONFIG_DIR` to keep them somewhere
else.

## Known limitations

- This is a 0.x release: the on-disk layout and config format may change
  between versions. See [CHANGELOG.md](CHANGELOG.md).
- Only OpenAI-compatible APIs are supported.
- A long-running campaign's summary is not yet compressed, so it can outgrow a
  small model's context window.
- Edits you make to campaign files while Scribe is open are not picked up
  until you reopen that screen.
- Maps are available in the Drafting Table only, not in campaign sessions.

## Contributing

`bun test` runs the tests, `bun run typecheck` type-checks, and `bun run build`
produces a standalone binary in `dist/`.

- [CLAUDE.md](CLAUDE.md) — the authoritative map of the codebase, also read by
  AI coding agents: per-module notes, invariants, gotchas, and how releases
  are cut.
- [PLAN.md](PLAN.md) — product design, domain model, and roadmap.

## License

[GPL-3.0](LICENSE).
