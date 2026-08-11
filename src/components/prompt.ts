/**
 * Prompt widget (opencode-style): an accent-bordered panel holding a multi-line
 * textarea (Enter sends, Shift+Enter adds a line) and a hint footer. Self-
 * contained like the dialog widgets; the caller owns submission and
 * textarea state.
 */
import { BoxRenderable, TextRenderable, TextareaRenderable, type RenderContext } from "@opentui/core";
import { theme } from "../theme.ts";
import { makeAccentPanel } from "./ui.ts";

export interface PromptOptions {
  /** Shown in the textarea while it is empty. Defaults to "Type a message…". */
  placeholder?: string;
  /** Footer hint text. Defaults to the send/newline/exit hint. */
  hint?: string;
  /** Called when the user submits (Enter). */
  onSubmit: () => void;
}

export interface Prompt {
  /** Add this to a column layout. Sizes to content and never shrinks. */
  node: BoxRenderable;
  /** The textarea, so the caller can read, clear, and focus it. */
  input: TextareaRenderable;
}

/**
 * A bordered prompt panel with a growing textarea and a hint footer, built on
 * `makeAccentPanel`. Its outer box never shrinks so a flex-grow sibling (e.g.
 * a transcript scrollbox) can't squeeze the footer out.
 */
export function makePrompt(ctx: RenderContext, options: PromptOptions): Prompt {
  const { node: promptBox, panel } = makeAccentPanel(ctx);

  const input = new TextareaRenderable(ctx, {
    placeholder: options.placeholder ?? "Type a message…",
    placeholderColor: theme.textMuted,
    width: "100%",
    minHeight: 1,
    maxHeight: 6,
    backgroundColor: theme.surfaceActive,
    focusedBackgroundColor: theme.surfaceActive,
    textColor: theme.text,
    focusedTextColor: theme.text,
    cursorColor: theme.accent,
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "return", shift: true, action: "newline" },
      { name: "kpenter", action: "submit" },
    ],
    onSubmit: options.onSubmit,
  });
  panel.add(input);

  const footer = new BoxRenderable(ctx, {
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 1,
  });
  footer.add(
    new TextRenderable(ctx, {
      content: options.hint ?? "Enter to send · Shift+Enter for a new line · Esc to exit",
      fg: theme.textMuted,
    }),
  );
  panel.add(footer);

  return { node: promptBox, input };
}
