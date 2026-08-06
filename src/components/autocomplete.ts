/**
 * The prompt-anchored completion popup: a list that opens off the top edge of
 * the chat box when the user types a trigger character (`@`, `/`).
 *
 * Anchoring is the whole trick, and it is simpler here than it looks. The popup
 * is an **absolutely positioned child of the prompt box** with `bottom: "100%"`,
 * which puts its bottom edge exactly on the prompt's top edge. Nothing measures
 * anything: the popup re-anchors on its own when the prompt grows a line or the
 * popup itself changes height, and because it is out of flow it overlays the
 * transcript instead of squeezing it (so the conversation doesn't jump around
 * while you type). opencode's equivalent polls its anchor's position every 50ms
 * to compute `top = anchorY - height`; it has to, because its prompt is nested
 * behind a plugin slot and it can't observe layout reactively. Scribe's prompt
 * *is* the anchor, so the offset is free.
 *
 * Keys are pushed in by the owner through `handleKey`, the same arrangement as
 * `ask-widget.ts`: the chat screen keeps one keypress listener and stays in
 * charge of what Escape means. The textarea keeps focus throughout — the popup
 * is never focusable — so typing continues to land in the prompt while the list
 * filters underneath the cursor.
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
  /** Shown in the list. */
  label: string;
  /** Dimmed detail after the label. */
  description?: string;
  /** Text substituted for the trigger and query. Defaults to `label`. */
  insert?: string;
  /**
   * When set, picking this item runs it instead of inserting anything — the
   * trigger and query are removed from the prompt. This is how slash commands
   * act on the chat rather than the message.
   */
  run?: () => void;
}

export interface CompletionSource {
  /** The single character that opens this source, e.g. "@" or "/". */
  trigger: string;
  /**
   * Only open when the trigger is the first character of the prompt. Slash
   * commands want this; mentions, which can appear mid-sentence, don't.
   */
  atStartOnly?: boolean;
  /** Candidates for what has been typed after the trigger. May be async. */
  items(query: string): CompletionItem[] | Promise<CompletionItem[]>;
}

export interface AutocompleteOptions {
  /** The prompt textarea to watch and complete into. */
  input: TextareaRenderable;
  /**
   * The prompt's outer box. The popup is mounted inside it, which is what makes
   * `bottom: "100%"` land on the prompt's top edge.
   */
  anchor: BoxRenderable;
  sources: CompletionSource[];
  /** Rows visible at once before the list scrolls. Defaults to 8. */
  maxRows?: number;
}

export interface Autocomplete {
  /** Whether the popup is currently open (i.e. whether it owns the keyboard). */
  readonly visible: boolean;
  /** Feed a key in. Returns true when the popup consumed it. */
  handleKey(key: KeyEvent): boolean;
  /** Close without picking. */
  close(): void;
  dispose(): void;
}

/** Where a trigger sits in the prompt and what has been typed after it. */
interface Match {
  source: CompletionSource;
  /** Offset of the trigger character. */
  start: number;
  /** Text between the trigger and the cursor. */
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
    // The bottom edge lands on the anchor's top edge. See the module comment.
    bottom: "100%",
    // Absolute offsets resolve against the parent's *padding* box, which sits
    // inside the prompt's left border. Pulling back a column puts our border
    // directly over the prompt's, so the two read as one continuous strip
    // instead of a staircase.
    left: -1,
    width: "100%",
    zIndex: 100,
    flexDirection: "column",
    backgroundColor: theme.surfaceRaised,
    // Continues the prompt's accent strip, so popup and prompt read as one unit.
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
  /** First item shown, for lists longer than `maxRows`. */
  let offset = 0;
  let open = false;
  /** Guards against `replaceText` re-entering through onContentChange. */
  let substituting = false;
  /** Discards results from a superseded async `items()` call. */
  let generation = 0;
  let destroyed = false;

  // --- trigger detection ---

  /**
   * Find the trigger governing the cursor, if any. A query may not contain
   * whitespace, so a space closes the popup, and the nearest trigger to the
   * cursor wins when several are candidates.
   */
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

  // --- painting ---

  function paint(): void {
    // Keep the selection inside the visible window, scrolling as little as
    // possible rather than recentring (which makes the list feel jumpy).
    if (selected < offset) offset = selected;
    else if (selected >= offset + maxRows) offset = selected - maxRows + 1;

    const shown = Math.min(maxRows, items.length);
    popup.height = shown;

    // Pad labels to a common width so descriptions line up in a column. Sized
    // from the whole list, not the visible window, so scrolling doesn't shift
    // the column around underneath the cursor.
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
    // Bumped unconditionally, before the early return: an async `items()` can
    // still be in flight while the popup is already shut, and if that result
    // were allowed to land it would reopen a popup the user dismissed — or,
    // after dispose, paint into a destroyed renderable.
    generation++;
    if (!open) return;
    open = false;
    items = [];
    popup.visible = false;
  }

  // --- reacting to typing ---

  async function refresh(): Promise<void> {
    if (substituting || destroyed) return;
    const match = detect(input.plainText, input.cursorOffset);
    if (!match) {
      close();
      return;
    }

    const mine = ++generation;
    const resolved = await match.source.items(match.query);
    // A later keystroke (or a close) already superseded this lookup.
    if (mine !== generation) return;

    if (resolved.length === 0) {
      close();
      return;
    }
    show(resolved);
  }

  // The popup owns this hook; nothing else in the app uses it.
  input.onContentChange = () => void refresh();

  // --- picking ---

  function pick(): void {
    const item = items[selected];
    if (!item) return;

    // Re-detect against live buffer state rather than trusting the snapshot
    // taken when the list was built: an async `items()` may have resolved a
    // keystroke or two later.
    const text = input.plainText;
    const cursor = input.cursorOffset;
    const match = detect(text, cursor);
    close();
    if (!match) return;

    const before = text.slice(0, match.start);
    const after = text.slice(cursor);

    if (item.run) {
      // A command isn't part of the message — take its text back out.
      substitute(before + after, before.length);
      item.run();
      return;
    }

    // The trailing space both separates the mention from what follows and
    // closes the popup, since a query can't contain whitespace.
    const insert = `${item.insert ?? item.label} `;
    substitute(before + insert + after, before.length + insert.length);
  }

  function substitute(text: string, cursor: number): void {
    // replaceText fires onContentChange; the flag stops that reopening the
    // popup we're in the middle of closing.
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
          // Enter picks instead of sending, and Tab completes instead of moving
          // focus, for as long as the list is open.
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
