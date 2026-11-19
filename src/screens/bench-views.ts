/**
 * The ScribeBench right-pane views: a model's settings form, a run's
 * read-only transcript, and the flight deck. Each owns its renderables and
 * listeners; the bench screen owns the lineup, the runs, and navigation.
 */
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import { makeCombobox } from "../components/combobox.ts";
import { makeModelCombobox } from "../components/model-combobox.ts";
import { makePrompt } from "../components/prompt.ts";
import { makeTranscript, type TranscriptActivity } from "../components/transcript.ts";
import { makeButton, tabWalk, TEXT_FIELD_KEYS } from "../components/ui.ts";
import { formatDollars, formatDuration, formatTokenCount, truncate } from "../format.ts";
import { createMarkdownSyntaxStyle } from "../markdown-style.ts";
import { baseUrlProblem, keyVarProblem, looksLikeApiKey } from "../provider/check.ts";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "../provider/openai.ts";
import { PROVIDER_PRESETS } from "../provider/presets.ts";
import type { ChatMessage, ModelInfo } from "../provider/types.ts";
import { isSettled, modelLabel, type BenchModel, type BenchRun, type RunActivity, type RunStatus } from "../bench/run.ts";
import { theme } from "../theme.ts";

export interface BenchPane {
  node: BoxRenderable;
  focus(): void;
  /** Keys the pane claims before the screen's own (dropdowns, Tab). */
  handleKey(key: KeyEvent): boolean;
  /** Repaint from the model or run it shows. */
  refresh(): void;
  dispose(): void;
}

const STATUS_WORDS: Record<RunStatus, string> = {
  queued: "waiting",
  thinking: "thinking",
  tool: "using a tool",
  writing: "writing",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  "rate-limited": "rate limited",
  "timed-out": "timed out",
};

export function statusWord(status: RunStatus): string {
  return STATUS_WORDS[status];
}

export function statusColor(status: RunStatus): string {
  if (status === "done") return theme.success;
  if (status === "failed" || status === "rate-limited" || status === "timed-out") return theme.danger;
  if (status === "cancelled" || status === "queued") return theme.textMuted;
  return theme.accent;
}

export function runElapsed(run: BenchRun, now: number = Date.now()): number {
  if (run.startedAt === null) return 0;
  return (run.endedAt ?? now) - run.startedAt;
}

/** "done · 12.4s · 3.1k tok · $0.0123", leaving out what isn't known yet (and the cost, for a tile that shows it on its own row). */
export function runSummary(run: BenchRun, now: number = Date.now(), withCost = true): string {
  const parts = [statusWord(run.status)];
  if (run.startedAt !== null) parts.push(formatDuration(runElapsed(run, now)));
  const tokens = run.promptTokens + run.completionTokens;
  if (tokens > 0) parts.push(`${formatTokenCount(tokens)} tok`);
  if (withCost && run.cost !== undefined && run.cost > 0) parts.push(formatDollars(run.cost));
  return parts.join(" · ");
}

function title(renderer: CliRenderer, content: string): TextRenderable {
  return new TextRenderable(renderer, { content, fg: theme.accent, wrapMode: "none", truncate: true, flexShrink: 0 });
}

function buttonRow(renderer: CliRenderer, buttons: BoxRenderable[]): BoxRenderable {
  const row = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0 });
  buttons.forEach((button, index) => {
    if (index > 0) row.add(new BoxRenderable(renderer, { width: 2 }));
    row.add(button);
  });
  return row;
}

// --- model form ---

export interface ModelPaneOptions {
  model: BenchModel;
  /** False while this model has a run going: its transcript lives on its row. */
  canRemove: () => boolean;
  loadModels: (baseUrl: string, apiKeyEnv: string) => Promise<ModelInfo[]>;
  /** Fields were edited: the model is no longer known to work. */
  onEdit: () => void;
  /** Saved fields are valid; the caller checks the connection. */
  onSave: () => void;
  onRemove: () => void;
  /** Present once this model has a result to go back to. */
  onShowResult?: () => void;
}

const LABEL_WIDTH = 17;

export function makeModelPane(renderer: CliRenderer, options: ModelPaneOptions): BenchPane {
  const { model } = options;
  let disposed = false;
  /** Why the model list couldn't load; refresh keeps it up until the listing works ("" clears it). */
  let listingError = "";
  /** A refused field, shown until the next edit or save. */
  let refusal = "";
  const node = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingTop: 1,
    paddingLeft: 2,
    paddingRight: 2,
  });
  node.add(title(renderer, `Model ${model.id}`));
  node.add(
    new TextRenderable(renderer, {
      content: "Blank fields use the defaults. Saving checks the connection; only checked models run.",
      fg: theme.textMuted,
      wrapMode: "word",
      marginBottom: 1,
    }),
  );

  let rowCount = 0;
  function addRow(label: string, control: Renderable, trailing?: Renderable): void {
    // Earlier rows stack above later ones: a dropdown hangs over the rows below it.
    const row = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", zIndex: 100 - rowCount++ });
    row.add(new TextRenderable(renderer, { content: label, fg: theme.textMuted, width: LABEL_WIDTH, flexShrink: 0 }));
    const slot = new BoxRenderable(renderer, { flexGrow: 1, flexShrink: 1, flexBasis: 0, marginBottom: 1 });
    slot.add(control);
    row.add(slot);
    if (trailing) row.add(trailing);
    node.add(row);
  }

  const edited = (): void => {
    if (disposed) return;
    // The edit buffer reports its starting text as a change; that edits nothing.
    if (baseUrlInput.value === model.baseUrl && keyInput.value === model.apiKeyEnv && modelInput.value === model.model) {
      return;
    }
    refusal = "";
    model.baseUrl = baseUrlInput.value;
    model.apiKeyEnv = keyInput.value;
    model.model = modelInput.value;
    options.onEdit();
  };

  const baseUrlCombobox = makeCombobox(renderer, {
    value: model.baseUrl,
    placeholder: DEFAULT_BASE_URL,
    maxRows: PROVIDER_PRESETS.length,
    loadItems: () =>
      PROVIDER_PRESETS.map((preset) => ({ value: preset.baseUrl, label: preset.name, description: preset.baseUrl })),
    onChange: () => {
      modelCombobox.invalidate();
      edited();
    },
  });
  const baseUrlInput = baseUrlCombobox.input;
  addRow("Base URL", baseUrlCombobox.node);

  const keyInput = new InputRenderable(renderer, {
    value: model.apiKeyEnv,
    placeholder: "OPENAI_API_KEY",
    width: "100%",
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    keyBindings: TEXT_FIELD_KEYS,
    placeholderColor: theme.textMuted,
  });
  keyInput.onContentChange = () => {
    modelCombobox.invalidate();
    edited();
  };
  addRow("API key env var", keyInput);

  const modelCombobox = makeModelCombobox(renderer, {
    value: model.model,
    placeholder: DEFAULT_MODEL,
    loadModels: () => options.loadModels(baseUrlInput.value, keyInput.value),
    onError: (message) => {
      listingError = message;
      refresh();
    },
    onChange: edited,
  });
  const modelInput = modelCombobox.input;
  const checkMark = new TextRenderable(renderer, { content: "", width: 11, flexShrink: 0, marginLeft: 1 });
  addRow("Model", modelCombobox.node, checkMark);

  const status = new TextRenderable(renderer, { content: "", fg: theme.danger, wrapMode: "word" });
  function setStatus(message: string, tone: "error" | "info" = "error"): void {
    if (disposed) return;
    status.content = message;
    status.fg = tone === "error" ? theme.danger : theme.textMuted;
  }

  function save(): void {
    if (disposed) return;
    const problem = baseUrlProblem(baseUrlInput.value);
    if (problem) {
      refusal = problem;
      refresh();
      baseUrlInput.focus();
      return;
    }
    const keyProblem = keyVarProblem(keyInput.value);
    if (keyProblem) {
      // A pasted key comes off the screen; it is never kept. A bad name stays to be fixed.
      if (looksLikeApiKey(keyInput.value.trim())) keyInput.value = "";
      refusal = keyProblem;
      refresh();
      keyInput.focus();
      return;
    }
    refusal = "";
    options.onSave();
  }

  const saveButton = makeButton(renderer, { label: "Save", variant: "primary", onClick: save });
  const removeButton = makeButton(renderer, {
    label: "Remove",
    onClick: () => {
      if (!disposed && options.canRemove()) options.onRemove();
    },
  });
  const buttons = [saveButton, removeButton];
  if (options.onShowResult) {
    const onShowResult = options.onShowResult;
    buttons.push(makeButton(renderer, { label: "View result", onClick: () => !disposed && onShowResult() }));
  }
  node.add(buttonRow(renderer, buttons));
  node.add(status);

  const focusChain: Renderable[] = [baseUrlInput, keyInput, modelInput, ...buttons];
  const advance = (from: Renderable): void => {
    focusChain[focusChain.indexOf(from) + 1]?.focus();
  };
  for (const input of [baseUrlInput, keyInput]) input.on(InputRenderableEvents.ENTER, () => advance(input));
  // Enter on the model is the natural "done": save and check.
  modelInput.on(InputRenderableEvents.ENTER, save);

  function refresh(): void {
    if (disposed) return;
    removeButton.visible = options.canRemove();
    if (model.check === "ready") {
      checkMark.content = "✓ connected";
      checkMark.fg = theme.success;
    } else if (model.check === "checking") {
      checkMark.content = "checking…";
      checkMark.fg = theme.textMuted;
    } else if (model.check === "failed") {
      checkMark.content = "✗ failed";
      checkMark.fg = theme.danger;
    } else {
      checkMark.content = "";
    }
    // Derived on every refresh (the screen refreshes on each run delta), so
    // nothing written here can be wiped by an unrelated repaint.
    if (refusal) setStatus(refusal);
    else if (model.check === "failed") setStatus(model.checkError ?? "The connection check failed.");
    else if (listingError) setStatus(listingError);
    else if (model.check === "ready") setStatus("Ready to run.", "info");
    else setStatus("");
  }
  refresh();

  return {
    node,
    focus: () => baseUrlInput.focus(),
    handleKey(key) {
      if (baseUrlCombobox.handleKey(key) || modelCombobox.handleKey(key)) return true;
      return tabWalk(renderer, focusChain, key);
    },
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      baseUrlCombobox.dispose();
      modelCombobox.dispose();
      keyInput.onContentChange = undefined;
    },
  };
}

// --- run transcript ---

export interface RunPaneOptions {
  run: BenchRun;
  onEdit: () => void;
}

export function makeRunPane(renderer: CliRenderer, options: RunPaneOptions): BenchPane {
  const { run } = options;
  let disposed = false;
  const node = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    paddingBottom: 1,
  });
  // Opaque and above the scroll box, which doesn't clip its rows' borders.
  // Two lines: the summary would crowd the name out of an 80-column header.
  const header = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: 3,
    paddingTop: 1,
    backgroundColor: theme.background,
    flexShrink: 0,
    zIndex: 1,
  });
  header.add(
    new TextRenderable(renderer, { content: modelLabel(run.model), fg: theme.accent, wrapMode: "none", truncate: true }),
  );
  const summary = new TextRenderable(renderer, { content: "", fg: theme.textMuted, wrapMode: "none", truncate: true });
  header.add(summary);
  node.add(header);

  const syntaxStyle = createMarkdownSyntaxStyle();
  const scrollBox = new ScrollBoxRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
  });
  const transcript = makeTranscript(renderer, { syntaxStyle });
  scrollBox.content.add(transcript.node);
  node.add(scrollBox);

  // The result is already saved with the run; these only stop or revisit it.
  const cancelButton = makeButton(renderer, { label: "Cancel run", onClick: () => run.cancel() });
  const editButton = makeButton(renderer, { label: "Edit model", onClick: () => !disposed && options.onEdit() });
  const buttons = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, marginTop: 1 });
  buttons.add(cancelButton);
  buttons.add(editButton);
  node.add(buttons);

  // Replay the run's timeline into the transcript, then follow it live. An
  // assistant message joins the visible list only at its `shown` entry, which
  // is what puts it below the activity row it streamed after.
  const messages: ChatMessage[] = [];
  const shown = new Set<ChatMessage>();
  const open = new Map<RunActivity, TranscriptActivity>();
  let cursor = 0;
  const sync = (): void => transcript.sync(messages.filter((message) => shown.has(message)));

  function follow(): void {
    const timeline = run.timeline;
    for (; cursor < timeline.length; cursor++) {
      const entry = timeline[cursor]!;
      if (entry.kind === "message") {
        messages.push(entry.message);
        if (entry.message.role !== "assistant") shown.add(entry.message);
        sync();
      } else if (entry.kind === "shown") {
        shown.add(entry.message);
        sync();
      } else if (entry.kind === "activity") {
        // Render first so the row lands below the message before it.
        sync();
        const { activity } = entry;
        const row = transcript.beginActivity(activity.present, activity.past, activity.startedAt);
        if (activity.endedAt !== undefined) row.finish(activity.endedAt);
        else open.set(activity, row);
      } else {
        transcript.addNotice(entry.text, entry.tone);
      }
    }
    for (const [activity, row] of open) {
      if (activity.endedAt === undefined) continue;
      row.finish(activity.endedAt);
      open.delete(activity);
    }
    sync();
  }

  let lastSettled: boolean | null = null;
  function refresh(): void {
    if (disposed) return;
    follow();
    summary.content = runSummary(run);
    summary.fg = statusColor(run.status);
    const settled = isSettled(run.status);
    if (settled !== lastSettled) {
      lastSettled = settled;
      cancelButton.visible = !settled;
      editButton.visible = settled;
    }
  }
  refresh();

  return {
    node,
    focus: () => (cancelButton.visible ? cancelButton : editButton).focus(),
    handleKey: (key) => tabWalk(renderer, [cancelButton.visible ? cancelButton : editButton], key),
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const row of open.values()) row.finish();
      open.clear();
      transcript.reset();
      syntaxStyle.destroy();
    },
  };
}

// --- flight deck ---

export interface FlightDeckOptions {
  /** Kept across visits, so leaving the deck doesn't lose the prompt. */
  draft: { text: string };
  models: () => readonly BenchModel[];
  runs: () => readonly BenchRun[];
  onRun: (prompt: string) => void;
  onCancelAll: () => void;
}

const TILE_WIDTH = 34;
const TILE_ACTIVITY_ROWS = 3;

interface Tile {
  node: BoxRenderable;
  name: TextRenderable;
  summary: TextRenderable;
  cost: TextRenderable;
  lines: TextRenderable[];
}

/** "$0.1234", or a placeholder for a model whose provider publishes no pricing. */
export function tileCost(run: BenchRun): { text: string; fg: string } {
  if (run.cost !== undefined) return { text: formatDollars(run.cost), fg: theme.success };
  return { text: "cost unknown", fg: theme.textMuted };
}

/** What a whole run cost, as far as pricing is known. */
export function totalCost(runs: readonly BenchRun[]): { cost: number; priced: number; unpriced: number } {
  let cost = 0;
  let priced = 0;
  for (const run of runs) {
    if (run.cost === undefined) continue;
    cost += run.cost;
    priced++;
  }
  return { cost, priced, unpriced: runs.length - priced };
}

/** The newest activity rows (and a failure's reason), oldest first. */
export function tileLines(run: BenchRun, now: number = Date.now()): { text: string; fg: string }[] {
  const lines: { text: string; fg: string }[] = [];
  for (const entry of run.timeline) {
    if (entry.kind === "activity") {
      const { activity } = entry;
      lines.push(
        activity.endedAt === undefined
          ? { text: `${activity.present}… ${formatDuration(now - activity.startedAt)}`, fg: theme.textDim }
          : { text: `${activity.past} · ${formatDuration(activity.endedAt - activity.startedAt)}`, fg: theme.textMuted },
      );
    } else if (entry.kind === "notice") {
      lines.push({ text: entry.text, fg: entry.tone === "danger" ? theme.danger : theme.textMuted });
    }
  }
  return lines.slice(-TILE_ACTIVITY_ROWS);
}

export interface FlightDeck extends BenchPane {
  /** Say why a run didn't start, in red in the prompt's hint; the next edit clears it. */
  refuse(message: string): void;
}

export function makeFlightDeck(renderer: CliRenderer, options: FlightDeckOptions): FlightDeck {
  let disposed = false;
  const node = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingTop: 1,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const titleRow = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, width: "100%" });
  titleRow.add(title(renderer, "Flight Deck"));
  const lineup = new TextRenderable(renderer, { content: "", fg: theme.textMuted, marginLeft: 2, wrapMode: "none", truncate: true, flexShrink: 1, minWidth: 0 });
  titleRow.add(lineup);
  node.add(titleRow);

  const prompt = makePrompt(renderer, {
    placeholder: "The prompt every ready model gets…",
    hint: "Enter runs every ready model",
    onSubmit: () => run(),
  });
  prompt.node.marginTop = 1;
  prompt.node.flexShrink = 0;
  prompt.input.setText(options.draft.text);
  prompt.input.onContentChange = () => {
    options.draft.text = prompt.input.plainText;
    if (refused) {
      refused = false;
      prompt.setHint();
    }
  };
  node.add(prompt.node);

  const runButton = makeButton(renderer, { label: "Run", variant: "primary", onClick: () => run() });
  const cancelButton = makeButton(renderer, { label: "Cancel all", onClick: () => options.onCancelAll() });
  const controls = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0, marginTop: 1 });
  // Only one of the two shows at a time.
  controls.add(runButton);
  controls.add(cancelButton);
  node.add(controls);

  const status = new TextRenderable(renderer, { content: "", fg: theme.textMuted, wrapMode: "word", flexShrink: 0 });
  node.add(status);
  const total = new TextRenderable(renderer, { content: "", fg: theme.success, wrapMode: "word", flexShrink: 0 });
  total.visible = false;
  node.add(total);

  const scrollBox = new ScrollBoxRenderable(renderer, { width: "100%", flexGrow: 1, scrollY: true, marginTop: 1 });
  const grid = new BoxRenderable(renderer, { width: "100%", flexDirection: "row", flexWrap: "wrap" });
  scrollBox.content.add(grid);
  node.add(scrollBox);

  function run(): void {
    if (disposed) return;
    options.onRun(prompt.input.plainText.trim());
  }

  let refused = false;
  let tiles: Tile[] = [];
  let tiledRuns: readonly BenchRun[] | null = null;

  function makeTile(): Tile {
    const tile = new BoxRenderable(renderer, {
      width: TILE_WIDTH,
      flexDirection: "column",
      border: true,
      borderColor: theme.surfaceActive,
      paddingLeft: 1,
      paddingRight: 1,
      marginRight: 1,
    });
    const name = new TextRenderable(renderer, { content: "", fg: theme.text, wrapMode: "none", truncate: true });
    const summaryText = new TextRenderable(renderer, { content: "", wrapMode: "none", truncate: true });
    const cost = new TextRenderable(renderer, { content: "", wrapMode: "none", truncate: true });
    tile.add(name);
    tile.add(summaryText);
    tile.add(cost);
    const lines: TextRenderable[] = [];
    for (let i = 0; i < TILE_ACTIVITY_ROWS; i++) {
      const line = new TextRenderable(renderer, { content: "", fg: theme.textMuted, wrapMode: "none", truncate: true });
      tile.add(line);
      lines.push(line);
    }
    grid.add(tile);
    return { node: tile, name, summary: summaryText, cost, lines };
  }

  function rebuildTiles(runs: readonly BenchRun[]): void {
    for (const tile of tiles) {
      grid.remove(tile.node);
      tile.node.destroyRecursively();
    }
    tiles = runs.map(() => makeTile());
    tiledRuns = runs;
  }

  function refresh(): void {
    if (disposed) return;
    const models = options.models();
    const ready = models.filter((model) => model.check === "ready").length;
    lineup.content = `${ready} of ${models.length} ready`;

    const runs = options.runs();
    if (runs !== tiledRuns) {
      rebuildTiles(runs);
      // An empty scroll box still draws its scrollbar.
      scrollBox.visible = runs.length > 0;
    }
    const now = Date.now();
    runs.forEach((benchRun, index) => {
      const tile = tiles[index]!;
      const inner = TILE_WIDTH - 4;
      tile.name.content = truncate(modelLabel(benchRun.model), inner);
      tile.summary.content = truncate(runSummary(benchRun, now, false), inner);
      tile.summary.fg = statusColor(benchRun.status);
      const cost = tileCost(benchRun);
      tile.cost.content = cost.text;
      tile.cost.fg = cost.fg;
      tile.node.borderColor = isSettled(benchRun.status) ? theme.surfaceActive : theme.accent;
      const lines = tileLines(benchRun, now);
      tile.lines.forEach((line, row) => {
        const content = lines[row];
        line.content = content ? truncate(content.text, inner) : "";
        line.fg = content?.fg ?? theme.textMuted;
      });
    });

    const running = runs.some((benchRun) => !isSettled(benchRun.status));
    runButton.visible = !running;
    cancelButton.visible = running;
    if (running) setStatus("Running. Open a model in the sidebar to read its transcript.");
    else if (runs.length > 0) setStatus("Finished. Each model's result is in the sidebar and saved under the bench folder.");
    else if (models.length === 0) setStatus("Add a model from the sidebar to get started.");
    else if (ready === 0) setStatus("No model is ready yet: open one in the sidebar and Save it to check its connection.");
    else setStatus("");

    const sum = totalCost(runs);
    total.visible = !running && sum.priced > 0;
    if (total.visible) {
      const unpriced = sum.unpriced > 0 ? ` (plus ${sum.unpriced} model${sum.unpriced === 1 ? "" : "s"} without pricing)` : "";
      total.content = `Total cost: ${formatDollars(sum.cost)}${unpriced}`;
    }
  }

  function setStatus(message: string): void {
    if (!disposed) status.content = message;
  }

  refresh();

  return {
    node,
    focus: () => prompt.input.focus(),
    refuse(message) {
      if (disposed) return;
      refused = true;
      prompt.setHint(message, "danger");
    },
    handleKey: (key) => tabWalk(renderer, [prompt.input, runButton.visible ? runButton : cancelButton], key),
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      prompt.input.onContentChange = undefined;
    },
  };
}
