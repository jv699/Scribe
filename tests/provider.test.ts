import { afterEach, describe, expect, test } from "bun:test";
import { createOpenAIProvider, createProviderFromSettings } from "../src/provider/openai.ts";
import type { ChatMessage } from "../src/provider/types.ts";
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

type MockBehavior = "stream" | "json" | "error";

let server: ReturnType<typeof Bun.serve> | null = null;
let lastRequest: { model?: string; messages?: ChatMessage[] } | null = null;
let seenAuth: string | null = null;

async function startServer(behavior: MockBehavior): Promise<string> {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      seenAuth = req.headers.get("authorization");
      lastRequest = (await req.json()) as { model?: string; messages?: ChatMessage[] };

      if (behavior === "error") {
        return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 401 });
      }
      if (behavior === "json") {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "plain reply" } }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return sseResponse(["Hel", "lo ", "world"]);
    },
  });
  return `http://localhost:${server.port}/v1`;
}

async function collect(provider: ReturnType<typeof createOpenAIProvider>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of provider.streamChat([{ role: "user", content: "hi" }])) {
    chunks.push(chunk);
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

  test("falls back to a plain JSON response", async () => {
    const baseUrl = await startServer("json");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });
    expect(await collect(provider)).toEqual(["plain reply"]);
  });

  test("throws a readable error on non-2xx", async () => {
    const baseUrl = await startServer("error");
    const provider = createOpenAIProvider({ baseUrl, model: "m", apiKey: "k" });
    await expect(collect(provider)).rejects.toThrow(/401/);
  });

  test("createProviderFromSettings resolves the key from its env var", async () => {
    const baseUrl = await startServer("stream");
    process.env["SCRIBE_TEST_KEY"] = "secret-value";
    const settings: Settings = { campaignsDir: "/tmp/x", baseUrl, model: "env-model", apiKeyEnv: "SCRIBE_TEST_KEY" };
    const provider = createProviderFromSettings(settings);
    await collect(provider);
    expect(seenAuth).toBe("Bearer secret-value");
  });
});
