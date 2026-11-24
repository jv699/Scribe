import { describe, expect, test } from "bun:test";

import { PAGE_HEIGHT, PAGE_WIDTH, parseMapSpec, renderMap } from "../src/map.ts";
import { isScribePlanPdf, parseMarkdown, renderPlanPdf, textWidth, toWinAnsi } from "../src/pdf.ts";

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

/** Every string drawn, with its page and position, in drawing order. */
function placed(pdf: string): { page: number; x: number; y: number; text: string }[] {
  const result: { page: number; x: number; y: number; text: string }[] = [];
  pages(pdf).forEach((_, page) => {
    const match = [...pdf.matchAll(/\/Contents (\d+) 0 R/g)][page]!;
    const body = new RegExp(`(?:^|\\n)${match[1]} 0 obj\\n<< /Length \\d+ >>\\nstream\\n([^]*?)\\nendstream`).exec(pdf)![1]!;
    for (const shown of body.matchAll(/(-?[\d.]+) (-?[\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj/g)) {
      result.push({ page, x: Number(shown[1]), y: Number(shown[2]), text: shown[3]! });
    }
  });
  return result;
}

function render(body: string, extra: { map?: string; subtitle?: string } = {}) {
  const pdf = renderPlanPdf({ title: "The Abbey", body, ...extra });
  const text = source(pdf.bytes);
  return { pdf, text, pages: pages(text) };
}

const span = (text: string, style: { bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean } = {}) => ({
  text,
  bold: style.bold ?? false,
  italic: style.italic ?? false,
  code: style.code ?? false,
  strike: style.strike ?? false,
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

  test("splits a table row taller than a page instead of drawing past the paper", () => {
    const long = Array.from({ length: 3000 }, (_, index) => `w${index}`).join(" ");
    const { text, pages: all } = render(`| Name | Notes |\n|---|---|\n| Mira | ${long} |\n| Tom | short |`);
    expect(all.length).toBeGreaterThan(2);
    const positions = placed(text);
    for (const { y } of positions) expect(y).toBeGreaterThanOrEqual(30);
    // Every word made it onto paper, in order.
    const words = positions.flatMap((entry) => entry.text.split(" ")).filter((word) => /^w\d+$/.test(word));
    expect(words).toEqual(long.split(" "));
    // The header repeats above each continuation.
    for (const page of all.slice(1)) expect(page.text.slice(0, 2)).toEqual(["Name", "Notes"]);
  });

  test("never leaves a list marker behind when the item's block moves to the next page", () => {
    const filler = Array.from({ length: 30 }, (_, index) => `Paragraph ${index}.`).join("\n\n");
    const code = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const { text } = render(`${filler}\n\n- \`\`\`text\n  ${code.replaceAll("\n", "\n  ")}\n  \`\`\``);
    const positions = placed(text);
    const bullet = positions.find((entry) => entry.text === "\\225")!;
    const firstLine = positions.find((entry) => entry.text === "line 0")!;
    expect(bullet.page).toBe(firstLine.page);
  });

  test("gives empty list items their own line", () => {
    const { text } = render("-\n- b\n- c");
    const bullets = placed(text).filter((entry) => entry.text === "\\225");
    expect(bullets).toHaveLength(3);
    expect(bullets[0]!.y - bullets[1]!.y).toBeGreaterThanOrEqual(14);
  });

  test("strikes through struck text", () => {
    expect(parseMarkdown("Keep ~~ambush~~ parley")).toEqual([
      { kind: "paragraph", spans: [span("Keep "), span("ambush", { strike: true }), span(" parley")] },
    ]);
    const { text, pages: [page] } = render("Keep ~~ambush~~ parley");
    expect(page!.text.slice(1, 4)).toEqual(["Keep", "ambush", "parley"]);
    // One stroke through the struck run, on top of the text.
    const ambush = placed(text).find((entry) => entry.text === "ambush")!;
    expect(text).toMatch(new RegExp(`${ambush.x} [\\d.]+ m [\\d.]+ [\\d.]+ l S`));
  });

  test("keeps hard line breaks, outside code and tables only", () => {
    const { pages: [page] } = render("AC 15  \nHP 22\\\nSpeed 30\nsoft");
    expect(page!.text.slice(1, 4)).toEqual(["AC 15", "HP 22", "Speed 30 soft"]);

    expect(parseMarkdown("```\na  \nb\\\nc\n```")).toEqual([{ kind: "code", text: "a  \nb\\\nc" }]);
    expect(parseMarkdown("    a  \n    b")).toEqual([{ kind: "code", text: "a  \nb" }]);
    // Trailing spaces on table lines are never breaks, and are dropped: Bun
    // 1.4.2 (CI's version) reads a table whose lines end in spaces as a
    // paragraph, while 1.4.4 reads it as a table.
    for (const table of ["| A |\n|---|\n| 1 |\n", "| A | B |\n|---|---|\n| 1 | 2 |\n"]) {
      const trailing = parseMarkdown(table.replaceAll("\n", "  \n"));
      expect(trailing).toEqual(parseMarkdown(table));
      expect(trailing[0]?.kind).toBe("table");
    }
  });

  test("cuts a long title in the footer so the page number stays on the page", () => {
    const title = "The Very Long Adventure ".repeat(10).trim();
    const pdf = renderPlanPdf({ title, body: "Body." });
    const footer = placed(source(pdf.bytes)).at(-1)!;
    expect(footer.x).toBeGreaterThanOrEqual(54);
    expect(footer.text).toEndWith("\\205  \\225  Page 1 of 1");
  });
});

describe("isScribePlanPdf", () => {
  const own = source(renderPlanPdf({ title: "Abbey", body: "Plan.", slug: "abbey" }).bytes);

  test("recognizes Scribe's printout of the same plan only", () => {
    expect(isScribePlanPdf(own, "abbey")).toBe(true);
    expect(isScribePlanPdf(own, "crypt")).toBe(false);
  });

  test("isn't fooled by another tool calling itself Scribe", () => {
    const other =
      "%PDF-1.4\n1 0 obj\n<< /Creator (Scribe) /Producer (Scribe) >>\nendobj\n" +
      "trailer\n<< /Size 2 /Info 1 0 R >>\n%%EOF\n";
    expect(isScribePlanPdf(other, "abbey")).toBe(false);
    // The marker only counts inside the Info dictionary.
    const quoted = other.replace("endobj", "endobj\n% /Creator (Scribe) /ScribePlan (abbey)");
    expect(isScribePlanPdf(quoted, "abbey")).toBe(false);
  });
});
