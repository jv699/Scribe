/** PDF extraction stays in this module; callers identify documents by slug or title, never path. */
import type { Stats } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";
import { extractText } from "unpdf";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.ts";
import { slugify, uniqueName } from "./naming.ts";
import { atomicReplaceRegularFile, isDirectoryNoFollow, readRegularFileNoFollow } from "./safe-files.ts";

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

async function readCache(path: string): Promise<string> {
  const cacheDir = dirname(path);
  if (!(await isDirectoryNoFollow(cacheDir))) {
    throw new Error("source cache directory is not a regular directory");
  }
  return readRegularFileNoFollow(path);
}

async function writeCache(path: string, content: string): Promise<boolean> {
  // A sibling temporary keeps a failed refresh from truncating a good cache.
  return atomicReplaceRegularFile(path, content);
}

function cacheMatchesPdf(data: Record<string, string>, pdf: Stats): boolean {
  const cachedSize = Number(data["size"]);
  const cachedMtime = Number(data["mtime"]);
  return (
    Number.isFinite(cachedSize) &&
    Number.isFinite(cachedMtime) &&
    cachedSize === pdf.size &&
    cachedMtime === pdf.mtimeMs
  );
}

async function readFreshCache(doc: SourceDoc): Promise<ReturnType<typeof parseFrontmatter> | null> {
  try {
    const pdf = await stat(doc.pdfPath);
    const parsed = parseFrontmatter(await readCache(doc.cachePath));
    return cacheMatchesPdf(parsed.data, pdf) ? parsed : null;
  } catch {
    return null;
  }
}

function isPdf(name: string): boolean {
  return extname(name).toLowerCase() === ".pdf";
}

interface DiscoveredPdf {
  system: string;
  pdfPath: string;
  fileName: string;
}

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

/**
 * Assigns globally unique, deterministic slugs before filtering by system, so
 * scoped and unscoped calls agree on document identity.
 */
async function buildIndex(sourcesDir: string, systemFilter?: string): Promise<SourceDoc[]> {
  const discovered = await discoverPdfs(sourcesDir);
  const assigned: string[] = [];
  const docs: SourceDoc[] = [];

  for (const found of discovered) {
    const containerDir = dirname(found.pdfPath);
    const title = basename(found.fileName, extname(found.fileName));
    const desired = slugify(title) || "document";
    const slug = uniqueName(desired, assigned, { separator: "-" });
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

export async function listSystems(sourcesDir: string): Promise<string[]> {
  const docs = await buildIndex(sourcesDir);
  const systems = new Set<string>();
  for (const doc of docs) systems.add(doc.system);
  return Array.from(systems).sort((a, b) => a.localeCompare(b));
}

/** Reads page counts from fresh caches without extracting PDFs. */
export async function listSources(sourcesDir: string, system?: string): Promise<SourceDoc[]> {
  const docs = await buildIndex(sourcesDir, system);
  for (const doc of docs) {
    const fresh = await readFreshCache(doc);
    if (fresh) {
      const { data } = fresh;
      const pages = Number(data["pages"]);
      doc.pages = Number.isFinite(pages) ? pages : 0;
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

async function indexOne(doc: SourceDoc): Promise<void> {
  let st;
  try {
    st = await stat(doc.pdfPath);
  } catch {
    return; // The PDF may vanish after discovery.
  }

  let cached: Record<string, string> | null = null;
  try {
    cached = parseFrontmatter(await readCache(doc.cachePath)).data;
  } catch {
    cached = null;
  }

  if (cached) {
    if (cacheMatchesPdf(cached, st)) {
      const pages = Number(cached["pages"]);
      doc.pages = Number.isFinite(pages) ? pages : 0;
      return;
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
    // Keep the old cache as recoverable derived data, but mark this document
    // unavailable until a later extraction refreshes its source fingerprint.
    doc.pages = 0;
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

  const written = await writeCache(doc.cachePath, serializeFrontmatter(frontmatter, body));
  if (!written) return;
  doc.pages = totalPages;
}

/** Refreshes stale caches with bounded concurrency. */
export async function indexSources(sourcesDir: string, system?: string): Promise<SourceDoc[]> {
  const docs = await buildIndex(sourcesDir, system);
  await mapWithConcurrency(docs, EXTRACT_CONCURRENCY, indexOne);
  return docs.sort((a, b) => a.title.localeCompare(b.title));
}

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

export async function searchSources(
  sourcesDir: string,
  query: string,
  opts?: { system?: string; limit?: number },
): Promise<SourceHit[]> {
  const limit = opts?.limit ?? 8;
  const queryTerms = Array.from(new Set(tokenize(query)));
  if (queryTerms.length === 0) return [];

  // Avoid reopening each cache through listSources before reading its body.
  const docs = await buildIndex(sourcesDir, opts?.system);
  docs.sort((a, b) => a.title.localeCompare(b.title));

  interface PageEntry {
    doc: SourceDoc;
    page: number;
    text: string;
    tokens: string[];
  }
  const allPages: PageEntry[] = [];
  for (const doc of docs) {
    const fresh = await readFreshCache(doc);
    if (!fresh) continue;
    const { data, body } = fresh;
    const pages = Number(data["pages"]);
    doc.pages = Number.isFinite(pages) ? pages : 0;
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

export async function readSourcePages(
  sourcesDir: string,
  slug: string,
  from: number,
  to: number,
): Promise<{ doc: SourceDoc; text: string } | null> {
  const docs = await listSources(sourcesDir);
  const doc = docs.find((d) => d.slug === slug) ?? docs.find((d) => d.title.toLowerCase() === slug.toLowerCase());
  if (!doc || doc.pages < 1) return null;

  const fresh = await readFreshCache(doc);
  if (!fresh) return null;
  const { body } = fresh;
  const pages = splitCachePages(body);

  const clampedFrom = Math.max(1, Math.min(from, doc.pages));
  let clampedTo = Math.max(clampedFrom, Math.min(to, doc.pages));
  if (clampedTo - clampedFrom + 1 > MAX_PAGE_SPAN) clampedTo = clampedFrom + MAX_PAGE_SPAN - 1;
  clampedTo = Math.min(clampedTo, doc.pages);

  const selected = pages.filter((p) => p.page >= clampedFrom && p.page <= clampedTo);
  const text = selected.map((p) => `<!-- page ${p.page} -->\n${p.text}`).join("\n\n");
  return { doc, text };
}
