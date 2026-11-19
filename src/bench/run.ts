/**
 * ScribeBench's run engine: one headless `BenchRun` per model, owning its
 * `runAgent` call, so runs keep going whichever pane is showing. Views
 * subscribe and read the run's state; nothing here touches the renderer.
 */
import { buildBenchSystemPrompt } from "../agent/context.ts";
import { toolsFor } from "../agent/agents.ts";
import { runAgent } from "../agent/loop.ts";
import { toolLabel, toolPastLabel } from "../agent/tools/index.ts";
import { apiKeyFrom, createOpenAIProvider, DEFAULT_BASE_URL, DEFAULT_MODEL, ProviderHttpError } from "../provider/openai.ts";
import type { ChatMessage, ChatProvider, ModelInfo, UsageInfo } from "../provider/types.ts";
import { createBenchRunFolder, writeBenchResult } from "../store/bench.ts";
import type { Settings } from "../store/settings.ts";
import { indexSources } from "../store/sources.ts";

/** A model that hasn't answered in this long is stopped, so a stuck stream can't bill forever. */
export const RUN_TIMEOUT_MS = 10 * 60_000;

export type CheckState = "unchecked" | "checking" | "ready" | "failed";

/** One lineup entry. Blank fields mean the same defaults a chat would use. */
export interface BenchModel {
  id: number;
  baseUrl: string;
  /** The name of the env var holding the key — never the key. */
  apiKeyEnv: string;
  model: string;
  check: CheckState;
  checkError?: string;
  /** From the provider's `/models` listing, for pricing; absent when it has none. */
  info?: ModelInfo;
}

export function modelLabel(model: Pick<BenchModel, "model">): string {
  return model.model.trim() || DEFAULT_MODEL;
}

export type RunStatus =
  | "queued"
  | "thinking"
  | "tool"
  | "writing"
  | "done"
  | "failed"
  | "cancelled"
  | "rate-limited"
  | "timed-out";

export function isSettled(status: RunStatus): boolean {
  return status !== "queued" && status !== "thinking" && status !== "tool" && status !== "writing";
}

export interface RunActivity {
  present: string;
  past: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * What happened, in order, so a transcript opened mid-run (or after) replays
 * into the same rows a live one built. An assistant message is announced
 * empty and only becomes visible at its first text — that is `shown` —
 * which is what keeps it below the "Thought" row it streamed after.
 */
export type TimelineEntry =
  | { kind: "message"; message: ChatMessage }
  | { kind: "shown"; message: ChatMessage }
  | { kind: "activity"; activity: RunActivity }
  | { kind: "notice"; text: string; tone: "muted" | "danger" };

export interface BenchRun {
  readonly model: BenchModel;
  readonly status: RunStatus;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** The conversation, system prompt excluded; mutated in place while streaming. */
  readonly messages: readonly ChatMessage[];
  readonly timeline: readonly TimelineEntry[];
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Undefined when the provider publishes no pricing for this model. */
  readonly cost: number | undefined;
  readonly toolCalls: number;
  readonly error: string | null;
  /** The final reply; empty until the run is done. */
  readonly answer: string;
  /** Called after every change, including each streamed delta. */
  subscribe(listener: () => void): () => void;
  cancel(): void;
}

export interface Bench {
  readonly runs: readonly BenchRun[];
  /** Resolves once every run has settled and its result file is written. */
  readonly done: Promise<void>;
  /** Where results go; null until created, or when it couldn't be. */
  readonly folder: () => string | null;
  cancelAll(): void;
}

export interface StartBenchOptions {
  prompt: string;
  /** Every model given runs; the caller picks the ready ones. */
  models: readonly BenchModel[];
  settings: Settings;
  createProvider?: (model: BenchModel) => ChatProvider;
  /**
   * The system prompt, when the caller already built it (after indexing the
   * sources) — the screen does, for its cost estimate. Otherwise built here.
   */
  systemPrompt?: string;
  timeoutMs?: number;
  now?: () => number;
}

export function providerFor(model: BenchModel): ChatProvider {
  const apiKeyEnv = model.apiKeyEnv.trim();
  return createOpenAIProvider({
    baseUrl: model.baseUrl.trim() || DEFAULT_BASE_URL,
    model: modelLabel(model),
    apiKey: apiKeyFrom(apiKeyEnv),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  });
}

/**
 * A floor, not a forecast: what each priced model's first request costs for
 * this much input (about 4 characters a token). Tool calls resend the whole
 * conversation, so a real run costs several times this.
 */
export function minimumCost(model: BenchModel, inputChars: number): number | undefined {
  const price = model.info?.pricing?.promptPerToken;
  return price === undefined ? undefined : (inputChars / 4) * price;
}

interface MutableRun extends BenchRun {
  start(provider: ChatProvider, systemPrompt: string, prompt: string, folder: string | null): Promise<void>;
  /** Settle a run that never started: cancelled, or failed while preparing. */
  abandon(reason?: string): void;
}

function makeRun(model: BenchModel, settings: Settings, timeoutMs: number, now: () => number): MutableRun {
  const listeners = new Set<() => void>();
  const controller = new AbortController();
  const messages: ChatMessage[] = [];
  const timeline: TimelineEntry[] = [];
  const pricing = model.info?.pricing;
  const priced = pricing?.promptPerToken !== undefined && pricing.completionPerToken !== undefined;
  let status: RunStatus = "queued";
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let cost = 0;
  let toolCalls = 0;
  let error: string | null = null;
  let answer = "";
  let timedOut = false;
  let live: RunActivity | null = null;
  let current: ChatMessage | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  function beginActivity(present: string, past: string): void {
    endActivity();
    live = { present, past, startedAt: now() };
    timeline.push({ kind: "activity", activity: live });
  }

  function endActivity(): void {
    if (live) live.endedAt = now();
    live = null;
  }

  function recordUsage(usage: UsageInfo): void {
    promptTokens += usage.promptTokens;
    completionTokens += usage.completionTokens;
    if (priced) cost += usage.promptTokens * pricing.promptPerToken! + usage.completionTokens * pricing.completionPerToken!;
  }

  function settle(next: RunStatus): void {
    endActivity();
    status = next;
    endedAt = now();
  }

  const run: MutableRun = {
    model,
    get status() {
      return status;
    },
    get startedAt() {
      return startedAt;
    },
    get endedAt() {
      return endedAt;
    },
    messages,
    timeline,
    get promptTokens() {
      return promptTokens;
    },
    get completionTokens() {
      return completionTokens;
    },
    get cost() {
      return priced ? cost : undefined;
    },
    get toolCalls() {
      return toolCalls;
    },
    get error() {
      return error;
    },
    get answer() {
      return answer;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cancel() {
      if (isSettled(status)) return;
      controller.abort();
      // A queued run has no agent loop to notice the abort.
      if (status === "queued") run.abandon();
    },
    abandon(reason) {
      if (isSettled(status)) return;
      if (reason === undefined) settle("cancelled");
      else {
        error = reason;
        settle("failed");
        timeline.push({ kind: "notice", text: reason, tone: "danger" });
      }
      notify();
    },
    async start(provider, systemPrompt, prompt, folder) {
      if (controller.signal.aborted) return;
      startedAt = now();
      const user: ChatMessage = { role: "user", content: prompt };
      messages.push(user);
      timeline.push({ kind: "message", message: user });
      status = "thinking";
      notify();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        const result = await runAgent(
          {
            provider,
            systemPrompt,
            tools: toolsFor("bench", { sourcesDir: settings.sourcesDir }),
            signal: controller.signal,
            onMessage: (message) => {
              messages.push(message);
              timeline.push({ kind: "message", message });
              if (message.role === "assistant") {
                current = message;
                status = "thinking";
                beginActivity("Thinking", "Thought");
              }
              notify();
            },
            onText: (delta) => {
              if (current && current.content === "") {
                endActivity();
                timeline.push({ kind: "shown", message: current });
              }
              // runAgent fills content in after the stream; mirror it as it arrives.
              if (current) current.content += delta;
              status = "writing";
              notify();
            },
            onTool: (name) => {
              toolCalls++;
              status = "tool";
              beginActivity(toolLabel(name), toolPastLabel(name));
              notify();
            },
            onToolEnd: () => {
              endActivity();
              status = "thinking";
              notify();
            },
            onUsage: (usage) => {
              recordUsage(usage);
              notify();
            },
          },
          [{ role: "user", content: prompt }],
        );
        answer = result.answer;
        settle("done");
      } catch (err) {
        // Drop a placeholder that never received anything.
        const last = messages[messages.length - 1];
        if (last?.role === "assistant" && last.content === "" && !last.tool_calls?.length) messages.pop();
        if (timedOut) {
          error = `Stopped after ${Math.round(timeoutMs / 60_000)} minutes without finishing.`;
          settle("timed-out");
        } else if (controller.signal.aborted) {
          error = "Cancelled.";
          settle("cancelled");
        } else {
          error = err instanceof Error ? err.message : String(err);
          settle(err instanceof ProviderHttpError && err.status === 429 ? "rate-limited" : "failed");
        }
        timeline.push({ kind: "notice", text: error, tone: run.status === "cancelled" ? "muted" : "danger" });
      } finally {
        clearTimeout(timer);
      }
      notify();

      if (folder === null) return;
      try {
        await writeBenchResult(folder, {
          model: modelLabel(model),
          baseUrl: model.baseUrl.trim() || DEFAULT_BASE_URL,
          status: run.status,
          durationMs: (endedAt ?? now()) - startedAt,
          promptTokens,
          completionTokens,
          ...(priced ? { cost } : {}),
          toolCalls,
          body: run.status === "done" ? answer : (error ?? ""),
        });
      } catch (err) {
        timeline.push({
          kind: "notice",
          text: `Couldn't save this result: ${err instanceof Error ? err.message : String(err)}`,
          tone: "danger",
        });
        notify();
      }
    },
  };
  return run;
}

/**
 * Index the sources once for every model (rather than once per model, each
 * extracting a cold library), then build the shared system prompt from the
 * fresh index.
 */
export async function prepareBenchPrompt(settings: Settings): Promise<string> {
  try {
    await indexSources(settings.sourcesDir);
  } catch {
    // A missing or unreadable library leaves the source tools with nothing to find.
  }
  return buildBenchSystemPrompt(settings);
}

/**
 * Start every given model on the same prompt, system prompt, and tools. The
 * runs exist (queued) at once; the shared preparation — the system prompt
 * (see `prepareBenchPrompt`) and the results folder — happens before any
 * request goes out.
 */
export function startBench(options: StartBenchOptions): Bench {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  const createProvider = options.createProvider ?? providerFor;
  const runs = options.models.map((model) => makeRun({ ...model }, options.settings, timeoutMs, now));
  let folder: string | null = null;

  async function prepare(): Promise<string> {
    if (options.systemPrompt !== undefined) return options.systemPrompt;
    return prepareBenchPrompt(options.settings);
  }

  const done = (async () => {
    let systemPrompt: string;
    try {
      systemPrompt = await prepare();
    } catch (err) {
      // Nothing can run without the prompt; settle every run rather than leave them queued.
      const reason = `Couldn't prepare the run: ${err instanceof Error ? err.message : String(err)}`;
      for (const run of runs) run.abandon(reason);
      return;
    }
    let folderError: string | null = null;
    try {
      folder = await createBenchRunFolder(options.settings.benchDir, options.prompt, runs.length);
    } catch (err) {
      folderError = err instanceof Error ? err.message : String(err);
    }
    await Promise.all(
      runs.map(async (run) => {
        if (folderError !== null) {
          (run.timeline as TimelineEntry[]).push({
            kind: "notice",
            text: `Results won't be saved: ${folderError}`,
            tone: "danger",
          });
        }
        // Cancelled while preparing: no provider, no request.
        if (isSettled(run.status)) return;
        let provider: ChatProvider;
        try {
          provider = createProvider(run.model);
        } catch (err) {
          // One model's bad setup must not strand the others.
          run.abandon(`Couldn't start: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        await run.start(provider, systemPrompt, options.prompt, folder);
      }),
    );
  })();

  return {
    runs,
    done,
    folder: () => folder,
    cancelAll() {
      for (const run of runs) run.cancel();
    },
  };
}
