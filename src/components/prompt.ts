import { BoxRenderable, TextRenderable, TextareaRenderable, type RenderContext } from "@opentui/core";
import { theme } from "../theme.ts";
import { makeAccentPanel } from "./ui.ts";

export interface PromptOptions {
  placeholder?: string;
  hint?: string;
  onSubmit: () => void;
}

export interface Prompt {
  node: BoxRenderable;
  input: TextareaRenderable;
  /** Omitting `hint` restores the initial value. */
  setHint(hint?: string): void;
}

export function makePrompt(ctx: RenderContext, options: PromptOptions): Prompt {
  const { node: promptBox, panel } = makeAccentPanel(ctx);
  const initialHint = options.hint ?? "Enter to send · Shift+Enter for a new line · Esc to exit";

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
  const hintText = new TextRenderable(ctx, {
    content: initialHint,
    fg: theme.textMuted,
  });
  footer.add(hintText);
  panel.add(footer);

  return {
    node: promptBox,
    input,
    setHint: (hint) => {
      hintText.content = hint ?? initialHint;
    },
  };
}
