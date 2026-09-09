/**
 * Options are hand-rolled because `SelectRenderable` cannot support both
 * multi-select markers and an editable custom-answer row. The owner pushes
 * keys through `handleKey` so it retains control of Escape.
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
  onSubmit: (answer: AskAnswer) => void;
  onCancel: () => void;
}

export interface AskWidget {
  node: BoxRenderable;
  focus(): void;
  /** Returns whether the key was consumed. */
  handleKey(key: KeyEvent): boolean;
}

const CUSTOM_LABEL = "Type your own answer…";

interface Row {
  node: BoxRenderable;
  marker: TextRenderable;
  label: TextRenderable;
  description: TextRenderable | null;
  custom: boolean;
  /** Keep the answer string; the label's content getter returns StyledText. */
  value: string;
}

export function makeAskWidget(ctx: RenderContext, options: AskWidgetOptions): AskWidget {
  const { question } = options;
  const multiple = question.multiple === true;
  // Allow a custom answer when no options exist.
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

  let selected = 0;
  let editing = false;
  const chosen = new Set<string>();
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

  const valueOf = (row: Row): string => (row.custom ? customValue : row.value);

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

  function hintText(): string {
    if (editing) return "Enter to answer · Esc to go back";
    if (multiple) return "↑↓ move · Space to toggle · Enter to confirm · Esc to skip";
    return "↑↓ move · 1-9 to pick · Enter to choose · Esc to skip";
  }

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
      if (row.custom) {
        row.label.content = customValue !== "" ? customValue : CUSTOM_LABEL;
      }
    }
    hint.content = hintText();
  }

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

  function commitCustom(): void {
    const value = editor.plainText.trim();
    if (value === "") {
      stopEditing();
      return;
    }
    if (multiple) {
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
    if (chosen.size === 0) {
      hint.content = "Pick at least one option with Space, or press Esc to skip";
      return;
    }
    // Keep answers in display order rather than click order.
    const ordered = rows.map(valueOf).filter((value) => value !== "" && chosen.has(value));
    options.onSubmit({ question: question.question, answers: ordered });
  }

  paint();

  return {
    node,
    focus: () => {
      // An embedding owner can call focus again while the editor is open.
      if (editing) {
        editor.focus();
        return;
      }
      // List keys arrive through handleKey; only the editor needs focus.
      if (rows.length === 1 && rows[0]?.custom) startEditing();
    },

    handleKey: (key) => {
      if (editing) {
        // The textarea owns typing and Enter; the widget owns Escape.
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
          // Enter on an empty custom row should edit it, not discard it.
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
