import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { minimumCost, startBench, type BenchModel, type BenchRun } from "../src/bench/run.ts";
import { ProviderHttpError } from "../src/provider/openai.ts";
import type { ChatEvent, ChatMessage, ChatProvider } from "../src/provider/types.ts";
import { createBenchRunFolder, writeBenchResult } from "../src/store/bench.ts";
import { parseFrontmatter } from "../src/store/frontmatter.ts";
import type { Settings } from "../src/store/settings.ts";

let dir: string;
let settings: Settings;
let realConfigDir: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scribe-bench-"));
  realConfigDir = process.env["SCRIBE_CONFIG_DIR"];
  process.env["SCRIBE_CONFIG_DIR"] = join(dir, "config");
  settings = {
    campaignsDir: join(dir, "Scribe"),
    oneshotsDir: join(dir, "Scribe", "One-Shots"),
    sourcesDir: join(dir, "Scribe", "Sources"),
    benchDir: join(dir, "Scribe", "Bench"),
  };
});

afterEach(async () => {
  if (realConfigDir === undefined) delete process.env["SCRIBE_CONFIG_DIR"];
  else process.env["SCRIBE_CONFIG_DIR"] = realConfigDir;
  await rm(dir, { recursive: true, force: true });
});

let nextId = 1;
function model(name: string, extra: Partial<BenchModel> = {}): BenchModel {
  return { id: nextId++, baseUrl: "http://localhost:1/v1", apiKeyEnv: "", model: name, check: "ready", ...extra };
}

const text = (delta: string): ChatEvent => ({ type: "text", delta });

/** Replies with `reply` after `delayMs`, recording the systems prompts it saw. */
function replying(reply: string, delayMs = 0, seen?: string[]): ChatProvider {
  return {
    async *streamChat(messages: ChatMessage[], options) {
      seen?.push(messages[0]?.content ?? "");
      if (delayMs > 0) await Bun.sleep(delayMs);
      options?.signal?.throwIfAborted();
      yield { type: "usage", usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
      yield text(reply);
    },
  };
}

/** Never answers until aborted. */
const hanging: ChatProvider = {
  async *streamChat(_messages, options) {
    await new Promise<void>((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal!.reason));
    });
    yield text("unreachable");
  },
};

function waitFor(run: BenchRun, predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (predicate()) return resolve();
    const stop = run.subscribe(() => {
      if (predicate()) {
        stop();
        resolve();
      }
    });
  });
}

describe("bench store", () => {
  test("a run folder holds the prompt, and the same model twice gets two files", async () => {
    const folder = await createBenchRunFolder(join(dir, "Bench"), "Plan a heist on a sky-barge!", 2);
    expect(folder).toContain("plan-a-heist-on-a-sky-barge");
    const second = await createBenchRunFolder(join(dir, "Bench"), "Plan a heist on a sky-barge!", 2);
    expect(second).not.toBe(folder);

    const prompt = parseFrontmatter(await readFile(join(folder, "prompt.md"), "utf8"));
    expect(prompt.data["models"]).toBe("2");
    expect(prompt.body.trim()).toBe("Plan a heist on a sky-barge!");

    const result = {
      model: "openai/gpt-4o",
      baseUrl: "https://openrouter.ai/api/v1",
      status: "done",
      durationMs: 1234.4,
      promptTokens: 10,
      completionTokens: 5,
      cost: 0.0012,
      toolCalls: 2,
      body: "# The Sky-Barge Job",
    };
    const first = await writeBenchResult(folder, result);
    const again = await writeBenchResult(folder, result);
    expect(first).not.toBe(again);
    const parsed = parseFrontmatter(await readFile(first, "utf8"));
    expect(parsed.data).toMatchObject({ model: "openai/gpt-4o", status: "done", durationMs: "1234", cost: "0.001200" });
    expect(parsed.body.trim()).toBe("# The Sky-Barge Job");
  });

  test("a model named 'prompt' can't overwrite the run's prompt file", async () => {
    const folder = await createBenchRunFolder(join(dir, "Bench"), "x", 1);
    const path = await writeBenchResult(folder, {
      model: "prompt",
      baseUrl: "",
      status: "done",
      durationMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      toolCalls: 0,
      body: "answer",
    });
    expect(path).not.toBe(join(folder, "prompt.md"));
    expect(await readFile(join(folder, "prompt.md"), "utf8")).toContain("x");
  });
});

describe("bench runs", () => {
  test("every model runs in parallel on the same system prompt and writes its result", async () => {
    const seen: string[] = [];
    const providers = new Map<string, ChatProvider>([
      ["a", replying("Answer A", 40, seen)],
      ["b", replying("Answer B", 40, seen)],
    ]);
    const started = Date.now();
    const bench = startBench({
      prompt: "Plan a one-shot",
      models: [model("a", { info: { id: "a", pricing: { promptPerToken: 0.000001, completionPerToken: 0.000002 } } }), model("b")],
      settings,
      createProvider: (m) => providers.get(m.model)!,
    });
    expect(bench.runs.map((run) => run.status)).toEqual(["queued", "queued"]);
    await bench.done;

    // Sequential runs would take at least 80 ms.
    expect(Date.now() - started).toBeLessThan(80 + 200);
    expect(bench.runs.map((run) => run.status)).toEqual(["done", "done"]);
    expect(bench.runs.map((run) => run.answer)).toEqual(["Answer A", "Answer B"]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]!);
    expect(seen[0]).toContain("Do not ask the user anything.");

    expect(bench.runs[0]!.cost).toBeCloseTo(1000 * 0.000001 + 100 * 0.000002);
    expect(bench.runs[1]!.cost).toBeUndefined();

    const folder = bench.folder()!;
    const files = (await readdir(folder)).sort();
    expect(files).toEqual(["a.md", "b.md", "prompt.md"]);
    expect(await readFile(join(folder, "a.md"), "utf8")).toContain("Answer A");
  });

  test("the timeline shows the reply only after the Thought row it followed", async () => {
    const bench = startBench({ prompt: "hi", models: [model("a")], settings, createProvider: () => replying("Hello") });
    await bench.done;
    const kinds = bench.runs[0]!.timeline.map((entry) =>
      entry.kind === "activity" ? `activity:${entry.activity.past}` : `${entry.kind}:${"message" in entry ? entry.message.role : ""}`,
    );
    expect(kinds).toEqual(["message:user", "message:assistant", "activity:Thought", "shown:assistant"]);
    const thought = bench.runs[0]!.timeline[2];
    expect(thought?.kind === "activity" && thought.activity.endedAt !== undefined).toBe(true);
  });

  test("tool calls record activity rows with the tool's labels", async () => {
    let turn = 0;
    const provider: ChatProvider = {
      async *streamChat() {
        if (turn++ === 0) {
          yield { type: "tool_call", toolCall: { index: 0, id: "c1", name: "list_sources", arguments: "{}" } };
          return;
        }
        yield text("Done.");
      },
    };
    const bench = startBench({ prompt: "hi", models: [model("a")], settings, createProvider: () => provider });
    await bench.done;
    const run = bench.runs[0]!;
    expect(run.status).toBe("done");
    expect(run.toolCalls).toBe(1);
    const pasts = run.timeline.flatMap((entry) => (entry.kind === "activity" ? [entry.activity.past] : []));
    expect(pasts).toEqual(["Thought", expect.not.stringMatching(/^list_sources$/), "Thought"]);
  });

  test("cancelling one run leaves the others running", async () => {
    const bench = startBench({
      prompt: "hi",
      models: [model("slow"), model("fast")],
      settings,
      createProvider: (m) => (m.model === "slow" ? hanging : replying("Fast", 20)),
    });
    const slow = bench.runs[0]!;
    await waitFor(slow, () => slow.status === "thinking");
    slow.cancel();
    await bench.done;
    expect(slow.status).toBe("cancelled");
    expect(bench.runs[1]!.status).toBe("done");
    expect(await readFile(join(bench.folder()!, "slow.md"), "utf8")).toContain("status: cancelled");
  });

  test("cancelling before anything starts settles every run without a request", async () => {
    let requests = 0;
    const bench = startBench({
      prompt: "hi",
      models: [model("a"), model("b")],
      settings,
      createProvider: () => {
        requests++;
        return replying("x");
      },
    });
    bench.cancelAll();
    await bench.done;
    expect(bench.runs.map((run) => run.status)).toEqual(["cancelled", "cancelled"]);
    expect(requests).toBe(0);
  });

  test("a model whose provider can't be created fails alone; the rest still run", async () => {
    const bench = startBench({
      prompt: "hi",
      models: [model("broken"), model("fine")],
      settings,
      createProvider: (m) => {
        if (m.model === "broken") throw new Error("no such provider");
        return replying("Fine");
      },
    });
    await bench.done;
    const [broken, fine] = bench.runs;
    expect(broken!.status).toBe("failed");
    expect(broken!.error).toBe("Couldn't start: no such provider");
    expect(broken!.timeline.at(-1)).toEqual({ kind: "notice", text: "Couldn't start: no such provider", tone: "danger" });
    expect(fine!.status).toBe("done");
  });

  test("a prebuilt system prompt is used as given", async () => {
    const seen: string[] = [];
    const bench = startBench({
      prompt: "hi",
      systemPrompt: "PREBUILT",
      models: [model("a")],
      settings,
      createProvider: () => replying("ok", 0, seen),
    });
    await bench.done;
    expect(seen).toEqual(["PREBUILT"]);
  });

  test("a run past its timeout is stopped and marked timed out", async () => {
    const bench = startBench({ prompt: "hi", models: [model("a")], settings, createProvider: () => hanging, timeoutMs: 30 });
    await bench.done;
    expect(bench.runs[0]!.status).toBe("timed-out");
    expect(bench.runs[0]!.error).toContain("Stopped after");
  });

  test("a 429 shows as rate limited, other failures as failed", async () => {
    const failing = (error: Error): ChatProvider => ({
      async *streamChat() {
        throw error;
      },
    });
    const bench = startBench({
      prompt: "hi",
      models: [model("limited"), model("broken")],
      settings,
      createProvider: (m) =>
        failing(m.model === "limited" ? new ProviderHttpError("Chat request failed (429): slow down", 429) : new Error("boom")),
    });
    await bench.done;
    expect(bench.runs.map((run) => run.status)).toEqual(["rate-limited", "failed"]);
    expect(bench.runs[1]!.timeline.at(-1)).toEqual({ kind: "notice", text: "boom", tone: "danger" });
  });

  test("the minimum cost is the first request's input at the prompt price", () => {
    expect(minimumCost(model("a", { info: { id: "a", pricing: { promptPerToken: 0.000002 } } }), 4000)).toBeCloseTo(0.002);
    expect(minimumCost(model("b"), 4000)).toBeUndefined();
  });
});
