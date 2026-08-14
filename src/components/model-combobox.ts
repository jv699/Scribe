/**
 * Inline model selector for Settings. The input stays free-form, while a
 * provider-backed dropdown appears after the user starts editing. Models are
 * loaded once, filtered locally, and discarded when the provider settings
 * change through `invalidate()`.
 */
import {
  BoxRenderable,
  InputRenderable,
  RenderableEvents,
  TextRenderable,
  type KeyEvent,
  type RenderContext,
} from "@opentui/core";
import { formatTokenCount } from "../format.ts";
import type { ModelInfo } from "../provider/types.ts";
import { theme } from "../theme.ts";

export interface ModelComboboxOptions {
  value?: string;
  placeholder?: string;
  loadModels: () => Promise<ModelInfo[]>;
  onError?: (message: string) => void;
  maxRows?: number;
}

export interface ModelCombobox {
  node: BoxRenderable;
  input: InputRenderable;
  readonly visible: boolean;
  /** Feed keys in before the Settings screen handles navigation. */
  handleKey(key: KeyEvent): boolean;
  /** Close the dropdown without forgetting a successful model listing. */
  close(): void;
  /** Forget the listing after base URL or API-key configuration changes. */
  invalidate(): void;
  dispose(): void;
}

interface Row {
  node: BoxRenderable;
  label: TextRenderable;
  description: TextRenderable;
}

function describe(model: ModelInfo): string {
  const parts: string[] = [];
  if (model.name && model.name !== model.id) parts.push(model.name);
  if (model.contextLength) parts.push(`${formatTokenCount(model.contextLength)} ctx`);
  return parts.join(" · ");
}

export function makeModelCombobox(ctx: RenderContext, options: ModelComboboxOptions): ModelCombobox {
  const maxRows = Math.max(1, options.maxRows ?? 8);
  const node = new BoxRenderable(ctx, {
    width: "100%",
    height: 1,
    marginBottom: 1,
    // The dropdown extends beyond this one-row anchor. Raising the anchor's
    // stacking context keeps later Settings fields from painting over it.
    zIndex: 100,
  });
  const input = new InputRenderable(ctx, {
    value: options.value ?? "",
    placeholder: options.placeholder ?? "",
    width: "100%",
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
  });
  node.add(input);

  const popup = new BoxRenderable(ctx, {
    position: "absolute",
    top: "100%",
    left: 0,
    width: "100%",
    zIndex: 100,
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
      flexDirection: "row",
      paddingLeft: 1,
      paddingRight: 1,
      backgroundColor: theme.surfaceRaised,
    });
    const label = new TextRenderable(ctx, { content: "", fg: theme.textDim });
    const description = new TextRenderable(ctx, { content: "", fg: theme.textMuted });
    rowNode.add(label);
    rowNode.add(description);
    popup.add(rowNode);
    rows.push({ node: rowNode, label, description });
  }

  let models: ModelInfo[] | null = null;
  let filtered: ModelInfo[] = [];
  let selected = 0;
  let offset = 0;
  let open = false;
  let loading = false;
  let retryAfter = 0;
  let generation = 0;
  let substituting = false;
  let disposed = false;

  function paintRows(): void {
    message.visible = false;
    const shown = Math.min(maxRows, filtered.length);
    popup.height = shown;

    if (selected < offset) offset = selected;
    else if (selected >= offset + maxRows) offset = selected - maxRows + 1;

    const labelWidth = filtered.reduce((width, model) => Math.max(width, model.id.length), 0);
    for (const [i, row] of rows.entries()) {
      const model = i < shown ? filtered[offset + i] : undefined;
      if (!model) {
        row.node.visible = false;
        continue;
      }
      const active = offset + i === selected;
      const detail = describe(model);
      row.node.visible = true;
      row.node.backgroundColor = active ? theme.accent : theme.surfaceRaised;
      row.label.content = detail ? model.id.padEnd(labelWidth) : model.id;
      row.label.fg = active ? theme.text : theme.textDim;
      row.description.content = detail ? `  ${detail}` : "";
      row.description.fg = active ? theme.text : theme.textMuted;
    }
  }

  function showMessage(text: string): void {
    filtered = [];
    selected = 0;
    offset = 0;
    message.content = text;
    message.visible = true;
    for (const row of rows) row.node.visible = false;
    popup.height = 1;
    open = true;
    popup.visible = true;
  }

  function applyFilter(): void {
    if (!models || disposed || !input.focused) return;
    const query = input.value.trim().toLowerCase();
    filtered =
      query === ""
        ? models
        : models.filter(
            (model) => model.id.toLowerCase().includes(query) || (model.name ?? "").toLowerCase().includes(query),
          );
    selected = 0;
    offset = 0;
    open = true;
    popup.visible = true;
    if (filtered.length === 0) showMessage(models.length === 0 ? "No models returned by provider" : "No matching models");
    else paintRows();
  }

  async function refresh(): Promise<void> {
    if (disposed || substituting || !input.focused) return;
    if (models) {
      applyFilter();
      return;
    }
    if (loading) return;
    // A fast failing endpoint can answer between individual keystrokes. Briefly
    // suppress retries so one typed model id does not become one request per
    // character; a later edit can still retry without leaving the screen.
    if (Date.now() < retryAfter) return;

    loading = true;
    options.onError?.("");
    showMessage("Loading models…");
    const mine = ++generation;
    try {
      const loaded = await options.loadModels();
      if (disposed || mine !== generation || !input.focused) return;
      models = loaded;
      applyFilter();
    } catch (error) {
      if (disposed || mine !== generation) return;
      hide();
      retryAfter = Date.now() + 500;
      options.onError?.(error instanceof Error ? error.message : "Failed to load models");
    } finally {
      if (mine === generation) loading = false;
    }
  }

  function hide(): void {
    open = false;
    filtered = [];
    popup.visible = false;
  }

  function close(): void {
    generation++;
    loading = false;
    hide();
  }

  function invalidate(): void {
    models = null;
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
    const model = filtered[selected];
    if (!model) return;
    close();
    substituting = true;
    try {
      input.value = model.id;
      input.cursorOffset = model.id.length;
    } finally {
      substituting = false;
    }
  }

  input.onContentChange = () => void refresh();
  const onBlur = (): void => close();
  input.on(RenderableEvents.BLURRED, onBlur);

  return {
    node,
    input,
    get visible() {
      return open;
    },
    handleKey: (key) => {
      if (!open) return false;
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
          // Fill the selected model, then let the input's normal Enter event
          // advance focus. One press therefore selects and commits the field.
          pick();
          return false;
        case "tab":
          // Shift+Tab remains reverse focus traversal; blurring the input will
          // close the dropdown without accepting its highlighted suggestion.
          if (key.shift) return false;
          if (filtered.length === 0) {
            close();
            return false;
          }
          // Tab only completes the value. Focus stays in the model field so
          // the user can continue editing against the cached listing.
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
