import { BoxRenderable, RenderableEvents, TextRenderable, TextareaRenderable, type RenderContext } from "@opentui/core";
import { theme } from "../theme.ts";
import { makeAccentPanel, TEXT_FIELD_KEYS } from "./ui.ts";

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
  const initialHint = options.hint ?? "Enter to send · Shift+Enter for a new line · Esc twice to go back";

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
      ...TEXT_FIELD_KEYS,
      { name: "return", action: "submit" },
      { name: "return", shift: true, action: "newline" },
      { name: "kpenter", action: "submit" },
    ],
    onSubmit: options.onSubmit,
  });
  panel.add(input);

  // The accent strip marks where typing goes; it dims while focus is elsewhere
  // (a sidebar, a dialog), so the two never both look active.
  const setStrip = (focused: boolean): void => {
    if (!promptBox.isDestroyed) promptBox.borderColor = focused ? theme.accent : theme.textMuted;
  };
  input.on(RenderableEvents.FOCUSED, () => setStrip(true));
  input.on(RenderableEvents.BLURRED, () => setStrip(false));
  setStrip(false);

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
