import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, type AgentTool } from "../src/agent/loop.ts";
import {
  configureLogging,
  log,
  logError,
  loggingEnabled,
  logLevelFrom,
  registerSecret,
  shorten,
  type LogLevel,
} from "../src/log.ts";
import { makeBehindTheNameClient } from "../src/names/behind-the-name.ts";
import { apiKeyFrom, createOpenAIProvider } from "../src/provider/openai.ts";
import type { ChatProvider } from "../src/provider/types.ts";

let dir: string;
let lines: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "scribe-log-"));
  lines = [];
});

afterEach(async () => {
  configureLogging({ level: "off", dir });
  await rm(dir, { recursive: true, force: true });
});

/** Turn logging on with writes captured in `lines`. */
function capture(level: LogLevel = "debug"): void {
  configureLogging({ level, dir, write: (_path, line) => lines.push(line) });
}

const events = (): Record<string, unknown>[] => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
const event = (name: string): Record<string, unknown> | undefined => events().find((e) => e["event"] === name);

/** One tool call, then a text answer. */
function toolThenAnswer(args: string): ChatProvider {
  return {
    async *streamChat(messages) {
      if (messages.some((m) => m.role === "tool")) {
        yield { type: "text", delta: "Done." };
        yield { type: "usage", usage: { promptTokens: 10, completionTokens: 2 } };
        return;
      }
      yield { type: "tool_call", toolCall: { index: 0, id: "c1", name: "update_notes", arguments: args } };
    },
  } as ChatProvider;
}

const updateNotes: AgentTool = {
  definition: {
    type: "function",
    function: { name: "update_notes", description: "", parameters: { type: "object", properties: {} } },
  },
  execute: () => "Saved the notes about the vampire's secret lair.",
};

describe("log level", () => {
  test("comes from --debug, --debug=verbose, or SCRIBE_DEBUG, and is off otherwise", () => {
    expect(logLevelFrom([], {})).toBe("off");
    expect(logLevelFrom(["--debug"], {})).toBe("debug");
    expect(logLevelFrom(["--debug=verbose"], {})).toBe("verbose");
    expect(logLevelFrom([], { SCRIBE_DEBUG: "1" })).toBe("debug");
    expect(logLevelFrom([], { SCRIBE_DEBUG: "Verbose" })).toBe("verbose");
    for (const off of ["0", "false", "off", ""]) expect(logLevelFrom([], { SCRIBE_DEBUG: off })).toBe("off");
    // The flag wins over the environment.
    expect(logLevelFrom(["--debug"], { SCRIBE_DEBUG: "verbose" })).toBe("debug");
  });
});

describe("log file", () => {
  test("off writes nothing and makes no folder", async () => {
    expect(configureLogging({ level: "off", dir: join(dir, "logs") })).toBeNull();
    log("anything", { a: 1 });
    expect(loggingEnabled()).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  test("events go to <dir>/<date>.log as JSON lines", async () => {
    const logs = join(dir, "logs");
    const file = configureLogging({ level: "debug", dir: logs, now: new Date(2026, 10, 24, 9) });
    expect(file).toBe(join(logs, "2026-11-24.log"));
    log("first", { n: 1 });
    logError("second", new Error("boom"), { where: "here" });

    const written = (await readFile(file!, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({ event: "first", n: 1 });
    expect(typeof written[0]!["time"]).toBe("string");
    expect(written[1]).toMatchObject({ event: "second", where: "here", error: "boom", errorName: "Error" });
  });

  test("only dated logs past the retention window are deleted", async () => {
    for (const name of ["2026-11-10.log", "2026-11-17.log", "2026-11-23.log", "notes.txt"]) {
      await writeFile(join(dir, name), "x");
    }
    configureLogging({ level: "debug", dir, now: new Date(2026, 10, 24, 9) });
    expect((await readdir(dir)).sort()).toEqual(["2026-11-17.log", "2026-11-23.log", "notes.txt"]);
  });

  test("a failed write turns logging off instead of throwing", () => {
    configureLogging({
      level: "debug",
      dir,
      write: () => {
        throw new Error("disk full");
      },
    });
    expect(() => log("x")).not.toThrow();
    expect(loggingEnabled()).toBe(false);
  });

  test("long strings are shortened, saying how long they were", () => {
    capture();
    log("big", { text: "y".repeat(2000) });
    expect(String(event("big")?.["text"])).toEndWith("… (2000 chars)");
    expect(shorten("short")).toBe("short");
  });
});

describe("secrets", () => {
  test("a registered secret is masked wherever it appears", () => {
    capture();
    registerSecret("sk-test-0123456789abcdef");
    log("oops", { detail: "Bearer sk-test-0123456789abcdef was rejected", nested: { list: ["sk-test-0123456789abcdef"] } });
    expect(lines.join("")).not.toContain("sk-test-0123456789abcdef");
    expect(lines.join("")).toContain("[redacted]");
  });

  test("any key read through apiKeyFrom is masked", () => {
    capture();
    process.env["SCRIBE_TEST_LOG_KEY"] = "or-live-ffffeeeeddddcccc";
    try {
      apiKeyFrom("SCRIBE_TEST_LOG_KEY");
      log("leak", { text: "key=or-live-ffffeeeeddddcccc" });
    } finally {
      delete process.env["SCRIBE_TEST_LOG_KEY"];
    }
    expect(lines.join("")).not.toContain("or-live-ffffeeeeddddcccc");
  });

  test("a Behind the Name request is logged without the key or URL", async () => {
    capture();
    const client = makeBehindTheNameClient({
      apiKey: "btn-secret-key-1234",
      minIntervalMs: 0,
      fetch: async () => Response.json({ names: ["Aoife", "Kelly"] }),
    });
    await client.random({ usage: "iri", gender: "female", number: 1, surname: true });

    expect(event("names.btn")).toMatchObject({ usage: "iri", gender: "f", surname: true, outcome: "ok", names: ["Aoife", "Kelly"] });
    expect(lines.join("")).not.toContain("btn-secret-key-1234");
    expect(lines.join("")).not.toContain("behindthename.com");
  });

  test("Behind the Name's own error is logged, which is how a bad usage code shows up", async () => {
    capture();
    const client = makeBehindTheNameClient({
      apiKey: "k-0000000000",
      minIntervalMs: 0,
      fetch: async () => Response.json({ error_code: 52, error: "invalid usage" }),
    });
    expect(await client.random({ usage: "xyz", gender: "any", number: 6, surname: false })).toBeNull();
    expect(event("names.btn")).toMatchObject({ usage: "xyz", outcome: "unexpected-body", error: "invalid usage", errorCode: 52 });
  });
});

describe("what gets logged", () => {
  test("agent turns and tools are logged without content at the debug level", async () => {
    capture("debug");
    await runAgent({ provider: toolThenAnswer('{"notes":"The vampire hides in the crypt."}'), tools: [updateNotes] }, [
      { role: "user", content: "Save my notes" },
    ]);

    const tool = event("agent.tool");
    expect(tool).toMatchObject({ tool: "update_notes", args: ["notes"], failed: false });
    expect(tool).not.toHaveProperty("arguments");
    expect(tool).not.toHaveProperty("result");
    expect(lines.join("")).not.toContain("vampire");
    const turns = events().filter((e) => e["event"] === "agent.turn");
    expect(turns.map((t) => t["toolCalls"])).toEqual([["update_notes"], []]);
    expect(turns[1]).toMatchObject({ usage: { promptTokens: 10, completionTokens: 2 } });
  });

  test("verbose adds the tool's arguments and result", async () => {
    capture("verbose");
    await runAgent({ provider: toolThenAnswer('{"notes":"The vampire hides in the crypt."}'), tools: [updateNotes] }, [
      { role: "user", content: "Save my notes" },
    ]);
    expect(event("agent.tool")).toMatchObject({
      arguments: '{"notes":"The vampire hides in the crypt."}',
      result: "Saved the notes about the vampire's secret lair.",
    });
  });

  test("a failed tool records Scribe's error even at the debug level", async () => {
    capture("debug");
    const broken: AgentTool = {
      ...updateNotes,
      execute: () => {
        throw new Error("no session 9");
      },
    };
    await runAgent({ provider: toolThenAnswer("{}"), tools: [broken] }, [{ role: "user", content: "x" }]);
    expect(event("agent.tool")).toMatchObject({ failed: true, error: "Tool error: no session 9" });
  });

  test("a failed chat request logs its status and the provider's message, with the key masked", async () => {
    capture();
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: { message: "Rate limit reached for gpt-x" } }, { status: 429 }),
    });
    try {
      const provider = createOpenAIProvider({ baseUrl: `http://localhost:${server.port}/v1`, model: "gpt-x", apiKey: "sk-provider-key-998877" });
      await expect(async () => {
        for await (const _ of provider.streamChat([{ role: "user", content: "hi" }])) {
          // drain
        }
      }).toThrow();
    } finally {
      server.stop();
    }
    expect(event("chat.request")).toMatchObject({ model: "gpt-x", messages: 1, host: expect.stringContaining("localhost") });
    expect(event("chat.failed")).toMatchObject({ status: 429, detail: expect.stringContaining("Rate limit reached") });
    expect(lines.join("")).not.toContain("sk-provider-key-998877");
    expect(lines.join("")).not.toContain('"content":"hi"');
  });
});
