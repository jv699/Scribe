import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  indexSources,
  listSources,
  listSystems,
  readSourcePages,
  searchSources,
} from "../src/store/sources.ts";
import { parseFrontmatter } from "../src/store/frontmatter.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const RULES_PDF = join(FIXTURES, "rules.pdf");
const BESTIARY_PDF = join(FIXTURES, "bestiary.pdf");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scribe-sources-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Build a small uncompressed multi-page PDF, one line of text per page. */
function buildPdf(pages: string[]): Buffer {
  const pageObjStart = 3;
  const contentObjStart = pageObjStart + pages.length;
  const fontObjNum = contentObjStart + pages.length;
  const kids = pages.map((_, i) => `${pageObjStart + i} 0 R`).join(" ");

  const objs: string[] = [
    `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`,
    `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>endobj`,
  ];
  pages.forEach((_, i) => {
    const pageNum = pageObjStart + i;
    const contentNum = contentObjStart + i;
    objs.push(
      `${pageNum} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 150]/Contents ${contentNum} 0 R/Resources<</Font<</F1 ${fontObjNum} 0 R>>>>>>endobj`,
    );
  });
  pages.forEach((text, i) => {
    const contentNum = contentObjStart + i;
    const stream = `BT /F1 12 Tf 20 100 Td (${text.replace(/[()\\]/g, "")}) Tj ET`;
    objs.push(`${contentNum} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream\nendobj`);
  });
  objs.push(`${fontObjNum} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`);

  return Buffer.from(`%PDF-1.4\n${objs.join("\n")}\ntrailer<</Root 1 0 R>>`, "latin1");
}

describe("discovery", () => {
  test("finds PDFs nested under system folders", async () => {
    await mkdir(join(dir, "Shadowdark"), { recursive: true });
    await copyFile(RULES_PDF, join(dir, "Shadowdark", "rules.pdf"));
    await mkdir(join(dir, "Knave"), { recursive: true });
    await copyFile(BESTIARY_PDF, join(dir, "Knave", "bestiary.pdf"));

    const docs = await listSources(dir);
    expect(docs).toHaveLength(2);
    const bySystem = Object.fromEntries(docs.map((d) => [d.title, d.system]));
    expect(bySystem["rules"]).toBe("Shadowdark");
    expect(bySystem["bestiary"]).toBe("Knave");

    expect((await listSystems(dir)).sort()).toEqual(["Knave", "Shadowdark"]);
  });

  test("loose PDFs at the top level get system Unsorted", async () => {
    await copyFile(RULES_PDF, join(dir, "rules.pdf"));
    const docs = await listSources(dir);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.system).toBe("Unsorted");
    expect(await listSystems(dir)).toEqual(["Unsorted"]);
  });

  test("extracted/ and dotfolders are skipped", async () => {
    await mkdir(join(dir, "Shadowdark", "extracted"), { recursive: true });
    await copyFile(RULES_PDF, join(dir, "Shadowdark", "rules.pdf"));
    // A stray PDF sitting inside extracted/ must not be picked up as a document.
    await copyFile(BESTIARY_PDF, join(dir, "Shadowdark", "extracted", "sneaky.pdf"));
    await mkdir(join(dir, ".hidden"), { recursive: true });
    await copyFile(BESTIARY_PDF, join(dir, ".hidden", "bestiary.pdf"));

    const docs = await listSources(dir);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.title).toBe("rules");
    expect(await listSystems(dir)).toEqual(["Shadowdark"]);
  });

  test("empty folders are ignored", async () => {
    await mkdir(join(dir, "EmptySystem"), { recursive: true });
    expect(await listSources(dir)).toHaveLength(0);
    expect(await listSystems(dir)).toEqual([]);
  });

  test("listSources does not trigger extraction — pages is 0 with no cache", async () => {
    await copyFile(RULES_PDF, join(dir, "rules.pdf"));
    const docs = await listSources(dir);
    expect(docs[0]!.pages).toBe(0);
    // no extracted/ dir should have been created
    await expect(stat(join(dir, "extracted"))).rejects.toThrow();
  });

  test("two PDFs slugifying identically in the same folder get distinct slugs", async () => {
    await copyFile(RULES_PDF, join(dir, "Rules.pdf"));
    await copyFile(BESTIARY_PDF, join(dir, "Rules!.pdf"));
    const docs = await listSources(dir);
    const slugs = docs.map((d) => d.slug).sort();
    expect(new Set(slugs).size).toBe(2);
    expect(slugs).toContain("rules");
  });
});

describe("cache round-trip", () => {
  test("indexSources writes frontmatter and page-marked body", async () => {
    await mkdir(join(dir, "Shadowdark"), { recursive: true });
    await copyFile(RULES_PDF, join(dir, "Shadowdark", "rules.pdf"));

    const [doc] = await indexSources(dir);
    expect(doc!.pages).toBe(3);

    const raw = await readFile(doc!.cachePath, "utf8");
    const { data, body } = parseFrontmatter(raw);
    expect(data["source"]).toBe("rules.pdf");
    expect(data["slug"]).toBe("rules");
    expect(data["title"]).toBe("rules");
    expect(data["system"]).toBe("Shadowdark");
    expect(Number(data["pages"])).toBe(3);
    expect(Number(data["size"])).toBeGreaterThan(0);
    expect(Number(data["mtime"])).toBeGreaterThan(0);

    expect(body).toContain("<!-- page 1 -->");
    expect(body).toContain("<!-- page 2 -->");
    expect(body).toContain("<!-- page 3 -->");
    expect(body).toContain("grapple");
  });

  test("replaces a cache symlink without overwriting its target", async () => {
    await copyFile(RULES_PDF, join(dir, "rules.pdf"));
    await mkdir(join(dir, "extracted"));
    const victim = join(dir, "victim.txt");
    await writeFile(victim, "must stay untouched", "utf8");
    const cachePath = join(dir, "extracted", "rules.md");
    await symlink(victim, cachePath);

    const [doc] = await indexSources(dir);

    expect(await readFile(victim, "utf8")).toBe("must stay untouched");
    expect((await lstat(cachePath)).isSymbolicLink()).toBe(false);
    expect(await readFile(doc!.cachePath, "utf8")).toContain("<!-- page 1 -->");
  });

  test("refuses to write through a symlinked extracted directory", async () => {
    await copyFile(RULES_PDF, join(dir, "rules.pdf"));
    const outside = join(dir, "outside");
    await mkdir(outside);
    await symlink(outside, join(dir, "extracted"));

    const [doc] = await indexSources(dir);

    expect(doc!.pages).toBe(0);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("idempotent re-index", () => {
  test("a second indexSources does not rewrite an up-to-date cache", async () => {
    await copyFile(RULES_PDF, join(dir, "rules.pdf"));
    const [first] = await indexSources(dir);
    const before = (await stat(first!.cachePath)).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    const [second] = await indexSources(dir);
    const after = (await stat(second!.cachePath)).mtimeMs;

    expect(after).toBe(before);
  });
});

describe("staleness", () => {
  test("rewriting the PDF causes the cache to regenerate", async () => {
    await copyFile(RULES_PDF, join(dir, "doc.pdf"));
    const [first] = await indexSources(dir);
    expect(first!.pages).toBe(3);

    // Replace with a differently-shaped PDF (2 pages instead of 3) and bump mtime.
    await writeFile(join(dir, "doc.pdf"), buildPdf(["Only one page now", "And a second page"]));
    const future = new Date(Date.now() + 5000);
    await utimes(join(dir, "doc.pdf"), future, future);

    const [second] = await indexSources(dir);
    expect(second!.pages).toBe(2);
  });

  test("a failed refresh preserves but does not serve the stale cache", async () => {
    const pdfPath = join(dir, "doc.pdf");
    await copyFile(RULES_PDF, pdfPath);
    const [first] = await indexSources(dir);
    const cachedBefore = await readFile(first!.cachePath, "utf8");
    expect(await searchSources(dir, "grapple")).not.toEqual([]);

    await writeFile(pdfPath, "not a PDF", "utf8");
    const future = new Date(Date.now() + 5000);
    await utimes(pdfPath, future, future);
    const [failed] = await indexSources(dir);

    expect(failed!.pages).toBe(0);
    expect(await readFile(first!.cachePath, "utf8")).toBe(cachedBefore);
    expect((await listSources(dir))[0]!.pages).toBe(0);
    expect(await searchSources(dir, "grapple")).toEqual([]);
    expect(await readSourcePages(dir, first!.slug, 1, 1)).toBeNull();
  });
});

describe("search", () => {
  async function setup(): Promise<void> {
    await mkdir(join(dir, "Shadowdark"), { recursive: true });
    await copyFile(RULES_PDF, join(dir, "Shadowdark", "rules.pdf"));
    await mkdir(join(dir, "Knave"), { recursive: true });
    await copyFile(BESTIARY_PDF, join(dir, "Knave", "bestiary.pdf"));
    await indexSources(dir);
  }

  test("a known phrase ranks the right page first", async () => {
    await setup();
    const hits = await searchSources(dir, "grapple check");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.doc.title).toBe("rules");
    expect(hits[0]!.page).toBe(2);
  });

  test("multi-term co-occurrence beats single-term repetition", async () => {
    await setup();
    const hits = await searchSources(dir, "grapple check");
    const page2 = hits.find((h) => h.page === 2 && h.doc.title === "rules");
    const page1 = hits.find((h) => h.page === 1 && h.doc.title === "rules");
    expect(page2).toBeDefined();
    expect(page1).toBeDefined();
    expect(page2!.score).toBeGreaterThan(page1!.score);
  });

  test("caps at 3 hits per document", async () => {
    // 5-page doc where every page contains "widget".
    await writeFile(
      join(dir, "many.pdf"),
      buildPdf(["widget one here", "widget two here", "widget three here", "widget four here", "widget five here"]),
    );
    await indexSources(dir);

    const hits = await searchSources(dir, "widget", { limit: 20 });
    const fromMany = hits.filter((h) => h.doc.title === "many");
    expect(fromMany.length).toBe(3);
  });

  test("system scoping excludes other folders", async () => {
    await setup();
    const hits = await searchSources(dir, "grapple", { system: "Knave" });
    expect(hits.every((h) => h.doc.system === "Knave")).toBe(true);
    expect(hits.find((h) => h.doc.title === "rules")).toBeUndefined();
  });

  test("no match returns an empty array", async () => {
    await setup();
    expect(await searchSources(dir, "nonexistentxyzzy")).toEqual([]);
  });
});

describe("readSourcePages", () => {
  async function setup(): Promise<string> {
    await copyFile(RULES_PDF, join(dir, "rules.pdf"));
    const [doc] = await indexSources(dir);
    return doc!.slug;
  }

  test("clamps from/to to the document's page range", async () => {
    const slug = await setup();
    const result = await readSourcePages(dir, slug, -5, 999);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("<!-- page 1 -->");
    expect(result!.text).toContain("<!-- page 3 -->");
    expect(result!.text).not.toContain("<!-- page 4 -->");
  });

  test("caps the span at 10 pages", async () => {
    const pages = Array.from({ length: 15 }, (_, i) => `Page number ${i + 1} content marker`);
    await writeFile(join(dir, "big.pdf"), buildPdf(pages));
    const [doc] = await indexSources(dir);
    expect(doc!.pages).toBe(15);

    const result = await readSourcePages(dir, doc!.slug, 1, 15);
    expect(result).not.toBeNull();
    expect(result!.text).toContain("<!-- page 1 -->");
    expect(result!.text).toContain("<!-- page 10 -->");
    expect(result!.text).not.toContain("<!-- page 11 -->");
  });

  test("unknown slug returns null", async () => {
    await setup();
    expect(await readSourcePages(dir, "does-not-exist", 1, 1)).toBeNull();
  });

  test("path-traversal-shaped slug returns null, not a file read", async () => {
    await setup();
    expect(await readSourcePages(dir, "../../etc/passwd", 1, 1)).toBeNull();
  });
});
