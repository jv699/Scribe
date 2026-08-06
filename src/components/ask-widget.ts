/**
 * The `ask_user` question widget: the interactive panel that takes the chat
 * box's place while the agent waits on a decision.
 *
 * It borrows the prompt's accent-strip panel deliberately — from the user's
 * side the bottom of the screen is still "where I answer", it has just changed
 * shape. Options are a hand-rolled list rather than a `SelectRenderable`
 * because neither multi-select markers nor a "type your own" row that becomes a
 * textarea fit that renderable's model.
 *
 * Keys are pushed in by the owner via `handleKey` rather than pulled from a
 * listener of our own, so the chat screen keeps a single keypress handler and
 * stays in charge of what Escape means. `handleKey` returns whether it consumed
 * the key; while the custom answer is being typed it consumes almost nothing,
 * letting the focused textarea receive ordinary input.
 */
import {
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { makeAccentPanel } from "./ui.ts";
import type { AskAnswer, AskQuestion } from "../agent/ask.ts";

export interface AskWidgetOptions {
  question: AskQuestion;
  /** The user answered. */
  onSubmit: (answer: AskAnswer) => void;
  /** The user dismissed the question (Escape). */
  onCancel: () => void;
}

export interface AskWidget {
  /** Add this where the prompt box was. */
  node: BoxRenderable;
  /** Called when the widget takes over, so typing lands somewhere sensible. */
  focus(): void;
  /** Feed a key in. Returns true when the widget consumed it. */
  handleKey(key: KeyEvent): boolean;
}

const CUSTOM_LABEL = "Type your own answer…";

interface Row {
  node: BoxRenderable;
  marker: TextRenderable;
  label: TextRenderable;
  description: TextRenderable | null;
  /** The custom-answer row, whose value is whatever the user typed. */
  custom: boolean;
  /**
   * The answer this row contributes. Held here rather than read back off the
   * label renderable, whose `content` is `StyledText`, not the string we set.
   */
  value: string;
}

export function makeAskWidget(ctx: RenderContext, options: AskWidgetOptions): AskWidget {
  const { question } = options;
  const multiple = question.multiple === true;
  // A question with no options would otherwise render an empty, unanswerable
  // panel; the custom row guarantees there is always a way out.
  const custom = question.custom !== false || question.options.length === 0;

  const { node, panel } = makeAccentPanel(ctx);

  if (question.header && question.header.trim() !== "") {
    panel.add(
      new TextRenderable(ctx, {
        content: question.header.trim().toUpperCase(),
        fg: theme.accent,
      }),
    );
  }

  panel.add(new TextRenderable(ctx, { content: question.question, fg: theme.text }));

  const list = new BoxRenderable(ctx, {
    width: "100%",
    flexDirection: "column",
    marginTop: 1,
  });
  panel.add(list);

  // --- state ---

  let selected = 0;
  let editing = false;
  /** Chosen labels in multi-select mode. */
  const chosen = new Set<string>();
  /** The user's typed answer, once submitted from the editor. */
  let customValue = "";

  const rows: Row[] = [];
  const labels = [...question.options.map((o) => o.label), ...(custom ? [CUSTOM_LABEL] : [])];
  const lastIndex = labels.length - 1;
  const customIndex = custom ? lastIndex : -1;

  for (const [index, label] of labels.entries()) {
    const isCustom = index === customIndex;
    const description = isCustom ? undefined : question.options[index]?.description;

    const rowNode = new BoxRenderable(ctx, {
      width: "100%",
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: theme.surfaceActive,
    });
    const marker = new TextRenderable(ctx, { content: "", fg: theme.textMuted, marginRight: 1 });
    const labelText = new TextRenderable(ctx, { content: label, fg: theme.textDim });
    rowNode.add(marker);
    rowNode.add(labelText);

    let descriptionText: TextRenderable | null = null;
    if (description && description.trim() !== "") {
      descriptionText = new TextRenderable(ctx, {
        content: `  ${description.trim()}`,
        fg: theme.textMuted,
      });
      rowNode.add(descriptionText);
    }

    rowNode.onMouseOver = () => {
      if (editing) return;
      selected = index;
      paint();
    };
    rowNode.onMouseDown = () => {
      if (editing) return;
      selected = index;
      activate();
    };

    list.add(rowNode);
    rows.push({
      node: rowNode,
      marker,
      label: labelText,
      description: descriptionText,
      custom: isCustom,
      value: isCustom ? "" : label,
    });
  }

  /** The answer a row currently stands for; empty means "not answerable yet". */
  const valueOf = (row: Row): string => (row.custom ? customValue : row.value);

  // The custom-answer editor, revealed only while typing.
  const editor = new TextareaRenderable(ctx, {
    placeholder: "Your answer…",
    placeholderColor: theme.textMuted,
    width: "100%",
    minHeight: 1,
    maxHeight: 4,
    marginTop: 1,
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceRaised,
    textColor: theme.text,
    focusedTextColor: theme.text,
    cursorColor: theme.accent,
    visible: false,
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "return", shift: true, action: "newline" },
      { name: "kpenter", action: "submit" },
    ],
    onSubmit: () => commitCustom(),
  });
  panel.add(editor);

  const hint = new TextRenderable(ctx, { content: "", fg: theme.textMuted, marginTop: 1 });
  panel.add(hint);

  // --- painting ---

  function hintText(): string {
    if (editing) return "Enter to answer · Esc to go back";
    if (multiple) return "↑↓ move · Space to toggle · Enter to confirm · Esc to skip";
    return "↑↓ move · 1-9 to pick · Enter to choose · Esc to skip";
  }

  /** Marker column: a checkbox in multi-select, otherwise the digit shortcut. */
  function markerFor(row: Row, index: number): string {
    if (multiple) return isChosen(row) ? "[x]" : "[ ]";
    return index < 9 ? `${index + 1}.` : " ·";
  }

  function isChosen(row: Row): boolean {
    const value = valueOf(row);
    return value !== "" && chosen.has(value);
  }

  function paint(): void {
    for (const [index, row] of rows.entries()) {
      const active = index === selected && !editing;
      row.node.backgroundColor = active ? theme.accent : theme.surfaceActive;
      row.marker.content = markerFor(row, index);
      row.marker.fg = active ? theme.text : theme.textMuted;
      row.label.fg = active ? theme.text : theme.textDim;
      if (row.description) row.description.fg = active ? theme.text : theme.textMuted;
      // Once typed, the custom row shows the answer instead of the invitation.
      if (row.custom) {
        row.label.content = customValue !== "" ? customValue : CUSTOM_LABEL;
      }
    }
    hint.content = hintText();
  }

  // --- actions ---

  function move(delta: number): void {
    if (rows.length === 0) return;
    selected = (selected + delta + rows.length) % rows.length;
    paint();
  }

  function startEditing(): void {
    editing = true;
    editor.visible = true;
    paint();
    editor.focus();
  }

  function stopEditing(): void {
    editing = false;
    editor.visible = false;
    editor.blur();
    paint();
  }

  /** Enter pressed in the custom-answer editor. */
  function commitCustom(): void {
    const value = editor.plainText.trim();
    if (value === "") {
      // Nothing typed — treat Enter as "never mind" rather than answering blank.
      stopEditing();
      return;
    }
    if (multiple) {
      // Replace any previous typed answer; the row holds one value.
      if (customValue !== "") chosen.delete(customValue);
      customValue = value;
      chosen.add(value);
      stopEditing();
      return;
    }
    customValue = value;
    stopEditing();
    options.onSubmit({ question: question.question, answers: [value] });
  }

  /** Enter / click / digit on the selected row. */
  function activate(): void {
    const row = rows[selected];
    if (!row) return;
    if (row.custom && (!multiple || customValue === "")) {
      startEditing();
      return;
    }
    if (multiple) {
      toggle(row);
      return;
    }
    options.onSubmit({ question: question.question, answers: [row.value] });
  }

  function toggle(row: Row): void {
    const value = valueOf(row);
    if (value === "") {
      startEditing();
      return;
    }
    if (chosen.has(value)) chosen.delete(value);
    else chosen.add(value);
    paint();
  }

  function confirmMultiple(): void {
    // Confirming nothing would send the model an empty answer that reads like a
    // bug; make Enter a no-op and say so instead.
    if (chosen.size === 0) {
      hint.content = "Pick at least one option with Space, or press Esc to skip";
      return;
    }
    // Emit in the order the options are presented, not the order they were
    // clicked, so the result reads predictably.
    const ordered = rows.map(valueOf).filter((value) => value !== "" && chosen.has(value));
    options.onSubmit({ question: question.question, answers: ordered });
  }

  paint();

  return {
    node,
    focus: () => {
      // In list mode nothing needs focus — keys arrive via handleKey. Focus is
      // only meaningful once the editor is open, which happens if the question
      // has no options at all to choose from.
      if (rows.length === 1 && rows[0]?.custom) startEditing();
    },

    handleKey: (key) => {
      if (editing) {
        // Let the textarea own everything except backing out; Enter is handled
        // by its own submit binding.
        if (key.name === "escape") {
          key.preventDefault();
          stopEditing();
          return true;
        }
        return false;
      }

      switch (key.name) {
        case "escape":
          key.preventDefault();
          options.onCancel();
          return true;
        case "up":
          key.preventDefault();
          move(-1);
          return true;
        case "down":
          key.preventDefault();
          move(1);
          return true;
        case "return":
        case "kpenter":
          key.preventDefault();
          if (!multiple) {
            activate();
            return true;
          }
          // In multi-select Enter normally confirms the whole selection, but on
          // an as-yet-unfilled "type your own" row that would silently discard
          // the row the user is standing on. Open the editor instead.
          if (rows[selected]?.custom && customValue === "") startEditing();
          else confirmMultiple();
          return true;
        case "space":
          if (!multiple) return false;
          key.preventDefault();
          {
            const row = rows[selected];
            if (row) toggle(row);
          }
          return true;
        default:
          break;
      }

      // Digit shortcuts: jump to a row, and act on it in single-select.
      const digit = /^[1-9]$/.test(key.name ?? "") ? Number(key.name) : 0;
      if (digit > 0 && digit <= rows.length) {
        key.preventDefault();
        selected = digit - 1;
        paint();
        if (multiple) {
          const row = rows[selected];
          if (row) toggle(row);
        } else {
          activate();
        }
        return true;
      }

      return false;
    },
  };
}
