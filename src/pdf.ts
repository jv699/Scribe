/**
 * Printable PDFs of saved plans, written from scratch with no dependency.
 *
 * Markdown stays the real copy; a PDF is a printout of it. The plan's
 * markdown is parsed by Bun's built-in parser (`Bun.markdown.render`) into a
 * small block tree, laid out onto US Letter pages here, and written as a
 * plain PDF 1.4 file. A full-page map, when there is one, gets its own
 * landscape page in Courier sized so its whole grid fits — which is the point:
 * generic converters wrap or reflow the map's 100-column lines.
 *
 * Only the standard 14 PDF fonts are used (Helvetica and Courier), so nothing
 * is embedded and every reader has them. They cover WinAnsi (Latin-1 plus
 * typographic quotes and dashes); anything else is folded to a near ASCII
 * equivalent by `toWinAnsi`. Like `map.ts`, this module is pure: it takes
 * text and returns bytes, and the store decides where they go.
 */

// ---------------------------------------------------------------------------
// Fonts

type FontId = "regular" | "bold" | "italic" | "boldItalic" | "mono" | "monoBold";

const FONTS: Record<FontId, { resource: string; baseFont: string }> = {
  regular: { resource: "F1", baseFont: "Helvetica" },
  bold: { resource: "F2", baseFont: "Helvetica-Bold" },
  italic: { resource: "F3", baseFont: "Helvetica-Oblique" },
  boldItalic: { resource: "F4", baseFont: "Helvetica-BoldOblique" },
  mono: { resource: "F5", baseFont: "Courier" },
  monoBold: { resource: "F6", baseFont: "Courier-Bold" },
};

/**
 * Advance widths (1/1000 em) of WinAnsi codes 32–255, from Adobe's core-font
 * AFM metrics. The oblique faces share their upright face's widths, and every
 * Courier glyph is 600.
 */
// prettier-ignore
const HELVETICA_WIDTHS = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,500,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
// prettier-ignore
const HELVETICA_BOLD_WIDTHS = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,556,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];

function glyphWidth(font: FontId, code: number): number {
  if (font === "mono" || font === "monoBold") return 600;
  const table = font === "bold" || font === "boldItalic" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  return table[code - 32] ?? 556;
}

/** Width in points of WinAnsi-encoded `text` (see `toWinAnsi`). */
export function textWidth(text: string, font: FontId, size: number): number {
  let units = 0;
  for (let i = 0; i < text.length; i++) units += glyphWidth(font, text.charCodeAt(i));
  return (units * size) / 1000;
}

// ---------------------------------------------------------------------------
// Text encoding

/** Unicode characters WinAnsi places in 0x80–0x9F. */
const WIN_ANSI_SPECIALS: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Near equivalents for common characters WinAnsi lacks. */
const FOLDS: Record<string, string> = {
  "←": "<-", "→": "->", "↔": "<->", "↑": "^", "↓": "v",
  "⇐": "<=", "⇒": "=>", "≤": "<=", "≥": ">=", "≠": "!=", "≈": "~",
  "−": "-", "‐": "-", "‑": "-", "‒": "-", "―": "-", "′": "'", "″": '"',
  "★": "*", "☆": "*", "☐": "[ ]", "☑": "[x]", "☒": "[x]", "✓": "v", "✔": "v",
  "✗": "x", "✘": "x", "●": "•", "▪": "•", "◦": "o", "‣": ">",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
};

/**
 * Encodes `text` for the standard fonts: the result's char codes are WinAnsi
 * bytes (32–255). Accents WinAnsi lacks are dropped from their letters,
 * common symbols are folded to ASCII, emoji and invisible characters vanish,
 * and anything else becomes "?".
 */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += char;
    } else if (WIN_ANSI_SPECIALS[code] !== undefined) {
      out += String.fromCharCode(WIN_ANSI_SPECIALS[code]);
    } else if (code === 0x09) {
      out += "    ";
    } else if (FOLDS[char] !== undefined) {
      out += toWinAnsi(FOLDS[char]);
    } else if (code >= 0x2500 && code <= 0x257f) {
      // Box drawing: keep the line's direction, if not its weight.
      out += [0x2500, 0x2501, 0x2504, 0x2505, 0x2508, 0x2509, 0x2550].includes(code)
        ? "-"
        : [0x2502, 0x2503, 0x2506, 0x2507, 0x250a, 0x250b, 0x2551].includes(code)
          ? "|"
          : "+";
    } else if (
      code < 0x20 ||
      (code >= 0x7f && code < 0xa0) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      code === 0xfeff ||
      code >= 0x1f000 ||
      (code >= 0x2600 && code <= 0x27bf) ||
      (code >= 0x0300 && code <= 0x036f)
    ) {
      // Control, zero-width, variation selector, emoji, dingbat, stray accent.
    } else {
      const base = char.normalize("NFD").replace(/[̀-ͯ]/g, "");
      out += base !== char && base !== "" ? toWinAnsi(base) : "?";
    }
  }
  return out;
}

/** A WinAnsi string as a PDF literal string, kept 7-bit so lengths are char counts. */
function pdfString(text: string): string {
  let out = "(";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += "\\" + text[i];
    else if (code < 0x20 || code > 0x7e) out += "\\" + code.toString(8).padStart(3, "0");
    else out += text[i];
  }
  return out + ")";
}

/** Any text as a UTF-16BE hex string, for document metadata. */
function pdfUnicodeString(text: string): string {
  let hex = "<FEFF";
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return hex + ">";
}

const num = (value: number): string => String(Math.round(value * 100) / 100);

// ---------------------------------------------------------------------------
// Markdown → blocks

interface Span {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
}

type Block =
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "code"; text: string }
  | { kind: "table"; rows: TableRow[] }
  | { kind: "rule" };

interface ListItem {
  checked?: boolean | undefined;
  blocks: Block[];
}

interface TableRow {
  header: boolean;
  cells: { spans: Span[]; align: "left" | "center" | "right" }[];
}

// Markers threaded through Bun.markdown.render's string output. Control
// characters are stripped from the input first, so text can't forge them.
const BOLD_ON = "\x01";
const BOLD_OFF = "\x02";
const ITALIC_ON = "\x03";
const ITALIC_OFF = "\x04";
const CODE_ON = "\x05";
const CODE_OFF = "\x06";
const BLOCK_OPEN = "\x0e";
const BLOCK_CLOSE = "\x0f";
const BLOCK_REF = /\x0e(\d+)\x0f/g;

/** Inline markup string → styled spans; newlines become spaces. */
function toSpans(marked: string): Span[] {
  const spans: Span[] = [];
  let bold = 0;
  let italic = 0;
  let code = 0;
  let text = "";
  const flush = () => {
    if (text !== "") spans.push({ text, bold: bold > 0, italic: italic > 0, code: code > 0 });
    text = "";
  };
  for (const char of marked.replace(BLOCK_REF, "")) {
    const change = { [BOLD_ON]: 1, [BOLD_OFF]: -1, [ITALIC_ON]: 2, [ITALIC_OFF]: -2, [CODE_ON]: 3, [CODE_OFF]: -3 }[
      char
    ];
    if (change === undefined) {
      text += char === "\n" ? " " : char;
      continue;
    }
    flush();
    const delta = Math.sign(change);
    if (Math.abs(change) === 1) bold += delta;
    else if (Math.abs(change) === 2) italic += delta;
    else code += delta;
  }
  flush();
  return spans;
}

/** Parses a plan's markdown body into the blocks the layout understands. */
export function parseMarkdown(markdown: string): Block[] {
  // Keep \t and \n; everything else below 0x20 is reserved for the markers.
  const source = markdown.replace(/[\x00-\x08\x0b-\x1f]/g, "");
  const registry: Block[] = [];
  const cells: TableRow["cells"][number][] = [];
  const rows: TableRow[] = [];
  const items: ListItem[] = [];
  let inHead = false;
  const ref = (index: number) => `${BLOCK_OPEN}${index}${BLOCK_CLOSE}`;
  const add = (block: Block) => ref(registry.push(block) - 1);

  /** A mix of inline text and block references → blocks, in order. */
  const blocksOf = (children: string): Block[] => {
    const blocks: Block[] = [];
    for (const piece of children.split(/(\x0e\d+\x0f)/)) {
      const match = /^\x0e(\d+)\x0f$/.exec(piece);
      if (match) {
        const block = registry[Number(match[1])];
        if (block) blocks.push(block);
      } else if (piece.trim() !== "") {
        blocks.push({ kind: "paragraph", spans: toSpans(piece.trim()) });
      }
    }
    return blocks;
  };

  const root = Bun.markdown.render(source, {
    heading: (children, meta) => add({ kind: "heading", level: meta.level, spans: toSpans(children) }),
    paragraph: (children) => add({ kind: "paragraph", spans: toSpans(children) }),
    blockquote: (children) => add({ kind: "quote", blocks: blocksOf(children) }),
    code: (children) => add({ kind: "code", text: children.replace(/\n$/, "") }),
    html: (children) => add({ kind: "code", text: children.replace(/\n$/, "") }),
    hr: () => add({ kind: "rule" }),
    listItem: (children, meta) => {
      const index = items.push({ checked: meta.checked, blocks: blocksOf(children) }) - 1;
      return `\x10${index}\x11`;
    },
    list: (children, meta) => {
      const listItems = [...children.matchAll(/\x10(\d+)\x11/g)].map((match) => items[Number(match[1])]!);
      return add({ kind: "list", ordered: meta.ordered, start: meta.start ?? 1, items: listItems });
    },
    th: (children, meta) => {
      // Cells render before their row, so the row learns it is a header here.
      inHead = true;
      return `\x12${cells.push({ spans: toSpans(children), align: meta?.align ?? "left" }) - 1}\x13`;
    },
    td: (children, meta) => `\x12${cells.push({ spans: toSpans(children), align: meta?.align ?? "left" }) - 1}\x13`,
    tr: (children) => {
      const rowCells = [...children.matchAll(/\x12(\d+)\x13/g)].map((match) => cells[Number(match[1])]!);
      const header = inHead;
      inHead = false;
      return `\x14${rows.push({ header, cells: rowCells }) - 1}\x15`;
    },
    table: (children) =>
      add({ kind: "table", rows: [...children.matchAll(/\x14(\d+)\x15/g)].map((match) => rows[Number(match[1])]!) }),
    strong: (children) => BOLD_ON + children + BOLD_OFF,
    emphasis: (children) => ITALIC_ON + children + ITALIC_OFF,
    codespan: (children) => CODE_ON + children + CODE_OFF,
    link: (children, meta) => {
      const href = meta.href;
      const shown = children.replace(/[\x01-\x06]/g, "");
      return /^https?:\/\//i.test(href) && shown !== href ? `${children} (${href})` : children;
    },
    image: (children) => `${ITALIC_ON}[Image: ${children}]${ITALIC_OFF}`,
  });
  return blocksOf(root);
}

// ---------------------------------------------------------------------------
// Pages

/** US Letter, in points. */
const LETTER = { width: 612, height: 792 };
const MARGIN = 54;
const FOOTER_Y = 30;
const BODY_SIZE = 10.5;
const BODY_LEADING = 14;
const CODE_SIZE = 9;
const MIN_CODE_SIZE = 6;
const TABLE_SIZE = 9.5;
const INK = 0.1;
const MUTED = 0.45;
const RULE = 0.7;
const SHADE = 0.94;

interface Page {
  width: number;
  height: number;
  /** Drawn first, so shading sits under the text. */
  under: string[];
  over: string[];
}

function newPage(width = LETTER.width, height = LETTER.height): Page {
  return { width, height, under: [], over: [] };
}

function drawText(page: Page, x: number, y: number, font: FontId, size: number, text: string, gray = INK): void {
  if (text === "") return;
  page.over.push(`BT ${num(gray)} g /${FONTS[font].resource} ${num(size)} Tf ${num(x)} ${num(y)} Td ${pdfString(text)} Tj ET`);
}

function drawLine(page: Page, x1: number, y1: number, x2: number, y2: number, width: number, gray: number): void {
  page.over.push(`${num(gray)} G ${num(width)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
}

function fillRect(page: Page, x: number, y: number, width: number, height: number, gray: number): void {
  page.under.push(`${num(gray)} g ${num(x)} ${num(y)} ${num(width)} ${num(height)} re f`);
}

function strokeRect(page: Page, x: number, y: number, width: number, height: number, lineWidth: number): void {
  page.over.push(`${num(INK)} G ${num(lineWidth)} w ${num(x)} ${num(y)} ${num(width)} ${num(height)} re S`);
}

/** A word-or-space fragment ready to place, already WinAnsi-encoded. */
interface Piece {
  text: string;
  font: FontId;
  width: number;
  space: boolean;
}

function fontFor(span: Span, base: { bold?: boolean; italic?: boolean }): FontId {
  const bold = span.bold || base.bold === true;
  if (span.code) return bold ? "monoBold" : "mono";
  const italic = span.italic || base.italic === true;
  return bold ? (italic ? "boldItalic" : "bold") : italic ? "italic" : "regular";
}

/** Greedy line breaking over styled spans; over-long words break by character. */
function wrapSpans(
  spans: Span[],
  size: number,
  width: number,
  base: { bold?: boolean; italic?: boolean } = {},
): Piece[][] {
  const pieces: Piece[] = [];
  for (const span of spans) {
    const font = fontFor(span, base);
    for (const part of toWinAnsi(span.text).split(/( +)/)) {
      if (part === "") continue;
      const space = part.trim() === "";
      const text = space ? " " : part;
      pieces.push({ text, font, width: textWidth(text, font, size), space });
    }
  }

  const lines: Piece[][] = [];
  let line: Piece[] = [];
  let used = 0;
  const finish = () => {
    while (line.length > 0 && line[line.length - 1]!.space) line.pop();
    if (line.length > 0) lines.push(line);
    line = [];
    used = 0;
  };
  for (const piece of pieces) {
    if (piece.space) {
      if (line.length > 0 && !line[line.length - 1]!.space) {
        line.push(piece);
        used += piece.width;
      }
      continue;
    }
    if (line.length > 0 && used + piece.width > width) finish();
    if (piece.width <= width) {
      line.push(piece);
      used += piece.width;
      continue;
    }
    // Wider than a whole line: break it by character.
    let chunk = "";
    for (const char of piece.text) {
      if (chunk !== "" && textWidth(chunk + char, piece.font, size) > width) {
        line.push({ ...piece, text: chunk, width: textWidth(chunk, piece.font, size) });
        finish();
        chunk = "";
      }
      chunk += char;
    }
    line.push({ ...piece, text: chunk, width: textWidth(chunk, piece.font, size) });
    used = textWidth(chunk, piece.font, size);
  }
  finish();
  return lines;
}

function lineWidth(line: Piece[]): number {
  return line.reduce((sum, piece) => sum + piece.width, 0);
}

/** Draws a line, one string per run of same-font pieces so copied text keeps its spaces. */
function drawPieces(page: Page, x: number, y: number, line: Piece[], size: number, gray = INK): void {
  let cursor = x;
  let index = 0;
  while (index < line.length) {
    const font = line[index]!.font;
    let text = "";
    let width = 0;
    // A space joins whichever run it follows.
    while (index < line.length && (line[index]!.font === font || line[index]!.space)) {
      text += line[index]!.text;
      width += line[index]!.width;
      index++;
    }
    drawText(page, cursor, y, font, size, text.trimEnd(), gray);
    cursor += width;
  }
}

/** Lays blocks top to bottom onto portrait pages, breaking pages as it goes. */
class Layout {
  readonly pages: Page[] = [newPage()];
  /** Baseline-free cursor: the top of the next thing to place. */
  y = LETTER.height - MARGIN;
  private readonly bottom = MARGIN;

  get page(): Page {
    return this.pages[this.pages.length - 1]!;
  }

  get atTop(): boolean {
    return this.y >= LETTER.height - MARGIN;
  }

  newPage(): void {
    this.pages.push(newPage());
    this.y = LETTER.height - MARGIN;
  }

  /** Starts a new page unless `height` more points fit on this one. */
  ensure(height: number): void {
    if (this.y - height < this.bottom && !this.atTop) this.newPage();
  }

  space(points: number): void {
    if (!this.atTop) this.y -= points;
  }

  blocks(blocks: Block[], x: number, width: number, tight = false): void {
    blocks.forEach((block, index) => {
      if (index > 0) this.space(tight ? 3 : 7);
      this.block(block, x, width, tight);
    });
  }

  block(block: Block, x: number, width: number, tight: boolean): void {
    switch (block.kind) {
      case "heading":
        return this.heading(block.level, block.spans, x, width);
      case "paragraph":
        return this.paragraph(block.spans, x, width);
      case "list":
        return this.list(block, x, width, tight);
      case "quote":
        return this.quote(block.blocks, x, width);
      case "code":
        return this.code(block.text, x, width);
      case "table":
        return this.table(block.rows, x, width);
      case "rule":
        this.space(4);
        this.ensure(8);
        drawLine(this.page, x, this.y - 4, x + width, this.y - 4, 0.75, RULE);
        this.y -= 8;
        return;
    }
  }

  paragraph(spans: Span[], x: number, width: number, style: { italic?: boolean; gray?: number } = {}): void {
    for (const line of wrapSpans(spans, BODY_SIZE, width, style)) {
      this.ensure(BODY_LEADING);
      drawPieces(this.page, x, this.y - BODY_SIZE, line, BODY_SIZE, style.gray);
      this.y -= BODY_LEADING;
    }
  }

  heading(level: number, spans: Span[], x: number, width: number): void {
    const size = [20, 15, 12.5, 11, 10.5, 10.5][level - 1] ?? 10.5;
    const leading = size * 1.25;
    const before = [0, 14, 10, 8, 8, 8][level - 1] ?? 8;
    const lines = wrapSpans(spans, size, width, { bold: true });
    this.space(before);
    // Keep the heading with the first lines that follow it.
    this.ensure(lines.length * leading + (level <= 2 ? 6 : 3) + BODY_LEADING * 3);
    for (const line of lines) {
      drawPieces(this.page, x, this.y - size, line, size);
      this.y -= leading;
    }
    if (level <= 2) {
      this.y -= 2;
      drawLine(this.page, x, this.y, x + width, this.y, level === 1 ? 1.2 : 0.6, level === 1 ? INK : RULE);
      this.y -= 6;
    } else {
      this.y -= 3;
    }
  }

  list(list: Extract<Block, { kind: "list" }>, x: number, width: number, tight: boolean): void {
    const indent = list.ordered ? 22 : 16;
    list.items.forEach((item, index) => {
      if (index > 0) this.space(tight ? 2 : 3);
      this.ensure(BODY_LEADING);
      const markerY = this.y - BODY_SIZE;
      const page = this.page;
      if (item.checked !== undefined) {
        const box = 7.5;
        strokeRect(page, x + indent - 13, markerY - 0.5, box, box, 0.7);
        if (item.checked) {
          drawLine(page, x + indent - 11.5, markerY + 3, x + indent - 9.5, markerY + 1, 1, INK);
          drawLine(page, x + indent - 9.5, markerY + 1, x + indent - 6.5, markerY + 6, 1, INK);
        }
      } else if (list.ordered) {
        const marker = `${list.start + index}.`;
        drawText(page, x + indent - 5 - textWidth(marker, "regular", BODY_SIZE), markerY, "regular", BODY_SIZE, marker);
      } else {
        drawText(page, x + indent - 10, markerY, "regular", BODY_SIZE, "\x95");
      }
      this.blocks(item.blocks, x + indent, width - indent, true);
    });
  }

  quote(blocks: Block[], x: number, width: number): void {
    // Render first, then draw the bar down every page the quote touched.
    const firstPage = this.pages.length - 1;
    const top = this.y;
    this.blocksStyled(blocks, x + 14, width - 14);
    for (let index = firstPage; index < this.pages.length; index++) {
      const page = this.pages[index]!;
      const from = index === firstPage ? top : page.height - MARGIN;
      const to = index === this.pages.length - 1 ? this.y + 2 : MARGIN;
      if (from > to) drawLine(page, x + 3, from, x + 3, to, 2.5, RULE);
    }
  }

  /** Quote content: muted, otherwise ordinary blocks. */
  private blocksStyled(blocks: Block[], x: number, width: number): void {
    blocks.forEach((block, index) => {
      if (index > 0) this.space(5);
      if (block.kind === "paragraph") this.paragraph(block.spans, x, width, { italic: true, gray: 0.3 });
      else this.block(block, x, width, true);
    });
  }

  code(text: string, x: number, width: number): void {
    const pad = 6;
    const inner = width - 2 * pad;
    const lines = text.split("\n").map((line) => toWinAnsi(line));
    const longest = Math.max(1, ...lines.map((line) => line.length));
    // Shrink to keep diagrams intact; past the minimum, wrap.
    const size = Math.max(MIN_CODE_SIZE, Math.min(CODE_SIZE, inner / (longest * 0.6)));
    const leading = size * 1.25;
    const perLine = Math.max(1, Math.floor(inner / (size * 0.6)));
    const wrapped = lines.flatMap((line) => {
      if (line.length <= perLine) return [line];
      const parts: string[] = [];
      for (let i = 0; i < line.length; i += perLine) parts.push(line.slice(i, i + perLine));
      return parts;
    });

    // Keep short blocks (like a ## Map schematic) whole on one page.
    const whole = wrapped.length * leading + 2 * pad;
    if (whole <= LETTER.height - 2 * MARGIN) this.ensure(whole);

    let segmentTop = this.y;
    this.y -= pad;
    for (const line of wrapped) {
      if (this.y - leading < MARGIN + pad && !this.atTop) {
        fillRect(this.page, x, this.y - pad / 2, width, segmentTop - this.y + pad / 2, SHADE);
        this.newPage();
        segmentTop = this.y;
        this.y -= pad;
      }
      drawText(this.page, x + pad, this.y - size, "mono", size, line);
      this.y -= leading;
    }
    this.y -= pad;
    fillRect(this.page, x, this.y, width, segmentTop - this.y, SHADE);
  }

  table(rows: TableRow[], x: number, width: number): void {
    const columns = Math.max(0, ...rows.map((row) => row.cells.length));
    if (columns === 0) return;
    const pad = 4;
    const size = TABLE_SIZE;
    const leading = size * 1.3;

    // Natural (unwrapped) and minimum (longest word) widths per column.
    const natural = new Array<number>(columns).fill(0);
    const minimum = new Array<number>(columns).fill(0);
    for (const row of rows) {
      row.cells.forEach((cell, column) => {
        const base = { bold: row.header };
        let total = 0;
        for (const span of cell.spans) {
          const font = fontFor(span, base);
          const text = toWinAnsi(span.text);
          total += textWidth(text, font, size);
          for (const word of text.split(/ +/)) minimum[column] = Math.max(minimum[column]!, textWidth(word, font, size));
        }
        natural[column] = Math.max(natural[column]!, total);
      });
    }
    const content = width - columns * 2 * pad;
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
    let widths: number[];
    if (sum(natural) <= content) {
      widths = natural.map((value) => value + (content - sum(natural)) / columns);
    } else if (sum(minimum) >= content) {
      widths = minimum.map((value) => (value / sum(minimum)) * content);
    } else {
      const slack = content - sum(minimum);
      const want = sum(natural.map((value, i) => value - minimum[i]!));
      widths = minimum.map((value, i) => value + ((natural[i]! - value) / want) * slack);
    }
    widths = widths.map((value) => value + 2 * pad);

    const laid = rows.map((row) => {
      const cellLines = widths.map((cellWidth, column) => {
        const cell = row.cells[column];
        return cell ? wrapSpans(cell.spans, size, cellWidth - 2 * pad, { bold: row.header }) : [];
      });
      const height = Math.max(1, ...cellLines.map((lines) => lines.length)) * leading + 2 * pad - 2;
      return { row, cellLines, height };
    });
    const header = laid.filter((entry) => entry.row.header);

    const drawRow = (entry: (typeof laid)[number]) => {
      const page = this.page;
      const top = this.y;
      if (entry.row.header) fillRect(page, x, top - entry.height, width, entry.height, SHADE);
      let cellX = x;
      widths.forEach((cellWidth, column) => {
        const align = entry.row.cells[column]?.align ?? "left";
        entry.cellLines[column]!.forEach((line, index) => {
          const used = lineWidth(line);
          const inner = cellWidth - 2 * pad;
          const offset = align === "right" ? inner - used : align === "center" ? (inner - used) / 2 : 0;
          drawPieces(page, cellX + pad + offset, top - pad - size + 1 - index * leading, line, size);
        });
        cellX += cellWidth;
      });
      this.y -= entry.height;
      drawLine(page, x, this.y, x + width, this.y, entry.row.header ? 0.9 : 0.4, entry.row.header ? INK : RULE);
    };

    this.ensure((header[0]?.height ?? 0) + (laid.find((entry) => !entry.row.header)?.height ?? 0));
    drawLine(this.page, x, this.y, x + width, this.y, 0.9, INK);
    for (const entry of laid) {
      if (this.y - entry.height < MARGIN && !this.atTop) {
        this.newPage();
        // Repeat the header so a continued table still reads.
        if (!entry.row.header && header.length > 0) {
          drawLine(this.page, x, this.y, x + width, this.y, 0.9, INK);
          header.forEach(drawRow);
        } else {
          drawLine(this.page, x, this.y, x + width, this.y, 0.9, INK);
        }
      }
      drawRow(entry);
    }
  }
}

/**
 * The map's landscape page: Courier at whatever size fits every line and row,
 * centered. Generic converters reflow these lines; this never does.
 */
function mapPage(map: string): Page {
  const page = newPage(LETTER.height, LETTER.width);
  const lines = map.split("\n").map((line) => toWinAnsi(line));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const margin = 36;
  const columns = Math.max(1, ...lines.map((line) => line.length));
  const leadingRatio = 1.15;
  const size = Math.min(
    14,
    (page.width - 2 * margin) / (columns * 0.6),
    (page.height - 2 * margin) / (Math.max(1, lines.length) * leadingRatio),
  );
  const leading = size * leadingRatio;
  const left = (page.width - columns * size * 0.6) / 2;
  let y = (page.height + lines.length * leading) / 2 - size;
  for (const line of lines) {
    drawText(page, left, y, "mono", size, line);
    y -= leading;
  }
  return page;
}

// ---------------------------------------------------------------------------
// Document

export interface PlanPdfInput {
  /** The plan's title: the heading when the body has no `# ` of its own, and the footer. */
  title: string;
  /** Markdown body, frontmatter already removed. */
  body: string;
  /** A rendered map page (`renderMap` output), printed on its own landscape page. */
  map?: string;
  /** A short line under the generated title, e.g. the game system. */
  subtitle?: string;
}

export interface PlanPdf {
  bytes: Uint8Array;
  pages: number;
}

/** Marks a PDF as Scribe's, so the store only ever replaces its own printouts. */
export const PDF_CREATOR_MARKER = "/Creator (Scribe)";

export function renderPlanPdf(input: PlanPdfInput): PlanPdf {
  const layout = new Layout();
  const width = LETTER.width - 2 * MARGIN;
  const blocks = parseMarkdown(input.body);
  if (blocks[0]?.kind !== "heading" || blocks[0].level !== 1) {
    layout.heading(1, [{ text: input.title, bold: true, italic: false, code: false }], MARGIN, width);
    if (input.subtitle) {
      layout.paragraph([{ text: input.subtitle, bold: false, italic: false, code: false }], MARGIN, width, {
        gray: MUTED,
      });
    }
    layout.space(6);
  }
  layout.blocks(blocks, MARGIN, width);

  const pages = [...layout.pages];
  if (input.map && input.map.trim() !== "") pages.push(mapPage(input.map));

  const footerTitle = toWinAnsi(input.title);
  pages.forEach((page, index) => {
    const label = `${footerTitle}  \x95  Page ${index + 1} of ${pages.length}`;
    const size = 8;
    const y = page.width > page.height ? 16 : FOOTER_Y;
    drawText(page, (page.width - textWidth(label, "regular", size)) / 2, y, "regular", size, label, MUTED);
  });
  return { bytes: serialize(pages, input.title), pages: pages.length };
}

/** Writes pages as a PDF 1.4 file. Everything is 7-bit, so offsets are char counts. */
function serialize(pages: Page[], title: string): Uint8Array {
  const fontIds = Object.keys(FONTS) as FontId[];
  // 1 catalog, 2 pages, 3 info, then fonts, then a page + contents pair each.
  const fontBase = 4;
  const pageBase = fontBase + fontIds.length;
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const kids = pages.map((_, index) => `${pageBase + index * 2} 0 R`).join(" ");
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objects[3] = `<< /Title ${pdfUnicodeString(title)} ${PDF_CREATOR_MARKER} /Producer (Scribe) >>`;
  const fontResources = fontIds
    .map((id, index) => {
      objects[fontBase + index] =
        `<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS[id].baseFont} /Encoding /WinAnsiEncoding >>`;
      return `/${FONTS[id].resource} ${fontBase + index} 0 R`;
    })
    .join(" ");
  pages.forEach((page, index) => {
    const pageObject = pageBase + index * 2;
    const content = [...page.under, ...page.over].join("\n");
    objects[pageObject] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
      `/Resources << /Font << ${fontResources} >> >> /Contents ${pageObject + 1} 0 R >>`;
    objects[pageObject + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
