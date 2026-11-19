import { describe, expect, test } from "bun:test";

import { PAGE_HEIGHT, PAGE_WIDTH, parseMapSpec, renderMap } from "../src/map.ts";
import { parseMarkdown, renderPlanPdf, textWidth, toWinAnsi } from "../src/pdf.ts";

/** The PDF as text; Scribe's PDFs are 7-bit throughout. */
function source(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

/** Each page's MediaBox size and the strings it shows, unescaped, in drawing order. */
function pages(pdf: string): { width: number; height: number; text: string[] }[] {
  const result: { width: number; height: number; text: string[] }[] = [];
  for (const match of pdf.matchAll(/\/MediaBox \[0 0 (\d+) (\d+)\][^]*?\/Contents (\d+) 0 R/g)) {
    const contents = new RegExp(`(?:^|\\n)${match[3]} 0 obj\\n<< /Length \\d+ >>\\nstream\\n([^]*?)\\nendstream`).exec(
      pdf,
    );
    const text = [...(contents?.[1] ?? "").matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((shown) =>
      shown[1]!.replace(/\\([0-7]{3}|.)/g, (_, escape: string) =>
        escape.length === 3 ? String.fromCharCode(parseInt(escape, 8)) : escape,
      ),
    );
    result.push({ width: Number(match[1]), height: Number(match[2]), text });
  }
  return result;
}

function render(body: string, extra: { map?: string; subtitle?: string } = {}) {
  const pdf = renderPlanPdf({ title: "The Abbey", body, ...extra });
  const text = source(pdf.bytes);
  return { pdf, text, pages: pages(text) };
}

const span = (text: string, style: { bold?: boolean; italic?: boolean; code?: boolean } = {}) => ({
  text,
  bold: style.bold ?? false,
  italic: style.italic ?? false,
  code: style.code ?? false,
});

describe("toWinAnsi", () => {
  test("keeps ASCII and Latin-1, and maps typographic punctuation to WinAnsi", () => {
    expect(toWinAnsi("Café — “quoted” • it’s…")).toBe("Caf\xe9 \x97 \x93quoted\x94 \x95 it\x92s\x85");
  });

  test("folds what the standard fonts lack", () => {
    expect(toWinAnsi("a → b ≤ c")).toBe("a -> b <= c");
    expect(toWinAnsi("┌─┐│")).toBe("+-+|");
    expect(toWinAnsi("Łódź")).toBe("?\xf3dz");
    expect(toWinAnsi("tab\there")).toBe("tab    here");
  });

  test("drops emoji and invisible characters", () => {
    expect(toWinAnsi("dragon 🐉 lair​️")).toBe("dragon  lair");
  });
});

describe("parseMarkdown", () => {
  test("reads headings, styled paragraphs, nested and task lists", () => {
    const blocks = parseMarkdown(
      "# Title\n\nSome **bold *both*** and `code`.\n\n- one\n  - nested\n- [x] done\n\n1. first\n",
    );
    expect(blocks).toEqual([
      { kind: "heading", level: 1, spans: [span("Title")] },
      {
        kind: "paragraph",
        spans: [
          span("Some "),
          span("bold ", { bold: true }),
          span("both", { bold: true, italic: true }),
          span(" and "),
          span("code", { code: true }),
          span("."),
        ],
      },
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          {
            checked: undefined,
            blocks: [
              { kind: "paragraph", spans: [span("one")] },
              {
                kind: "list",
                ordered: false,
                start: 1,
                items: [{ checked: undefined, blocks: [{ kind: "paragraph", spans: [span("nested")] }] }],
              },
            ],
          },
          { checked: true, blocks: [{ kind: "paragraph", spans: [span("done")] }] },
        ],
      },
      {
        kind: "list",
        ordered: true,
        start: 1,
        items: [{ checked: undefined, blocks: [{ kind: "paragraph", spans: [span("first")] }] }],
      },
    ]);
  });

  test("keeps code blocks line for line and marks table header rows", () => {
    const blocks = parseMarkdown("```text\n[1 Gate]\n    |\n[2 Hall]\n```\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n");
    expect(blocks[0]).toEqual({ kind: "code", text: "[1 Gate]\n    |\n[2 Hall]" });
    expect(blocks[1]).toEqual({
      kind: "table",
      rows: [
        { header: true, cells: [{ spans: [span("A")], align: "left" }, { spans: [span("B")], align: "right" }] },
        { header: false, cells: [{ spans: [span("1")], align: "left" }, { spans: [span("2")], align: "right" }] },
      ],
    });
  });

  test("control characters in the text can't pose as markup", () => {
    expect(parseMarkdown("a\x01b\x0e0\x0fc")).toEqual([{ kind: "paragraph", spans: [span("ab0c")] }]);
  });

  test("spells out web links for paper", () => {
    expect(parseMarkdown("[the wiki](https://example.com/x) and [notes](notes.md)")).toEqual([
      { kind: "paragraph", spans: [span("the wiki (https://example.com/x) and notes")] },
    ]);
  });
});

describe("renderPlanPdf", () => {
  test("writes a well-formed PDF whose xref offsets point at their objects", () => {
    const { text } = render("Hello.");
    expect(text).toStartWith("%PDF-1.4\n");
    expect(text).toEndWith("%%EOF\n");
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const entries = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    entries.forEach((offset, index) => expect(text.slice(offset)).toStartWith(`${index + 1} 0 obj`));
    // Stream lengths are exact.
    for (const match of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const start = match.index! + match[0].length;
      expect(text.slice(start + Number(match[1]), start + Number(match[1]) + 10)).toBe("\nendstream");
    }
    expect(/[^\x00-\x7f]/.test(text)).toBe(false);
  });

  test("titles the plan unless it starts with its own # heading", () => {
    expect(render("Body.", { subtitle: "Shadowdark" }).pages[0]!.text.slice(0, 3)).toEqual([
      "The Abbey",
      "Shadowdark",
      "Body.",
    ]);
    expect(render("# Own Title\n\nBody.").pages[0]!.text.slice(0, 2)).toEqual(["Own Title", "Body."]);
  });

  test("escapes PDF string syntax in the text", () => {
    const { pages: [page] } = render("A (parenthetical) \\\\ back\\slash.");
    expect(page!.text[1]).toBe("A (parenthetical) \\ back\\slash.");
  });

  test("wraps text to the page width and flows onto more pages with numbered footers", () => {
    const word = "lorem ";
    const { pdf, pages: all } = render(word.repeat(2000));
    expect(pdf.pages).toBeGreaterThan(2);
    const width = 612 - 2 * 54;
    for (const page of all) {
      for (const line of page.text.slice(0, -1)) expect(textWidth(line, "regular", 10.5)).toBeLessThanOrEqual(width);
    }
    expect(all.map((page) => page.text.at(-1))).toEqual(
      all.map((_, index) => `The Abbey  \x95  Page ${index + 1} of ${all.length}`),
    );
  });

  test("breaks a word longer than a line rather than running off the page", () => {
    const { pages: [page] } = render("x".repeat(400));
    const lines = page!.text.slice(0, -1).filter((line) => line.startsWith("x"));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("x".repeat(400));
  });

  test("prints code blocks line for line, shrinking wide ones instead of wrapping them", () => {
    const wide = "+" + "-".repeat(98) + "+";
    const { text, pages: [page] } = render(`\`\`\`text\n${wide}\n|  1 Gate  |\n${wide}\n\`\`\``);
    expect(page!.text.slice(1, 4)).toEqual([wide, "|  1 Gate  |", wide]);
    // 100 columns of Courier fit the 492pt inside the shading at ~8.2pt.
    expect(text).toMatch(/\/F5 8\.\d+ Tf/);
  });

  test("puts the full-page map on its own landscape page, every line intact", () => {
    const spec = parseMapSpec(
      {
        title: "Abbey",
        locations: [
          { id: 1, name: "Gate", column: 1, row: 1 },
          { id: 2, name: "Hall", column: 2, row: 1 },
        ],
        connections: [{ from: 1, to: 2, type: "door" }],
      },
      "Abbey",
    );
    if (!spec.ok) throw new Error(spec.errors.join("; "));
    const map = renderMap(spec.value);
    if (!map.ok) throw new Error(map.errors.join("; "));

    const { pdf, pages: all } = render("Plan.", { map: map.value });
    expect(pdf.pages).toBe(2);
    const mapPage = all[1]!;
    expect([mapPage.width, mapPage.height]).toEqual([792, 612]);
    const lines = map.value.split("\n");
    expect(lines.length).toBe(PAGE_HEIGHT);
    expect(mapPage.text.slice(0, -1)).toEqual(lines);
    expect(Math.max(...lines.map((line) => line.length))).toBe(PAGE_WIDTH);
  });

  test("keeps a table's header on each page it spans", () => {
    const rows = Array.from({ length: 80 }, (_, index) => `| Bandit ${index} | 11 |`).join("\n");
    const { pages: all } = render(`| Creature | HP |\n|---|--:|\n${rows}`);
    expect(all.length).toBeGreaterThan(1);
    expect(all[0]!.text.slice(0, 3)).toEqual(["The Abbey", "Creature", "HP"]);
    for (const page of all.slice(1)) expect(page.text.slice(0, 2)).toEqual(["Creature", "HP"]);
  });
});
