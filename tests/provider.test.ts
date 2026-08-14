import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIProvider, createProviderFromSettings, listModelInfos, listModels } from "../src/provider/openai.ts";
import type { ChatEvent, ChatMessage } from "../src/provider/types.ts";
import type { Settings } from "../src/store/settings.ts";

/**
 * Mocks an OpenAI-compatible /chat/completions endpoint with Bun.serve to
 * exercise the provider client without touching the network.
 */

const encoder = new TextEncoder();

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        const payload = JSON.stringify({ choices: [{ delta: { content: chunk } }] });
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        await Bun.sleep(5);
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

type MockBehavior =
  | "stream"
  | "crlf"
  | "json"
  | "json-tools"
  | "error"
  | "tools"
  | "models"
  | "models-error"
  | "usage"
  | "json-usage";

/** SSE events: some text, then a final usage-only chunk, then [DONE]. */
function usageSseResponse(): Response {
  const events = [
    { choices: [{ delta: { content: "Hi" } }] },
    { choices: [], usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 } },
  ];
  const body = events
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

let server: ReturnType<typeof Bun.serve> | null = null;
let lastRequest: { model?: string; messages?: ChatMessage[]; tools?: unknown; stream_options?: unknown } | null =
  null;
let seenAuth: string | null = null;

/** SSE events: some text, then a split tool call, then [DONE]. */
function toolSseResponse(): Response {
  const events = [
    { choices: [{ delta: { content: "Let me" } }] },
    { choices: [{ delta: { content: " check." } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "call_1", function: { name: "list_sessions", arguments: "" } }],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"' } }],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: 'n":1}' } }],
          },
        },
      ],
    },
    { choices: [{ delta: {} }] },
  ];
  const body = events
    .map((e) => `data: ${JSON.stringify(e)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function startServer(behavior: MockBehavior): Promise<string> {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        seenAuth = req.headers.get("authorization");
        if (behavior === "models-error") {
          return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "gpt-4o-mini",
                name: "GPT-4o Mini",
                context_length: 128000,
                pricing: { prompt: "0.00000015", completion: "0.0000006" },
              },
              { id: "gpt-4o" },
              { id: "" },
              {},
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      seenAuth = req.headers.get("authorization");
      lastRequest = (await req.json()) as {
        model?: string;
        messages?: ChatMessage[];
        tools?: unknown;
        stream_options?: unknown;
      };

      if (behavior === "error") {
        return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 401 });
      }
      if (behavior === "crlf") {
        const payload = JSON.stringify({ choices: [{ delta: { content: "CRLF reply" } }] });
        return new Response(`data: ${payload}\r\n\r\ndata: [DONE]\r\n\r\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (behavior === "json") {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "plain reply" } }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (behavior === "json-tools") {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "list_sessions", arguments: '{"n":1}' },
                    },
                  ],
                },
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (behavior === "json-usage") {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "plain reply" } }],
            usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (behavior === "tools") {
        return toolSseResponse();
      }
      if (behavior === "usage") {
        return usageSseResponse();
      }
      return sseResponse(["Hel", "lo ", "world"]);
    },
  });
  return `http://localhost:${server.port}/v1`;
}

async function collect(provider: ReturnType<typeof createOpenAIProvider>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const event of provider.streamChat([{ role: "user", content: "hi" }])) {
    if (event.type === "text") chunks.push(event.delta);
  }
  return chunks;
}

afterEach(() => {
  server?.stop();
  server = null;
  lastRequest = null;
  seenAuth = null;
  delete process.env["SCRIBE_TEST_KEY"];
});

describe("provider client", () => {
  test("streams SSE deltas in order", async () => {
    const baseUrl = await startServer("stream");
    const provider = createOpenAIProvider({ baseUrl, model: "gpt-test", apiKey: "test-key" });
    expect(await collect(provider)).toEqual(["Hel", "lo ", "world"]);
    expect(lastRequest?.model).toBe("gpt-test");
    expect(lastRequest?.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(seenAuth).toBe("Bearer test-key");
  });

  test("accepts CRLF-delimited SSE events", async () => {
    const baseUrl = await startServer("crlf");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });
    expect(await collect(provider)).toEqual(["CRLF reply"]);
  });

  test("falls back to a plain JSON response", async () => {
    const baseUrl = await startServer("json");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });
    expect(await collect(provider)).toEqual(["plain reply"]);
  });

  test("normalizes tool calls from a non-streaming JSON response", async () => {
    const baseUrl = await startServer("json-tools");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });
    const events: ChatEvent[] = [];
    for await (const event of provider.streamChat([{ role: "user", content: "hi" }])) events.push(event);

    expect(events).toEqual([
      {
        type: "tool_call",
        toolCall: { index: 0, id: "call_1", name: "list_sessions", arguments: '{"n":1}' },
      },
    ]);
  });

  test("throws a readable error on non-2xx", async () => {
    const baseUrl = await startServer("error");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });
    await expect(collect(provider)).rejects.toThrow(/401/);
  });

  test("createProviderFromSettings resolves the key from its env var", async () => {
    const baseUrl = await startServer("stream");
    process.env["SCRIBE_TEST_KEY"] = "secret-value";
    const settings: Settings = {
      campaignsDir: "/tmp/x",
      oneshotsDir: "/tmp/o",
      sourcesDir: "/tmp/s",
      baseUrl,
      model: "env-model",
      apiKeyEnv: "SCRIBE_TEST_KEY",
    };
    const provider = createProviderFromSettings(settings);
    await collect(provider);
    expect(seenAuth).toBe("Bearer secret-value");
  });

  test("streams tool-call deltas and accumulates arguments", async () => {
    const baseUrl = await startServer("tools");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });

    const events: { type: string; delta?: string; toolCall?: unknown }[] = [];
    for await (const event of provider.streamChat([{ role: "user", content: "hi" }])) {
      events.push(event);
    }

    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual([
      "Let me",
      " check.",
    ]);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(3);
    expect(toolCalls[0]!.toolCall).toMatchObject({ index: 0, id: "call_1", name: "list_sessions" });
    // arguments arrive in fragments
    const args = toolCalls.map((e) => (e as { toolCall: { arguments?: string } }).toolCall.arguments).join("");
    expect(args).toBe('{"n":1}');
  });

  test("sends tool definitions in the request when provided", async () => {
    const baseUrl = await startServer("stream");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });
    await collect(provider);
    // no tools by default
    expect(lastRequest?.tools).toBeUndefined();

    const toolDef = {
      type: "function" as const,
      function: { name: "list_sessions", description: "x", parameters: { type: "object" } },
    };
    const withTools: ChatEvent[] = [];
    for await (const event of provider.streamChat([{ role: "user", content: "hi" }], { tools: [toolDef] })) {
      withTools.push(event);
    }
    expect(lastRequest?.tools).toEqual([toolDef]);
    expect(withTools.length).toBeGreaterThan(0);
  });

  test("listModels fetches and sorts ids, dropping entries without one", async () => {
    const baseUrl = await startServer("models");
    const models = await listModels({ baseUrl, apiKey: "test-key" });
    expect(models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(seenAuth).toBe("Bearer test-key");
  });

  test("listModels throws a readable error on non-2xx", async () => {
    const baseUrl = await startServer("models-error");
    await expect(listModels({ baseUrl, apiKey: "k" })).rejects.toThrow(/401/);
  });

  test("listModelInfos reads name, context length, and pricing when present", async () => {
    const baseUrl = await startServer("models");
    const infos = await listModelInfos({ baseUrl, apiKey: "k" });
    expect(infos).toEqual([
      { id: "gpt-4o" },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        contextLength: 128000,
        pricing: { promptPerToken: 0.00000015, completionPerToken: 0.0000006 },
      },
    ]);
  });

  test("requests stream_options.include_usage on every streaming request", async () => {
    const baseUrl = await startServer("stream");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });
    await collect(provider);
    expect(lastRequest?.stream_options).toEqual({ include_usage: true });
  });

  test("yields a usage event parsed from the final SSE chunk", async () => {
    const baseUrl = await startServer("usage");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });
    const events: ChatEvent[] = [];
    for await (const event of provider.streamChat([{ role: "user", content: "hi" }])) events.push(event);

    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta)).toEqual(["Hi"]);
    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toMatchObject({
      type: "usage",
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    });
  });

  test("yields a usage event from the non-streaming JSON fallback", async () => {
    const baseUrl = await startServer("json-usage");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });
    const events: ChatEvent[] = [];
    for await (const event of provider.streamChat([{ role: "user", content: "hi" }])) events.push(event);

    const usageEvent = events.find((e) => e.type === "usage");
    expect(usageEvent).toMatchObject({
      type: "usage",
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });
  });
});
