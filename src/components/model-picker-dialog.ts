/**
 * Filterable, keyboard-navigable dialog for picking a model id from a list
 * fetched via `listModelInfos()`. Built on the raw `makeDialog` primitive
 * rather than `makeActionDialog` because the button row there is static —
 * this list is rebuilt on every keystroke, so selection is tracked by index
 * (like `autocomplete.ts`'s popup) instead of a focus chain of buttons.
 */
import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { makeDialog } from "./dialog.ts";
import { theme } from "../theme.ts";
import { formatTokenCount } from "../format.ts";
import type { ModelInfo } from "../provider/types.ts";

export interface ModelPickerDialogOptions {
  models: ModelInfo[];
  onPick: (model: string) => void;
  onClose?: () => void;
}

const LIST_HEIGHT = 10;

/** "Deepseek V4 Flash · 128k ctx", falling back to whatever fields are known. */
function describe(model: ModelInfo): string {
  const parts: string[] = [];
  if (model.name && model.name !== model.id) parts.push(model.name);
  if (model.contextLength) parts.push(`${formatTokenCount(model.contextLength)} ctx`);
  return parts.join(" · ");
}

export function showModelPickerDialog(renderer: CliRenderer, options: ModelPickerDialogOptions): void {
  const dialog = makeDialog(renderer, { width: 64 });
  renderer.root.add(dialog.layer);

  dialog.content.add(new TextRenderable(renderer, { content: "Select a model", fg: theme.accent, marginBottom: 1 }));

  const filterInput = new InputRenderable(renderer, {
    value: "",
    placeholder: "Filter...",
    width: "100%",
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    marginBottom: 1,
  });
  dialog.content.add(filterInput);

  const listBox = new ScrollBoxRenderable(renderer, { width: "100%", height: LIST_HEIGHT, scrollY: true });
  const listColumn = new BoxRenderable(renderer, { width: "100%", flexDirection: "column" });
  listBox.content.add(listColumn);
  dialog.content.add(listBox);

  const emptyText = new TextRenderable(renderer, { content: "No matching models", fg: theme.textMuted });
  dialog.content.add(emptyText);

  dialog.content.add(
    new TextRenderable(renderer, {
      content: "↑↓ select · Enter pick · Esc cancel",
      fg: theme.textMuted,
      marginTop: 1,
    }),
  );

  let filtered: ModelInfo[] = options.models;
  let selected = 0;
  const rows: { node: BoxRenderable; label: TextRenderable; description: TextRenderable }[] = [];

  function paint(): void {
    while (rows.length < filtered.length) {
      const node = new BoxRenderable(renderer, { width: "100%", flexDirection: "row", padding: 1 });
      const label = new TextRenderable(renderer, { content: "" });
      const description = new TextRenderable(renderer, { content: "" });
      node.add(label);
      node.add(description);
      listColumn.add(node);
      rows.push({ node, label, description });
    }

    for (const [i, row] of rows.entries()) {
      const model = filtered[i];
      if (!model) {
        row.node.visible = false;
        continue;
      }
      row.node.visible = true;
      const active = i === selected;
      row.node.backgroundColor = active ? theme.accent : theme.surfaceRaised;
      const desc = describe(model);
      row.label.content = desc ? `${model.id}  ` : model.id;
      row.label.fg = active ? theme.text : theme.textDim;
      row.description.content = desc;
      row.description.fg = active ? theme.text : theme.textMuted;
    }

    listBox.visible = filtered.length > 0;
    emptyText.visible = filtered.length === 0;
    const activeRow = rows[selected];
    if (activeRow) listBox.scrollChildIntoView(activeRow.node.id);
  }

  function applyFilter(): void {
    const query = filterInput.value.trim().toLowerCase();
    filtered =
      query === ""
        ? options.models
        : options.models.filter(
            (model) => model.id.toLowerCase().includes(query) || (model.name ?? "").toLowerCase().includes(query),
          );
    selected = 0;
    paint();
  }

  filterInput.onContentChange = applyFilter;

  function move(delta: number): void {
    if (filtered.length === 0) return;
    selected = (selected + delta + filtered.length) % filtered.length;
    paint();
  }

  function pick(): void {
    const model = filtered[selected];
    if (!model) return;
    close();
    options.onPick(model.id);
  }

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    renderer.keyInput.off("keypress", onKeypress);
    renderer.root.remove(dialog.layer);
    dialog.layer.destroyRecursively();
    options.onClose?.();
  }

  const onKeypress = (key: KeyEvent): void => {
    switch (key.name) {
      case "escape":
        key.preventDefault();
        close();
        return;
      case "up":
        key.preventDefault();
        move(-1);
        return;
      case "down":
        key.preventDefault();
        move(1);
        return;
      case "return":
      case "kpenter":
        key.preventDefault();
        pick();
        return;
      default:
        return;
    }
  };

  renderer.keyInput.on("keypress", onKeypress);
  dialog.open();
  applyFilter();
  filterInput.focus();
}
