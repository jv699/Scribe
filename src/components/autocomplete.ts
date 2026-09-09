/**
 * Prompt-anchored completion popup. Absolute positioning keeps it attached to
 * a growing prompt without measuring layout or displacing the transcript.
 */
import {
  BoxRenderable,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
  type TextareaRenderable,
} from "@opentui/core";
import { theme } from "../theme.ts";

export interface CompletionItem {
  label: string;
  description?: string;
  /** Text substituted for the trigger and query. Defaults to `label`. */
  insert?: string;
  /** Runs after removing the trigger/query; overrides insertion. */
  run?: () => void;
}

export interface CompletionSource {
  trigger: string;
  atStartOnly?: boolean;
  items(query: string): CompletionItem[] | Promise<CompletionItem[]>;
}

export interface AutocompleteOptions {
  input: TextareaRenderable;
  /** Popup parent; `bottom: "100%"` aligns it with this box's top edge. */
  anchor: BoxRenderable;
  sources: CompletionSource[];
  maxRows?: number;
}

export interface Autocomplete {
  readonly visible: boolean;
  /** Returns whether the key was consumed. */
  handleKey(key: KeyEvent): boolean;
  close(): void;
  dispose(): void;
}

interface Match {
  source: CompletionSource;
  start: number;
  query: string;
}

interface Row {
  node: BoxRenderable;
  label: TextRenderable;
  description: TextRenderable;
}

export function makeAutocomplete(ctx: RenderContext, options: AutocompleteOptions): Autocomplete {
  const { input, anchor, sources } = options;
  const maxRows = Math.max(1, options.maxRows ?? 8);

  const popup = new BoxRenderable(ctx, {
    position: "absolute",
    bottom: "100%",
    // Absolute offsets use the padding box; pull left to align both borders.
    left: -1,
    width: "100%",
    zIndex: 100,
    flexDirection: "column",
    backgroundColor: theme.surfaceRaised,
    border: ["left"],
    borderColor: theme.accent,
    visible: false,
  });
  anchor.add(popup);

  // Rows are allocated once and refilled as the list filters or scrolls, so
  // typing doesn't churn the renderable tree on every keystroke.
  const rows: Row[] = [];
  for (let i = 0; i < maxRows; i++) {
    const node = new BoxRenderable(ctx, {
      width: "100%",
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: theme.surfaceRaised,
    });
    const label = new TextRenderable(ctx, { content: "", fg: theme.textDim });
    const description = new TextRenderable(ctx, { content: "", fg: theme.textMuted });
    node.add(label);
    node.add(description);
    popup.add(node);
    rows.push({ node, label, description });
  }

  let items: CompletionItem[] = [];
  let selected = 0;
  let offset = 0;
  let open = false;
  let substituting = false;
  let generation = 0;
  let destroyed = false;

  /** Nearest trigger wins; whitespace ends the query. */
  function detect(text: string, cursor: number): Match | null {
    if (cursor <= 0) return null;
    let best: Match | null = null;

    for (const source of sources) {
      const start = text.lastIndexOf(source.trigger, cursor - 1);
      if (start < 0 || start >= cursor) continue;

      const query = text.slice(start + source.trigger.length, cursor);
      if (/\s/.test(query)) continue;

      if (source.atStartOnly) {
        if (start !== 0) continue;
      } else {
        // Mid-word triggers are almost always literal — an email address, a
        // path — so only open after whitespace or at the very start.
        const before = start === 0 ? "" : text[start - 1]!;
        if (before !== "" && !/\s/.test(before)) continue;
      }

      if (!best || start > best.start) best = { source, start, query };
    }
    return best;
  }

  function paint(): void {
    // Scroll only enough to keep the selection visible.
    if (selected < offset) offset = selected;
    else if (selected >= offset + maxRows) offset = selected - maxRows + 1;

    const shown = Math.min(maxRows, items.length);
    popup.height = shown;

    // Use the full list width so the description column does not shift while scrolling.
    const labelWidth = items.reduce((widest, item) => Math.max(widest, item.label.length), 0);

    for (const [i, row] of rows.entries()) {
      const item = i < shown ? items[offset + i] : undefined;
      if (!item) {
        row.node.visible = false;
        continue;
      }
      const active = offset + i === selected;
      row.node.visible = true;
      row.node.backgroundColor = active ? theme.accent : theme.surfaceRaised;
      row.label.content = item.description ? item.label.padEnd(labelWidth) : item.label;
      row.label.fg = active ? theme.text : theme.textDim;
      row.description.content = item.description ? `  ${item.description}` : "";
      row.description.fg = active ? theme.text : theme.textMuted;
    }
  }

  function show(next: CompletionItem[]): void {
    items = next;
    selected = 0;
    offset = 0;
    open = true;
    popup.visible = true;
    paint();
  }

  function close(): void {
    // Invalidate in-flight results even if the popup is already closed.
    generation++;
    if (!open) return;
    open = false;
    items = [];
    popup.visible = false;
  }

  async function refresh(): Promise<void> {
    if (substituting || destroyed) return;
    const match = detect(input.plainText, input.cursorOffset);
    if (!match) {
      close();
      return;
    }

    const mine = ++generation;
    let resolved: CompletionItem[];
    try {
      resolved = await match.source.items(match.query);
    } catch {
      // Completion failures must not break typing.
      if (mine === generation) close();
      return;
    }
    if (mine !== generation) return;

    if (resolved.length === 0) {
      close();
      return;
    }
    show(resolved);
  }

  // This component owns the input's content-change hook until disposal.
  input.onContentChange = () => void refresh();

  function pick(): void {
    const item = items[selected];
    if (!item) return;

    // Async candidates may resolve after the buffer has changed.
    const text = input.plainText;
    const cursor = input.cursorOffset;
    const match = detect(text, cursor);
    close();
    if (!match) return;

    const before = text.slice(0, match.start);
    const after = text.slice(cursor);

    if (item.run) {
      substitute(before + after, before.length);
      item.run();
      return;
    }

    // The trailing space separates the mention and closes the popup.
    const insert = `${item.insert ?? item.label} `;
    substitute(before + insert + after, before.length + insert.length);
  }

  function substitute(text: string, cursor: number): void {
    // replaceText fires onContentChange; avoid reopening during substitution.
    substituting = true;
    try {
      input.replaceText(text);
      input.cursorOffset = cursor;
    } finally {
      substituting = false;
    }
  }

  function move(delta: number): void {
    if (items.length === 0) return;
    selected = (selected + delta + items.length) % items.length;
    paint();
  }

  return {
    get visible() {
      return open;
    },

    handleKey: (key) => {
      if (!open) return false;
      switch (key.name) {
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
        case "tab":
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

    dispose: () => {
      destroyed = true;
      close();
      input.onContentChange = undefined;
      anchor.remove(popup);
      popup.destroyRecursively();
    },
  };
}
