# Source Documents — predicted issues vs. observed

Scratch notes for the first round of real-world testing of the PDF source
library (phase 6). The point of this file is to write the predictions down
*before* the feedback arrives, so we can tell which concerns were real and
which were speculation.

**Everything in "Predicted" below is inference from reading the code, not from
observed output.** None of it has been seen happen. Do not act on any of it
until a tester's report lines up with it — several of these are probably
overthinking.

## How to test

1. Put real PDFs in `~/Scribe/Sources/<System>/` — one folder per system
   (`Shadowdark`, `Knave`, whatever). First launch after that will extract them
   in the background; the text cache appears in `<System>/extracted/`.
2. Open a campaign whose **System** field matches the folder name, plan a
   session, and ask questions you'd genuinely ask at the table.
3. Also try the Drafting Table (one-shot mode) — it has the same tools but no
   campaign system to scope by.

What's worth capturing from testers, in rough priority order:

- A question the agent got **wrong or vague** where the answer was in the book.
- A question where it answered from its own training instead of citing a page.
- Any answer citing a page number that turns out to be the wrong page.
- Whether the cited snippets read as coherent sentences or as scrambled
  fragments.
- Time from launch to the first usable search on a big book.
- Anything about the `~/Scribe/Sources` folder layout that confused them.

Raw quotes are more useful than their diagnosis — testers tend to report "it
didn't know the grappling rules" rather than the mechanism, and the mechanism
is what we're trying to identify.

## Predicted issues

Ordered by my guess at expected value of fixing. Each has a symptom to match
against, so a tester report can confirm or kill it.

### 1. No stemming — inflection mismatch

Search tokenizes to bare lowercase word runs with no stemming, so `grapple`
does not match `grappling` or `grappled`. The agent writes queries in whatever
inflection it happens to think in; the book uses another.

- **Symptom**: `(no matches for "...")` on a topic the book clearly covers, and
  a slightly reworded question then works.
- **Fix if real**: a crude suffix-stripper (Porter-lite) applied to both query
  and page tokens, or prefix matching on terms over ~5 chars. Contained
  entirely in `tokenize()` in `src/store/sources.ts`.

### 2. A page is a coarse retrieval unit

Pages are the scoring unit. A rulebook page holds several unrelated rules, so a
page can rank well on one paragraph while the returned snippet comes from a
different part of it.

- **Symptom**: right page cited, snippet is about something else; or the agent
  reads a page and reports it doesn't contain the rule it just found there.
- **Fix if real**: chunk by paragraph or heading instead of page. Costs the
  clean "p.42" citation, which is a genuine loss — the page number is the thing
  a user can check against their physical book.

### 3. Multi-column layouts extract as interleaved fragments

PDF.js emits text in approximate reading order. For a two-column rulebook page
that often means the columns interleave. Search still works (tokens are
tokens), but the **snippet the agent reads and reasons from** may be scrambled.

- **Symptom**: snippets that read as word salad; agent gives a confidently
  wrong paraphrase of a rule it did locate.
- **Fix if real**: no cheap fix. Would mean position-aware extraction via
  `unpdf`'s lower-level `getDocumentProxy` and column detection. Expensive —
  needs strong evidence first.

### 4. `read_source_pages` 10-page cap is generous for small context windows

A dense rulebook page can run 800+ tokens, so a 10-page read is ~8k tokens —
the entire context window on a typical local Ollama model.

- **Symptom**: agent goes quiet, errors, or forgets the conversation right
  after reading a range. Local/small models only; won't reproduce on a hosted
  frontier model.
- **Fix if real**: cap by characters rather than page count in
  `readSourcePages` (`MAX_PAGE_SPAN` in `src/store/sources.ts`).

### 5. Scanned PDFs cache as empty and fail silently

Extraction is text-layer only. An image-only scan extracts to (near) nothing,
caches "successfully", and returns no matches forever. The agent reads that as
"the book doesn't cover this."

- **Symptom**: one book never produces hits while others do; its entry in
  `list_sources` shows a plausible page count but searches never touch it.
- **Fix if real**: flag near-zero-text documents in `list_sources` so the agent
  knows the difference between "no match" and "unreadable". OCR is a much
  bigger lift and is filed under deferred ideas in `PLAN.md`.

## Known-by-design, not bugs

Mention these to testers only if they hit them, so we don't lead the witness:

- **System scoping is by folder name.** A campaign's System field is free text
  ("D&D 5e") and needn't match a folder ("5e"). A scoped search that finds
  nothing widens to the whole library and says so in the result. Deliberate —
  the alternative is a silent miss the user can't diagnose.
- **Renaming a PDF re-slugs it**, re-extracting under the new name and leaving
  the old cache file orphaned in `extracted/`. Harmless, self-healing, but the
  stale file is never cleaned up.
- **The `slug:` field in cache frontmatter is written but never read** — slugs
  are recomputed from filenames on every call. Decorative only. Should probably
  be deleted or commented as such before someone treats it as authoritative.
- **First launch with a big library is slow to warm.** Indexing is
  fire-and-forget at startup with concurrency 3; searches before it finishes
  see fewer documents. Subsequent launches are a `stat` per file.

## Observed (fill in from testers)

| Date | Tester | What they hit | Matches prediction? |
|---|---|---|---|
| | | | |
