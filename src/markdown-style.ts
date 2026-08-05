/**
 * Chat transcript markdown styling: a SyntaxStyle mapping the scopes emitted
 * by opentui's built-in tree-sitter markdown queries (markup.heading.N,
 * markup.strong, markup.italic, markup.raw, markup.quote, markup.list, …) onto
 * Scribe's palette — burnt-orange accents over flat dark surfaces. All colors
 * come from `theme`; no ad-hoc literals.
 */
import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core";
import { theme } from "./theme.ts";

export function createMarkdownSyntaxStyle(): SyntaxStyle {
  const rules: ThemeTokenStyle[] = [
    // Plain text.
    { scope: ["default", "spell", "nospell"], style: { foreground: theme.text } },

    // Headings — accent, bold; H1 additionally underlined for hierarchy.
    { scope: ["markup.heading.1"], style: { foreground: theme.accent, bold: true, underline: true } },
    { scope: ["markup.heading.2", "markup.heading.3", "markup.heading.4", "markup.heading.5", "markup.heading.6", "markup.heading"], style: { foreground: theme.accent, bold: true } },

    // Inline emphasis — bold is white, italic stays subtle.
    { scope: ["markup.strong"], style: { foreground: theme.text, bold: true } },
    { scope: ["markup.italic"], style: { foreground: theme.textDim, italic: true } },
    { scope: ["markup.strikethrough"], style: { foreground: theme.textMuted, dim: true } },

    // Code.
    { scope: ["markup.raw"], style: { foreground: theme.flameCore, background: theme.surfaceRaised } },
    { scope: ["markup.raw.block"], style: { foreground: theme.text } },
    { scope: ["label"], style: { foreground: theme.textMuted, italic: true } },

    // Lists.
    { scope: ["markup.list", "markup.list.checked"], style: { foreground: theme.accent } },
    { scope: ["markup.list.unchecked"], style: { foreground: theme.textMuted } },

    // Blockquotes.
    { scope: ["markup.quote"], style: { foreground: theme.textDim, italic: true } },

    // Links.
    { scope: ["markup.link.label"], style: { foreground: theme.accentHover, underline: true } },
    { scope: ["markup.link.url"], style: { foreground: theme.textMuted, underline: true } },
    { scope: ["markup.link", "markup.link.bracket.close"], style: { foreground: theme.textMuted } },

    // Syntax markers, table pipes, thematic breaks, frontmatter, escapes.
    { scope: ["punctuation.special"], style: { foreground: theme.textMuted } },
    { scope: ["character.special", "string.escape"], style: { foreground: theme.flameCore } },
    { scope: ["keyword.directive"], style: { foreground: theme.accent, italic: true } },

    // Concealed markers; its color also drives blockquote bars and table borders.
    { scope: ["conceal"], style: { foreground: theme.flameEmber } },

    // Generic code scopes for fenced blocks (opentui highlights JS/TS natively).
    { scope: ["comment"], style: { foreground: theme.textMuted, italic: true } },
    { scope: ["string"], style: { foreground: theme.flameCore } },
    { scope: ["keyword"], style: { foreground: theme.accent } },
    { scope: ["number", "constant", "function", "constructor"], style: { foreground: theme.accentHover } },
    { scope: ["type", "module", "class"], style: { foreground: theme.flameCore } },
    { scope: ["variable", "property", "field", "parameter"], style: { foreground: theme.text } },
    { scope: ["operator"], style: { foreground: theme.flameCore } },
    { scope: ["punctuation", "punctuation.bracket"], style: { foreground: theme.textMuted } },
  ];

  return SyntaxStyle.fromTheme(rules);
}
