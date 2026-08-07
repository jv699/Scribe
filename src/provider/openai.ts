/**
 * OpenAI-compatible chat client. One implementation covers OpenAI, OpenRouter,
 * Ollama, LM Studio, vLLM — any endpoint speaking the /chat/completions
 * protocol. Streams SSE deltas (text + tool calls) by default, with a
 * non-stream fallback.
 */
import type { Settings } from "../store/settings.ts";
import type { ChatEvent, ChatMessage, ChatOptions, ChatProvider, ToolCallDelta } from "./types.ts";

export interface OpenAIProviderOptions {
  /** Base URL without a trailing slash, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";

interface StreamChoice {
  delta?: {
    content?: string;
    tool_calls?: {
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }[];
  };
}

/** Yield text + tool-call deltas from a Server-Sent-Events response body. */
async function* streamSSE(response: Response): AsyncGenerator<ChatEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by blank lines.
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      for (const line of event.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload) as { choices?: StreamChoice[] };
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) yield { type: "text", delta: delta.content };
          for (const tc of delta?.tool_calls ?? []) {
            const toolCall: ToolCallDelta = {
              index: tc.index ?? 0,
              ...(tc.id !== undefined ? { id: tc.id } : {}),
              ...(tc.function?.name !== undefined ? { name: tc.function.name } : {}),
              ...(tc.function?.arguments !== undefined ? { arguments: tc.function.arguments } : {}),
            };
            yield { type: "tool_call", toolCall };
          }
        } catch {
          // Malformed keep-alive or partial line — ignore.
        }
      }
    }
  }
}

export function createOpenAIProvider(options: OpenAIProviderOptions): ChatProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  return {
    async *streamChat(messages: ChatMessage[], chatOptions?: ChatOptions): AsyncGenerator<ChatEvent> {
      const body: Record<string, unknown> = { model: options.model, messages, stream: true };
      if (chatOptions?.tools?.length) body["tools"] = chatOptions.tools;

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Chat request failed (${response.status}): ${detail.slice(0, 200)}`);
      }

      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        yield* streamSSE(response);
      } else {
        // Non-streaming fallback (older endpoints / proxies).
        const json = (await response.json()) as {
          choices?: { message?: { content?: string; tool_calls?: ToolCallDelta[] } }[];
        };
        const message = json.choices?.[0]?.message;
        if (message?.content) yield { type: "text", delta: message.content };
        for (const tc of message?.tool_calls ?? []) {
          yield { type: "tool_call", toolCall: tc };
        }
      }
    },
  };
}

/** Fetch available model ids from an OpenAI-compatible `GET /models` endpoint. */
export async function listModels(options: { baseUrl: string; apiKey: string }): Promise<string[]> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to list models (${response.status}): ${detail.slice(0, 200)}`);
  }

  const json = (await response.json()) as { data?: { id?: string }[] };
  const ids = (json.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id !== "");
  return ids.sort((a, b) => a.localeCompare(b));
}

/** Build a provider from app settings, resolving the API key from its env var. */
export function createProviderFromSettings(settings: Settings): ChatProvider {
  const apiKey = settings.apiKeyEnv ? (process.env[settings.apiKeyEnv] ?? "") : "";
  return createOpenAIProvider({
    baseUrl: settings.baseUrl ?? DEFAULT_BASE_URL,
    model: settings.model ?? DEFAULT_MODEL,
    apiKey,
  });
}
