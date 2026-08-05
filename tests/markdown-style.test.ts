import { describe, expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createMarkdownSyntaxStyle } from "../src/markdown-style.ts";
import { theme } from "../src/theme.ts";

function style(name: string) {
  const s = createMarkdownSyntaxStyle();
  const def = s.getStyle(name);
  s.destroy();
  return def;
}

describe("markdown syntax style", () => {
  test("registers key markdown scopes", () => {
    for (const name of ["markup.heading.1", "markup.heading.2", "markup.strong", "markup.italic", "markup.raw", "markup.raw.block", "markup.quote", "markup.list", "markup.link.label", "markup.link.url", "conceal"]) {
      expect(style(name), `missing style for ${name}`).toBeDefined();
    }
  });

  test("bold is white and bold", () => {
    const strong = style("markup.strong")!;
    expect(strong.fg?.equals(RGBA.fromHex(theme.text))).toBe(true);
    expect(strong.bold).toBe(true);
  });

  test("headings are accent and bold, H1 underlined", () => {
    const h1 = style("markup.heading.1")!;
    expect(h1.fg?.equals(RGBA.fromHex(theme.accent))).toBe(true);
    expect(h1.bold).toBe(true);
    expect(h1.underline).toBe(true);

    const h3 = style("markup.heading.3")!;
    expect(h3.fg?.equals(RGBA.fromHex(theme.accent))).toBe(true);
    expect(h3.bold).toBe(true);
    expect(h3.underline).toBeFalsy();
  });

  test("inline code gets a flame foreground and raised background", () => {
    const raw = style("markup.raw")!;
    expect(raw.fg?.equals(RGBA.fromHex(theme.flameCore))).toBe(true);
    expect(raw.bg?.equals(RGBA.fromHex(theme.surfaceRaised))).toBe(true);
  });

  test("plain text stays on the app text color", () => {
    const spell = style("spell")!;
    expect(spell.fg?.equals(RGBA.fromHex(theme.text))).toBe(true);
  });

  test("conceal is a dark ember (drives blockquote bars / table borders)", () => {
    const conceal = style("conceal")!;
    expect(conceal.fg?.equals(RGBA.fromHex(theme.flameEmber))).toBe(true);
  });
});
