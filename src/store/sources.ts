/**
 * Markdown-first cache + search for PDF source documents (rulebooks,
 * bestiaries, and the like), organized by system folder under the sources
 * directory:
 *
 *   <sourcesDir>/
 *     Shadowdark/
 *       Shadowdark Core Rules.pdf
 *       extracted/
 *         shadowdark-core-rules.md     # cache: frontmatter + page-marked body
 *     Knave/
 *       Knave 2e.pdf
 *       extracted/knave-2e.md
 *
 * Loose PDFs sitting directly in `<sourcesDir>` are valid documents too,
 * filed under the synthetic system "Unsorted" (their cache lands in
 * `<sourcesDir>/extracted/`, following the same "cache sits in `extracted/`
 * next to the PDF" rule as everything else).
 *
 * This is the only module in the repo allowed to import `unpdf` — all PDF
 * extraction happens here. Cache files are frontmatter (via
 * `frontmatter.ts`) + a body of `<!-- page N -->`-marked text; frontmatter
 * values are always strings, so numeric fields are parsed back with
 * `Number(...)` and guarded against `NaN`.
 *
 * **Security invariant** (see `AGENTS.md`): callers address documents by
 * identity — a slug or title — never by filesystem path. `readSourcePages`
 * resolves `slug` by scanning the in-memory index and comparing strings; the
 * caller's string is never joined into a path, so something like
 * `readSourcePages(dir, "../../etc/passwd", 1, 1)` simply fails to match
 * anything and returns `null`.
 */
import { basename, dirname, extname, join } from "node:path";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extractText } from "unpdf";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.ts";
import { slugify } from "./naming.ts";

export interface SourceDoc {
  slug: string;
  title: string;
  system: string;
  pdfPath: string;
  cachePath: string;
  pages: number;
}

export interface SourceHit {
  doc: SourceDoc;
  page: number;
  score: number;
  snippet: string;
}

const EXTRACTED_DIR = "extracted";
const UNSORTED = "Unsorted";
const MAX_PAGE_SPAN = 10;
const EXTRACT_CONCURRENCY = 3;

function isPdf(name: string): boolean {
  return extname(name).toLowerCase() === ".pdf";
}

interface DiscoveredPdf {
  system: string;
  pdfPath: string;
  fileName: string;
}

/** Walk `sourcesDir` for PDFs: subdirectories are systems, loose files are "Unsorted". */
async function discoverPdfs(sourcesDir: string): Promise<DiscoveredPdf[]> {
  let topEntries;
  try {
    topEntries = await readdir(sourcesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  topEntries = topEntries.slice().sort((a, b) => a.name.localeCompare(b.name));

  const results: DiscoveredPdf[] = [];

  for (const entry of topEntries) {
    if (entry.isFile() && isPdf(entry.name)) {
      results.push({ system: UNSORTED, pdfPath: join(sourcesDir, entry.name), fileName: entry.name });
    }
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === EXTRACTED_DIR) continue;

    const sysDir = join(sourcesDir, entry.name);
    let subEntries;
    try {
      subEntries = await readdir(sysDir, { withFileTypes: true });
    } catch {
      continue;
    }
    subEntries = subEntries.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of subEntries) {
      if (sub.isFile() && isPdf(sub.name)) {
        results.push({ system: entry.name, pdfPath: join(sysDir, sub.name), fileName: sub.name });
      }
    }
  }

  return results;
}

/** Pick a slug that doesn't collide with others already assigned in the same directory. */
function uniqueSlug(desired: string, existing: readonly string[]): string {
  if (!existing.includes(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired}-${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/**
 * Build the document index (identity + paths, `pages` left at 0) without
 * touching any cache.
 *
 * Slugs are unique across the *whole* library, not just within a system
 * folder, because `readSourcePages` resolves them globally — two systems that
 * each ship a "Core Rules.pdf" must not answer to the same name. Discovery
 * order is deterministic (loose PDFs, then systems alphabetically, then files
 * alphabetically), so a given library always assigns the same slugs.
 *
 * NOTE: this means the index must always be built over the full library. A
 * `systemFilter` is applied *after* slugs are assigned, so a scoped call and an
 * unscoped call agree on every slug.
 */
async function buildIndex(sourcesDir: string, systemFilter?: string): Promise<SourceDoc[]> {
  const discovered = await discoverPdfs(sourcesDir);
  const assigned: string[] = [];
  const docs: SourceDoc[] = [];

  for (const found of discovered) {
    const containerDir = dirname(found.pdfPath);
    const title = basename(found.fileName, extname(found.fileName));
    const desired = slugify(title) || "document";
    const slug = uniqueSlug(desired, assigned);
    assigned.push(slug);

    docs.push({
      slug,
      title,
      system: found.system,
      pdfPath: found.pdfPath,
      cachePath: join(containerDir, EXTRACTED_DIR, `${slug}.md`),
      pages: 0,
    });
  }

  if (!systemFilter) return docs;
  return docs.filter((doc) => doc.system.toLowerCase() === systemFilter.toLowerCase());
}

/** List systems (folders with at least one PDF, plus "Unsorted" if loose PDFs exist). */
export async function listSystems(sourcesDir: string): Promise<string[]> {
  const docs = await buildIndex(sourcesDir);
  const systems = new Set<string>();
  for (const doc of docs) systems.add(doc.system);
  return Array.from(systems).sort((a, b) => a.localeCompare(b));
}

/** List documents (optionally scoped to a system), filling in page counts from existing caches. Never extracts. */
export async function listSources(sourcesDir: string, system?: string): Promise<SourceDoc[]> {
  const docs = await buildIndex(sourcesDir, system);
  for (const doc of docs) {
    try {
      const raw = await readFile(doc.cachePath, "utf8");
      const { data } = parseFrontmatter(raw);
      const pages = Number(data["pages"]);
      doc.pages = Number.isFinite(pages) ? pages : 0;
    } catch {
      // No cache yet — leave pages at 0, do not extract.
    }
  }
  return docs.sort((a, b) => a.title.localeCompare(b.title));
}

async function mapWithConcurrency<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

/** Extract (or re-extract, if stale) each discovered PDF's text into its cache file. */
async function indexOne(doc: SourceDoc): Promise<void> {
  let st;
  try {
    st = await stat(doc.pdfPath);
  } catch {
    return; // PDF vanished between discovery and indexing.
  }

  let cached: Record<string, string> | null = null;
  try {
    cached = parseFrontmatter(await readFile(doc.cachePath, "utf8")).data;
  } catch {
    cached = null;
  }

  if (cached) {
    const cachedSize = Number(cached["size"]);
    const cachedMtime = Number(cached["mtime"]);
    if (Number.isFinite(cachedSize) && Number.isFinite(cachedMtime) && cachedSize === st.size && cachedMtime === st.mtimeMs) {
      const pages = Number(cached["pages"]);
      doc.pages = Number.isFinite(pages) ? pages : 0;
      return; // up to date
    }
  }

  let totalPages: number;
  let pages: string[];
  try {
    const buf = await readFile(doc.pdfPath);
    const extracted = await extractText(new Uint8Array(buf), { mergePages: false });
    totalPages = extracted.totalPages;
    pages = extracted.text;
  } catch {
    // Extraction failed — leave any stale cache alone and skip this doc.
    if (cached) {
      const staleage = Number(cached["pages"]);
      doc.pages = Number.isFinite(staleage) ? staleage : 0;
    }
    return;
  }

  const body = pages.map((text, i) => `<!-- page ${i + 1} -->\n${text.trim()}`).join("\n\n") + "\n";
  const frontmatter = {
    source: basename(doc.pdfPath),
    slug: doc.slug,
    title: doc.title,
    system: doc.system,
    pages: String(totalPages),
    size: String(st.size),
    mtime: String(st.mtimeMs),
  };

  await mkdir(dirname(doc.cachePath), { recursive: true });
  await writeFile(doc.cachePath, serializeFrontmatter(frontmatter, body), "utf8");
  doc.pages = totalPages;
}

/** Extract text for every PDF whose cache is missing or stale (size/mtime mismatch). Concurrency-capped, never throws per-doc. */
export async function indexSources(sourcesDir: string, system?: string): Promise<SourceDoc[]> {
  const docs = await buildIndex(sourcesDir, system);
  await mapWithConcurrency(docs, EXTRACT_CONCURRENCY, indexOne);
  return docs.sort((a, b) => a.title.localeCompare(b.title));
}

/** Split a cache body on its `<!-- page N -->` markers. */
function splitCachePages(body: string): { page: number; text: string }[] {
  const chunks = body.split(/(?=<!-- page \d+ -->)/).filter((chunk) => chunk.trim() !== "");
  const pages: { page: number; text: string }[] = [];
  for (const chunk of chunks) {
    const match = chunk.match(/^<!-- page (\d+) -->\n?([\s\S]*)$/);
    if (!match) continue;
    pages.push({ page: Number(match[1]), text: (match[2] ?? "").trim() });
  }
  return pages;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

function buildSnippet(text: string, terms: readonly string[]): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const lower = collapsed.toLowerCase();

  let matchPos = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (matchPos === -1 || idx < matchPos)) matchPos = idx;
  }

  const width = 240;
  if (matchPos === -1) {
    return collapsed.length > width ? `${collapsed.slice(0, width).trim()}…` : collapsed;
  }

  const half = Math.floor(width / 2);
  let start = Math.max(0, matchPos - half);
  const end = Math.min(collapsed.length, start + width);
  start = Math.max(0, end - width);

  let snippet = collapsed.slice(start, end).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < collapsed.length) snippet = `${snippet}…`;
  return snippet;
}

/** BM25-lite search over cached page text, scoped to an optional system. */
export async function searchSources(
  sourcesDir: string,
  query: string,
  opts?: { system?: string; limit?: number },
): Promise<SourceHit[]> {
  const limit = opts?.limit ?? 8;
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0) return [];

  const docs = await listSources(sourcesDir, opts?.system);

  interface PageEntry {
    doc: SourceDoc;
    page: number;
    text: string;
    tokens: string[];
  }
  const allPages: PageEntry[] = [];
  for (const doc of docs) {
    let raw: string;
    try {
      raw = await readFile(doc.cachePath, "utf8");
    } catch {
      continue;
    }
    const { body } = parseFrontmatter(raw);
    for (const p of splitCachePages(body)) {
      allPages.push({ doc, page: p.page, text: p.text, tokens: tokenize(p.text) });
    }
  }

  const totalPagesInCorpus = allPages.length;
  if (totalPagesInCorpus === 0) return [];

  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    let count = 0;
    for (const page of allPages) {
      if (page.tokens.includes(term)) count++;
    }
    documentFrequency.set(term, count);
  }

  interface Scored {
    doc: SourceDoc;
    page: number;
    text: string;
    score: number;
  }
  const scored: Scored[] = [];
  for (const page of allPages) {
    const pageLength = page.tokens.length || 1;
    let scoreSum = 0;
    let distinctMatches = 0;

    for (const term of queryTerms) {
      const tf = page.tokens.filter((t) => t === term).length;
      if (tf === 0) continue;
      distinctMatches++;
      const pagesContainingTerm = documentFrequency.get(term) ?? 0;
      if (pagesContainingTerm === 0) continue;
      const idf = Math.log(totalPagesInCorpus / pagesContainingTerm);
      scoreSum += (tf / pageLength) * idf;
    }

    if (distinctMatches === 0) continue;
    const coOccurrenceMultiplier = 1 + (distinctMatches - 1) * 0.5;
    scored.push({ doc: page.doc, page: page.page, text: page.text, score: scoreSum * coOccurrenceMultiplier });
  }

  scored.sort((a, b) => b.score - a.score);

  const perDocCount = new Map<string, number>();
  const capped: Scored[] = [];
  for (const hit of scored) {
    const count = perDocCount.get(hit.doc.cachePath) ?? 0;
    if (count >= 3) continue;
    perDocCount.set(hit.doc.cachePath, count + 1);
    capped.push(hit);
  }

  return capped.slice(0, limit).map((hit) => ({
    doc: hit.doc,
    page: hit.page,
    score: hit.score,
    snippet: buildSnippet(hit.text, queryTerms),
  }));
}

/** Read a page range (clamped to the document, capped at a 10-page span) from a document's cache, addressed by slug or title. */
export async function readSourcePages(
  sourcesDir: string,
  slug: string,
  from: number,
  to: number,
): Promise<{ doc: SourceDoc; text: string } | null> {
  const docs = await listSources(sourcesDir);
  const doc = docs.find((d) => d.slug === slug) ?? docs.find((d) => d.title.toLowerCase() === slug.toLowerCase());
  if (!doc || doc.pages < 1) return null;

  let raw: string;
  try {
    raw = await readFile(doc.cachePath, "utf8");
  } catch {
    return null;
  }

  const { body } = parseFrontmatter(raw);
  const pages = splitCachePages(body);

  const clampedFrom = Math.max(1, Math.min(from, doc.pages));
  let clampedTo = Math.max(clampedFrom, Math.min(to, doc.pages));
  if (clampedTo - clampedFrom + 1 > MAX_PAGE_SPAN) clampedTo = clampedFrom + MAX_PAGE_SPAN - 1;
  clampedTo = Math.min(clampedTo, doc.pages);

  const selected = pages.filter((p) => p.page >= clampedFrom && p.page <= clampedTo);
  const text = selected.map((p) => `<!-- page ${p.page} -->\n${p.text}`).join("\n\n");
  return { doc, text };
}
