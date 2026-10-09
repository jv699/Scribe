# Changelog

All notable changes to Scribe are recorded here. Versions follow
[Semantic Versioning](https://semver.org/); while Scribe is 0.x, the on-disk
layout and config format may still change between minor versions.

## 0.1.0 — 10/08/2026

The first release.

### Campaigns

- Create and manage campaigns for any system; each campaign is a folder of
  plain markdown files you own (default `~/Scribe`).
- Plan sessions with an LLM agent in a chat harness, export the session notes
  as markdown to run at the table, then report what happened so the agent
  appends to the campaign's running summary.
- Conversations are saved per session and resume where you left off.

### Drafting Table

- Plan standalone one-shots without a campaign, save them with `/save`, and
  continue saved drafts later.
- Full-page ASCII maps for one-shot plans with `/map`.

### Sources

- Drop rulebook PDFs into `~/Scribe/Sources/<System>/`; Scribe extracts the
  text and the agent can search and cite pages while planning.

### Models

- Works with any OpenAI-compatible chat API (OpenAI, OpenRouter, Ollama,
  LM Studio, …) via a configurable base URL and model, with an in-app model
  picker.
- API keys are never stored: settings hold the name of an environment
  variable, read at request time.

### Chat

- The agent can ask you multiple-choice questions mid-turn.
- `/` commands and `@` mentions with a completion popup.
- Context usage display.

### Distribution

- Standalone binaries for macOS, Linux, and Windows; no runtime to install.
- `scribe --version` and `scribe --help`.
