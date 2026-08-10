/**
 * OpenAI-compatible chat client. One implementation covers OpenAI, OpenRouter,
 * Ollama, LM Studio, vLLM — any endpoint speaking the /chat/completions
 * protocol. Streams SSE deltas (text + tool calls) by default, with a
 * non-stream fallback.
 */
import type { Settings } from "../store/settings.ts";
import type {
  ChatEvent,
  ChatMessage,
  ChatOptions,
  ChatProvider,
  ModelInfo,
  ToolCallDelta,
  UsageInfo,
} from "./types.ts";

export interface OpenAIProviderOptions {
  /** Base URL without a trailing slash, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// Fallback used only when settings/config omit a model. Not actively curated —
// revisit periodically as OpenAI's lineup moves on.
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

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

function toUsageInfo(raw: RawUsage): UsageInfo {
  return {
    promptTokens: raw.prompt_tokens ?? 0,
    completionTokens: raw.completion_tokens ?? 0,
    totalTokens: raw.total_tokens ?? 0,
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
          const json = JSON.parse(payload) as { choices?: StreamChoice[]; usage?: RawUsage };
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
          // Only providers that support `stream_options.include_usage` (requested
          // below) send this — usually on a final chunk with no choices.
          if (json.usage) yield { type: "usage", usage: toUsageInfo(json.usage) };
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
      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: true,
        // Widely supported (OpenAI, OpenRouter, Ollama, LM Studio, vLLM); providers
        // that don't recognize it just ignore it, so this is safe to send always.
        stream_options: { include_usage: true },
      };
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
          usage?: RawUsage;
        };
        const message = json.choices?.[0]?.message;
        if (message?.content) yield { type: "text", delta: message.content };
        for (const tc of message?.tool_calls ?? []) {
          yield { type: "tool_call", toolCall: tc };
        }
        if (json.usage) yield { type: "usage", usage: toUsageInfo(json.usage) };
      }
    },
  };
}

interface RawModel {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
}

/**
 * Fetch model metadata from an OpenAI-compatible `GET /models` endpoint. Only
 * `id` is part of the official schema; `name`, `context_length`, and
 * `pricing` are read when present (OpenRouter includes them, most other
 * providers don't) and simply omitted otherwise.
 */
export async function listModelInfos(options: { baseUrl: string; apiKey: string }): Promise<ModelInfo[]> {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/models`, {
    headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Failed to list models (${response.status}): ${detail.slice(0, 200)}`);
  }

  const json = (await response.json()) as { data?: RawModel[] };
  const infos: ModelInfo[] = [];
  for (const entry of json.data ?? []) {
    if (typeof entry.id !== "string" || entry.id === "") continue;
    const info: ModelInfo = { id: entry.id };
    if (typeof entry.name === "string" && entry.name !== "") info.name = entry.name;
    if (typeof entry.context_length === "number") info.contextLength = entry.context_length;

    const promptPrice = entry.pricing?.prompt !== undefined ? Number(entry.pricing.prompt) : undefined;
    const completionPrice = entry.pricing?.completion !== undefined ? Number(entry.pricing.completion) : undefined;
    const pricing: ModelInfo["pricing"] = {
      ...(promptPrice !== undefined && !Number.isNaN(promptPrice) ? { promptPerToken: promptPrice } : {}),
      ...(completionPrice !== undefined && !Number.isNaN(completionPrice) ? { completionPerToken: completionPrice } : {}),
    };
    if (Object.keys(pricing).length > 0) info.pricing = pricing;

    infos.push(info);
  }
  return infos.sort((a, b) => a.id.localeCompare(b.id));
}

/** Fetch available model ids from an OpenAI-compatible `GET /models` endpoint. */
export async function listModels(options: { baseUrl: string; apiKey: string }): Promise<string[]> {
  return (await listModelInfos(options)).map((info) => info.id);
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
