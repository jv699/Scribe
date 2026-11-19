import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core";
import {
  isSettled,
  minimumCost,
  modelLabel,
  prepareBenchPrompt,
  startBench as startBenchDefault,
  type Bench,
  type BenchModel,
  type BenchRun,
  type StartBenchOptions,
} from "../bench/run.ts";
import { showConfirmDialog } from "../components/confirm-dialog.ts";
import { enableSelectMouse, styleSelectFocus } from "../components/ui.ts";
import { formatDollars, formatDuration, truncate } from "../format.ts";
import { checkProvider as checkProviderDefault, type ProviderFields } from "../provider/check.ts";
import { apiKeyFrom, DEFAULT_BASE_URL, listModelInfos } from "../provider/openai.ts";
import type { ModelInfo } from "../provider/types.ts";
import { abbreviateHome, type Settings } from "../store/settings.ts";
import { theme } from "../theme.ts";
import {
  makeFlightDeck,
  makeModelPane,
  makeRunPane,
  runElapsed,
  type BenchPane,
  type FlightDeck,
} from "./bench-views.ts";
import type { Screen } from "./screen.ts";

const SIDEBAR_WIDTH = 32;
/** Row text width: the sidebar minus its padding, border, inset, and scroll indicator. */
const ROW_WIDTH = SIDEBAR_WIDTH - 6;
/** Repaints coalesce: a streaming reply notifies on every delta. */
const REFRESH_DELAY_MS = 30;
const CONFIRM_MODEL_LINES = 6;

export interface BenchScreenOptions {
  settings: Settings;
  onBack: () => void;
  /** Injectable for tests; defaults to the real connection check. */
  checkProvider?: (fields: ProviderFields) => Promise<string | null>;
  loadModels?: (baseUrl: string, apiKeyEnv: string) => Promise<ModelInfo[]>;
  startBench?: (options: StartBenchOptions) => Bench;
}

type Selection = { kind: "deck" } | { kind: "model"; id: number };

function defaultLoadModels(baseUrl: string, apiKeyEnv: string): Promise<ModelInfo[]> {
  return listModelInfos({ baseUrl: baseUrl.trim() || DEFAULT_BASE_URL, apiKey: apiKeyFrom(apiKeyEnv) });
}

const CHECK_MARKS: Record<BenchModel["check"], string> = {
  unchecked: "○",
  checking: "…",
  ready: "✓",
  failed: "✗",
};

function runMark(run: BenchRun): string {
  if (!isSettled(run.status)) return "…";
  if (run.status === "done") return "✓";
  if (run.status === "cancelled") return "–";
  if (run.status === "rate-limited") return "!";
  return "✗";
}

/** "$0.15 in / $0.60 out per 1M", or "pricing unknown". */
function priceLine(model: BenchModel): string {
  const pricing = model.info?.pricing;
  if (pricing?.promptPerToken === undefined || pricing.completionPerToken === undefined) return "pricing unknown";
  const perMillion = (perToken: number): string => formatDollars(perToken * 1_000_000);
  return `${perMillion(pricing.promptPerToken)} in / ${perMillion(pricing.completionPerToken)} out per 1M`;
}

export function benchConfirmBody(ready: readonly BenchModel[], inputChars: number, benchDir: string): string {
  const nameWidth = Math.min(24, Math.max(...ready.map((model) => modelLabel(model).length)));
  const lines = ready
    .slice(0, CONFIRM_MODEL_LINES)
    .map((model) => `${truncate(modelLabel(model), nameWidth).padEnd(nameWidth)}  ${priceLine(model)}`);
  if (ready.length > CONFIRM_MODEL_LINES) lines.push(`…and ${ready.length - CONFIRM_MODEL_LINES} more`);

  const floors = ready.map((model) => minimumCost(model, inputChars));
  const known = floors.filter((floor): floor is number => floor !== undefined);
  lines.push("");
  if (known.length === 0) {
    lines.push("No provider here publishes pricing, so there is no estimate.");
  } else {
    const total = known.reduce((sum, floor) => sum + floor, 0);
    const unpriced = floors.length - known.length;
    lines.push(
      `At least ${formatDollars(total)} for the first requests${unpriced > 0 ? `, plus ${unpriced} unpriced` : ""}.`,
      "Tool calls resend the conversation, so expect several times that.",
    );
  }
  lines.push(`Results are saved to ${abbreviateHome(benchDir)}.`);
  return lines.join("\n");
}

export async function makeBenchScreen(renderer: CliRenderer, options: BenchScreenOptions): Promise<Screen> {
  const { settings } = options;
  const checkProvider = options.checkProvider ?? checkProviderDefault;
  const loadModels = options.loadModels ?? defaultLoadModels;
  const startBench = options.startBench ?? startBenchDefault;

  let disposed = false;
  let modalOpen = false;
  let nextId = 1;
  const newModel = (): BenchModel => ({
    id: nextId++,
    baseUrl: settings.baseUrl ?? "",
    apiKeyEnv: settings.apiKeyEnv ?? "",
    model: settings.model ?? "",
    check: "unchecked",
  });
  // Empty at first: adding a model is the first step, and it walks the user through checking it.
  const models: BenchModel[] = [];
  /** Bumped by every edit and check, so a superseded check can't land. */
  const checkGenerations = new Map<number, number>();
  let bench: Bench | null = null;
  let unsubscribes: (() => void)[] = [];
  const draft = { text: "" };
  /** Models whose row shows the form even though they have a result. */
  const editing = new Set<number>();
  let selection: Selection = { kind: "deck" };
  let activePane: BenchPane | null = null;
  let deck: FlightDeck | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let pendingRefresh: ReturnType<typeof setTimeout> | null = null;

  const runFor = (id: number): BenchRun | undefined => bench?.runs.find((run) => run.model.id === id);
  const running = (): BenchRun[] => bench?.runs.filter((run) => !isSettled(run.status)) ?? [];

  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "row",
    backgroundColor: theme.background,
  });
  const sidebar = new BoxRenderable(renderer, {
    width: SIDEBAR_WIDTH,
    height: "100%",
    flexShrink: 0,
    flexDirection: "column",
    padding: 1,
    border: ["right"],
    borderColor: theme.surfaceActive,
    backgroundColor: theme.surface,
  });
  // The cost warning lives in the confirmation every run goes through.
  sidebar.add(new TextRenderable(renderer, { content: "ScribeBench", fg: theme.accent, marginBottom: 1 }));

  function rows(): SelectOption[] {
    return [
      { name: "Flight Deck", description: "" },
      ...models.map((model) => {
        const run = editing.has(model.id) ? undefined : runFor(model.id);
        const mark = run ? runMark(run) : CHECK_MARKS[model.check];
        const elapsed = run && !isSettled(run.status) ? `${formatDuration(runElapsed(run))} ` : "";
        return { name: truncate(`${mark} ${elapsed}${modelLabel(model)}`, ROW_WIDTH), description: "" };
      }),
      { name: "+ Add Model", description: "" },
    ];
  }

  const selectionIndex = (): number =>
    selection.kind === "deck" ? 0 : 1 + models.findIndex((model) => selection.kind === "model" && model.id === selection.id);

  const menu = new SelectRenderable(renderer, {
    width: "100%",
    height: 1,
    flexGrow: 1,
    showDescription: false,
    showScrollIndicator: true,
    options: rows(),
    selectedIndex: 0,
    selectedBackgroundColor: theme.accent,
    selectedTextColor: theme.text,
  });
  enableSelectMouse(menu, () => !modalOpen);
  // Something is always open on the right; while focus is there, its row
  // keeps a darker orange bar so the sidebar says where you are.
  styleSelectFocus(menu, {
    keepWhenBlurred: () => true,
    blurredColor: theme.accentDark,
    onBlur: () => menu.setSelectedIndex(selectionIndex()),
  });
  sidebar.add(menu);

  const rightPane = new BoxRenderable(renderer, {
    height: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: theme.background,
  });
  container.add(sidebar);
  container.add(rightPane);

  function refreshAll(): void {
    if (disposed) return;
    const selected = menu.getSelectedIndex();
    menu.options = rows();
    menu.setSelectedIndex(Math.min(selected, models.length + 1));
    activePane?.refresh();
    if (ticker && running().length === 0) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function scheduleRefresh(): void {
    if (disposed || pendingRefresh) return;
    pendingRefresh = setTimeout(() => {
      pendingRefresh = null;
      refreshAll();
    }, REFRESH_DELAY_MS);
  }

  function closePane(): void {
    if (!activePane) return;
    const pane = activePane;
    activePane = null;
    deck = null;
    pane.dispose();
    rightPane.remove(pane.node);
    pane.node.destroyRecursively();
  }

  function open(next: Selection, focus = true): void {
    if (disposed) return;
    closePane();
    selection = next;
    let pane: BenchPane;
    if (next.kind === "deck") {
      deck = makeFlightDeck(renderer, {
        draft,
        models: () => models,
        runs: () => bench?.runs ?? [],
        onRun: (prompt) => void requestRun(prompt),
        onCancelAll: () => bench?.cancelAll(),
      });
      pane = deck;
    } else {
      const model = models.find((candidate) => candidate.id === next.id);
      if (!model) return open({ kind: "deck" }, focus);
      const run = runFor(model.id);
      pane =
        run && !editing.has(model.id)
          ? makeRunPane(renderer, {
              run,
              onEdit: () => {
                editing.add(model.id);
                open(next);
                refreshAll();
              },
            })
          : makeModelPane(renderer, {
              model,
              canRemove: () => !run || isSettled(run.status),
              loadModels,
              onEdit: () => {
                checkGenerations.set(model.id, (checkGenerations.get(model.id) ?? 0) + 1);
                model.check = "unchecked";
                delete model.checkError;
                delete model.info;
                scheduleRefresh();
              },
              onSave: () => void check(model),
              onRemove: () => remove(model),
              ...(run
                ? {
                    onShowResult: () => {
                      editing.delete(model.id);
                      open(next);
                      refreshAll();
                    },
                  }
                : {}),
            });
    }
    activePane = pane;
    rightPane.add(pane.node);
    menu.setSelectedIndex(selectionIndex());
    if (focus) pane.focus();
  }

  async function check(model: BenchModel): Promise<void> {
    const generation = (checkGenerations.get(model.id) ?? 0) + 1;
    checkGenerations.set(model.id, generation);
    model.check = "checking";
    delete model.checkError;
    refreshAll();
    const fields = { baseUrl: model.baseUrl, apiKeyEnv: model.apiKeyEnv, model: model.model };
    const [failure, infos] = await Promise.all([
      checkProvider(fields),
      // Pricing for the cost estimate; a provider without a listing just has none.
      loadModels(fields.baseUrl, fields.apiKeyEnv).catch(() => [] as ModelInfo[]),
    ]);
    if (disposed || checkGenerations.get(model.id) !== generation) return;
    const info = infos.find((candidate) => candidate.id === modelLabel(model));
    if (info) model.info = info;
    if (failure === null) model.check = "ready";
    else {
      model.check = "failed";
      model.checkError = failure;
    }
    refreshAll();
  }

  function remove(model: BenchModel): void {
    const index = models.indexOf(model);
    if (index < 0) return;
    models.splice(index, 1);
    editing.delete(model.id);
    checkGenerations.delete(model.id);
    open({ kind: "deck" }, false);
    refreshAll();
    menu.focus();
  }

  function focusCurrent(): void {
    if (disposed) return;
    if (activePane) activePane.focus();
    else menu.focus();
  }

  async function requestRun(prompt: string): Promise<void> {
    if (disposed || modalOpen) return;
    // Short enough for the prompt's hint line at 80 columns.
    if (running().length > 0) return deck?.refuse("A run is already going");
    if (models.length === 0) return deck?.refuse("Add a model in the sidebar first");
    const ready = models.filter((model) => model.check === "ready");
    if (ready.length === 0) return deck?.refuse("No model is ready: open one and Save it");
    if (prompt === "") return deck?.refuse("Write the prompt first");
    // Built once here, for the estimate, and handed to the run.
    modalOpen = true;
    let systemPrompt: string;
    try {
      systemPrompt = await prepareBenchPrompt(settings);
    } catch (error) {
      modalOpen = false;
      return deck?.refuse(`Couldn't prepare the run: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (disposed) return;
    showConfirmDialog(renderer, {
      width: 68,
      title: `Run ${ready.length} model${ready.length === 1 ? "" : "s"} on this prompt?`,
      body: benchConfirmBody(ready, systemPrompt.length + prompt.length, settings.benchDir),
      confirmLabel: "Run",
      onConfirm: () => launch(prompt, systemPrompt, ready),
      onClose: () => {
        modalOpen = false;
        focusCurrent();
      },
    });
  }

  function launch(prompt: string, systemPrompt: string, ready: readonly BenchModel[]): void {
    if (disposed) return;
    for (const unsubscribe of unsubscribes) unsubscribe();
    editing.clear();
    bench = startBench({ prompt, systemPrompt, models: ready, settings });
    unsubscribes = bench.runs.map((run) => run.subscribe(scheduleRefresh));
    // Elapsed times tick even when nothing streams.
    if (!ticker) ticker = setInterval(scheduleRefresh, 1000);
    open({ kind: "deck" }, false);
    refreshAll();
  }

  /** Whether the Ctrl+C stop-and-quit question is up; a second Ctrl+C then quits. */
  let asking = false;

  /** Runs never outlive the screen: each one is a bill. Leaving with some going asks first. */
  function confirmStop(action: string, onConfirm: () => void, body: string): void {
    const count = running().length;
    modalOpen = true;
    showConfirmDialog(renderer, {
      title: `Stop ${count} running model${count === 1 ? "" : "s"} and ${action}?`,
      body,
      confirmLabel: `Stop and ${action}`,
      onConfirm: () => {
        bench?.cancelAll();
        onConfirm();
      },
      onClose: () => {
        modalOpen = false;
        // Cancelling the Ctrl+C question must re-arm it.
        asking = false;
        focusCurrent();
      },
    });
  }

  function requestLeave(): void {
    if (disposed || modalOpen) return;
    if (running().length === 0) {
      options.onBack();
      return;
    }
    confirmStop("leave", options.onBack, "Results that already finished are saved.");
  }

  function handleInterrupt(quit: () => void): "handled" | "quit" {
    if (asking || running().length === 0) return "quit";
    if (modalOpen) return "handled";
    asking = true;
    confirmStop(
      "quit",
      quit,
      "Results that already finished are saved.\nPress Ctrl+C again to quit.",
    );
    return "handled";
  }

  menu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    if (modalOpen || disposed) return;
    if (index === 0) open({ kind: "deck" });
    else if (index <= models.length) open({ kind: "model", id: models[index - 1]!.id });
    else {
      const model = newModel();
      models.push(model);
      refreshAll();
      open({ kind: "model", id: model.id });
    }
  });

  const onKeypress = (key: KeyEvent): void => {
    if (disposed || modalOpen) return;
    const inSidebar = renderer.currentFocusedRenderable === menu;
    if (!inSidebar && activePane?.handleKey(key)) return;
    if (key.name === "escape") {
      key.preventDefault();
      if (inSidebar) requestLeave();
      else menu.focus();
      return;
    }
    if (key.name === "tab" && inSidebar) {
      key.preventDefault();
      activePane?.focus();
    }
  };
  renderer.keyInput.on("keypress", onKeypress);

  open({ kind: "deck" }, false);
  menu.focus();

  return {
    node: container,
    focus: () => menu.focus(),
    handleInterrupt,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      bench?.cancelAll();
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes = [];
      if (ticker) clearInterval(ticker);
      if (pendingRefresh) clearTimeout(pendingRefresh);
      renderer.keyInput.off("keypress", onKeypress);
      closePane();
    },
  };
}
