import {
  BoxRenderable,
  InputRenderable,
  RenderableEvents,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { TEXT_FIELD_KEYS } from "./ui.ts";

export interface ComboboxItem {
  /** Written into the field when the row is picked. */
  value: string;
  /** Shown in the row; defaults to `value`. */
  label?: string;
  description?: string;
  /** Extra text the filter matches besides the label and value. */
  keywords?: string;
}

export interface ComboboxOptions {
  value?: string;
  placeholder?: string;
  /** Called on first use and after `invalidate()`; the result is cached. */
  loadItems: () => ComboboxItem[] | Promise<ComboboxItem[]>;
  /** One-line dropdown states. An omitted state closes the dropdown instead. */
  messages?: { loading?: string; empty?: string; noMatch?: string };
  /** The field's text changed, by typing or by picking a row. */
  onChange?: () => void;
  /** A dropdown row was picked, after its value is in the field. */
  onPick?: () => void;
  onError?: (message: string) => void;
  maxRows?: number;
}

export interface Combobox {
  node: BoxRenderable;
  input: InputRenderable;
  readonly visible: boolean;
  handleKey(key: KeyEvent): boolean;
  close(): void;
  invalidate(): void;
  dispose(): void;
}

interface Row {
  node: BoxRenderable;
  label: TextRenderable;
  description: TextRenderable;
}

// The dropdown extends beyond its one-row anchor. Raising the anchor's stacking
// context keeps later fields from painting over it, and an open dropdown goes
// above a closed sibling combobox.
const Z_CLOSED = 100;
const Z_OPEN = 101;

const labelOf = (item: ComboboxItem): string => item.label ?? item.value;

/** Lower sorts first: label prefix, then label substring, then any other match. */
function matchRank(item: ComboboxItem, query: string): number | null {
  const label = labelOf(item).toLowerCase();
  if (label.startsWith(query)) return 0;
  if (label.includes(query)) return 1;
  if (item.value.toLowerCase().includes(query) || (item.keywords ?? "").toLowerCase().includes(query)) return 2;
  return null;
}

/** A free-form input with an inline dropdown of suggestions filtered by its whole value. */
export function makeCombobox(ctx: RenderContext, options: ComboboxOptions): Combobox {
  const maxRows = Math.max(1, options.maxRows ?? 8);
  const node = new BoxRenderable(ctx, {
    width: "100%",
    height: 1,
    marginBottom: 1,
    zIndex: Z_CLOSED,
  });
  const input = new InputRenderable(ctx, {
    value: options.value ?? "",
    placeholder: options.placeholder ?? "",
    width: "100%",
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    keyBindings: TEXT_FIELD_KEYS,
    placeholderColor: theme.textMuted,
  });
  node.add(input);

  const popup = new BoxRenderable(ctx, {
    position: "absolute",
    top: "100%",
    left: 0,
    width: "100%",
    zIndex: Z_CLOSED,
    flexDirection: "column",
    backgroundColor: theme.surfaceRaised,
    border: ["left"],
    borderColor: theme.accent,
    visible: false,
  });
  node.add(popup);

  const message = new TextRenderable(ctx, {
    content: "",
    fg: theme.textMuted,
    paddingLeft: 1,
    paddingRight: 1,
  });
  popup.add(message);

  const rows: Row[] = [];
  for (let i = 0; i < maxRows; i++) {
    const rowNode = new BoxRenderable(ctx, {
      width: "100%",
      // One line each: a wrapped row would push the last ones out of the popup.
      height: 1,
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: theme.surfaceRaised,
    });
    const label = new TextRenderable(ctx, { content: "", fg: theme.textDim, flexShrink: 0 });
    const description = new TextRenderable(ctx, {
      content: "",
      fg: theme.textMuted,
      flexShrink: 1,
      wrapMode: "none",
      truncate: true,
    });
    rowNode.add(label);
    rowNode.add(description);
    popup.add(rowNode);
    rows.push({ node: rowNode, label, description });
  }

  let items: ComboboxItem[] | null = null;
  let filtered: ComboboxItem[] = [];
  let selected = 0;
  let offset = 0;
  let open = false;
  let loading = false;
  let retryAfter = 0;
  let generation = 0;
  let substituting = false;
  let disposed = false;

  function show(): void {
    open = true;
    popup.visible = true;
    node.zIndex = Z_OPEN;
  }

  function paintRows(): void {
    message.visible = false;
    const shown = Math.min(maxRows, filtered.length);
    popup.height = shown;

    if (selected < offset) offset = selected;
    else if (selected >= offset + maxRows) offset = selected - maxRows + 1;

    const labelWidth = filtered.reduce((width, item) => Math.max(width, labelOf(item).length), 0);
    for (const [i, row] of rows.entries()) {
      const item = i < shown ? filtered[offset + i] : undefined;
      if (!item) {
        row.node.visible = false;
        continue;
      }
      const active = offset + i === selected;
      const detail = item.description ?? "";
      row.node.visible = true;
      row.node.backgroundColor = active ? theme.accent : theme.surfaceRaised;
      row.label.content = detail ? labelOf(item).padEnd(labelWidth) : labelOf(item);
      row.label.fg = active ? theme.text : theme.textDim;
      row.description.content = detail ? `  ${detail}` : "";
      row.description.fg = active ? theme.text : theme.textMuted;
    }
  }

  function showMessage(text: string | undefined): void {
    if (text === undefined) {
      hide();
      return;
    }
    filtered = [];
    selected = 0;
    offset = 0;
    message.content = text;
    message.visible = true;
    for (const row of rows) row.node.visible = false;
    popup.height = 1;
    show();
  }

  /** `browse` lists everything, starting on the row the field already holds. */
  function applyFilter(browse: boolean): void {
    if (!items || disposed || !input.focused) return;
    const value = input.value.trim();
    const query = browse ? "" : value.toLowerCase();
    if (query === "") {
      filtered = items;
    } else {
      const ranked: { item: ComboboxItem; rank: number }[] = [];
      for (const item of items) {
        const rank = matchRank(item, query);
        if (rank !== null) ranked.push({ item, rank });
      }
      filtered = ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.item);
    }
    selected = browse ? Math.max(0, filtered.findIndex((item) => item.value === value)) : 0;
    offset = 0;
    if (filtered.length === 0) {
      showMessage(items.length === 0 ? options.messages?.empty : options.messages?.noMatch);
      return;
    }
    // Nothing left to complete: stay out of the way so Tab moves on.
    if (!browse && filtered.length === 1 && filtered[0]?.value === value) {
      hide();
      return;
    }
    show();
    paintRows();
  }

  async function refresh(browse = false): Promise<void> {
    if (disposed || substituting || !input.focused) return;
    if (items) {
      applyFilter(browse);
      return;
    }
    if (loading) return;
    // Avoid one failed request per keystroke while still allowing a quick retry.
    if (Date.now() < retryAfter) return;

    const mine = ++generation;
    try {
      const pending = options.loadItems();
      if (Array.isArray(pending)) {
        items = pending;
        applyFilter(browse);
        return;
      }
      loading = true;
      options.onError?.("");
      showMessage(options.messages?.loading);
      const loaded = await pending;
      if (disposed || mine !== generation || !input.focused) return;
      items = loaded;
      applyFilter(browse);
    } catch (error) {
      if (disposed || mine !== generation) return;
      hide();
      retryAfter = Date.now() + 500;
      options.onError?.(error instanceof Error ? error.message : "Failed to load suggestions");
    } finally {
      if (mine === generation) loading = false;
    }
  }

  function hide(): void {
    open = false;
    filtered = [];
    popup.visible = false;
    node.zIndex = Z_CLOSED;
  }

  function close(): void {
    generation++;
    loading = false;
    hide();
  }

  function invalidate(): void {
    items = null;
    retryAfter = 0;
    close();
    options.onError?.("");
  }

  function move(delta: number): void {
    if (filtered.length === 0) return;
    selected = (selected + delta + filtered.length) % filtered.length;
    paintRows();
  }

  function pick(): void {
    const item = filtered[selected];
    if (!item) return;
    close();
    substituting = true;
    try {
      input.value = item.value;
      input.cursorOffset = item.value.length;
    } finally {
      substituting = false;
    }
    options.onPick?.();
  }

  input.onContentChange = () => {
    options.onChange?.();
    void refresh();
  };
  const onBlur = (): void => close();
  input.on(RenderableEvents.BLURRED, onBlur);

  return {
    node,
    input,
    get visible() {
      return open;
    },
    handleKey: (key) => {
      if (!open) {
        // Down browses the whole list without having to edit the value first.
        if (key.name !== "down" || disposed || !input.focused) return false;
        key.preventDefault();
        void refresh(true);
        return true;
      }
      switch (key.name) {
        case "up":
          if (filtered.length === 0) return false;
          key.preventDefault();
          move(-1);
          return true;
        case "down":
          if (filtered.length === 0) return false;
          key.preventDefault();
          move(1);
          return true;
        case "return":
        case "kpenter":
          if (filtered.length === 0) {
            close();
            return false;
          }
          // Let the input's Enter handler advance focus after selection.
          pick();
          return false;
        case "tab":
          if (key.shift) return false;
          if (filtered.length === 0) {
            close();
            return false;
          }
          // Tab completes without moving focus.
          key.preventDefault();
          pick();
          return true;
        case "escape":
          key.preventDefault();
          close();
          return true;
        default:
          return false;
      }
    },
    close,
    invalidate,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      close();
      input.onContentChange = undefined;
      input.off(RenderableEvents.BLURRED, onBlur);
      node.remove(popup);
      popup.destroyRecursively();
    },
  };
}
