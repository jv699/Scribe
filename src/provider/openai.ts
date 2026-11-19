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
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Name of the env var the key came from, used only to explain failures. */
  apiKeyEnv?: string;
}

/** A provider answered with a non-2xx status; `status` lets callers spot rate limits. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
// Compatibility fallback for configs without a model; revisit as models change.
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

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
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

async function* streamSSE(response: Response): AsyncGenerator<ChatEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";

      for (const event of events) {
        for (const line of event.split(/\r?\n/)) {
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
            // Providers may report usage on a final chunk without choices.
            if (json.usage) yield { type: "usage", usage: toUsageInfo(json.usage) };
          } catch {
            // Ignore malformed keep-alives and partial lines.
          }
        }
      }
    }
  } finally {
    // A consumer that stops early must not leave the response streaming.
    await reader.cancel().catch(() => {});
  }
}

/**
 * The provider's own words for a failed request: the `message` out of an
 * OpenAI-style error body, or the start of the body when it isn't one.
 */
async function errorDetail(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    // Some compatibility layers wrap the error object in an array.
    const body = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: unknown; message?: unknown } | null;
    const error = body?.error;
    if (typeof error === "string" && error !== "") return error;
    const message = (error as { message?: unknown } | null | undefined)?.message ?? body?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {
    // Not JSON: fall through to the raw body.
  }
  return text.slice(0, 200);
}

/** Explain an auth rejection in terms of what the user can change in Settings. */
function authHint(options: OpenAIProviderOptions): string {
  if (!options.apiKeyEnv) {
    return "No API key is configured. Open Settings and set the API key environment variable.";
  }
  if (options.apiKey === "") {
    return `The environment variable ${options.apiKeyEnv} is not set. Export it before starting Scribe, or change it in Settings.`;
  }
  return `The provider rejected the API key from ${options.apiKeyEnv}. Check the key, or change it in Settings.`;
}

export function createOpenAIProvider(options: OpenAIProviderOptions): ChatProvider {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

  return {
    async *streamChat(messages: ChatMessage[], chatOptions?: ChatOptions): AsyncGenerator<ChatEvent> {
      const body: Record<string, unknown> = {
        model: options.model,
        messages,
        stream: true,
        // Unsupported compatible providers ignore this field.
        stream_options: { include_usage: true },
      };
      if (chatOptions?.tools?.length) body["tools"] = chatOptions.tools;

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
          ...(chatOptions?.signal ? { signal: chatOptions.signal } : {}),
        });
      } catch (err) {
        if (chatOptions?.signal?.aborted) throw err;
        throw new Error(
          `Couldn't reach ${baseUrl}. Check the base URL in Settings and that the provider is running.`,
        );
      }

      if (!response.ok) {
        const failure = `Chat request failed (${response.status}): ${await errorDetail(response)}`;
        if (response.status === 401 || response.status === 403) {
          throw new ProviderHttpError(`${authHint(options)} ${failure}`, response.status);
        }
        throw new ProviderHttpError(failure, response.status);
      }

      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        yield* streamSSE(response);
      } else {
        // Support older endpoints and proxies without SSE.
        const json = (await response.json()) as {
          choices?: { message?: { content?: string; tool_calls?: RawToolCall[] } }[];
          usage?: RawUsage;
        };
        const message = json.choices?.[0]?.message;
        if (message?.content) yield { type: "text", delta: message.content };
        for (const [index, tc] of (message?.tool_calls ?? []).entries()) {
          const toolCall: ToolCallDelta = {
            index,
            ...(tc.id !== undefined ? { id: tc.id } : {}),
            ...(tc.function?.name !== undefined ? { name: tc.function.name } : {}),
            ...(tc.function?.arguments !== undefined ? { arguments: tc.function.arguments } : {}),
          };
          yield { type: "tool_call", toolCall };
        }
        if (json.usage) yield { type: "usage", usage: toUsageInfo(json.usage) };
      }
    },
  };
}

/**
 * Prove a base URL, key, and model work together by making the request a chat
 * would and stopping at the first event of the reply. Rejects with the same
 * messages a failed chat shows.
 */
export async function testConnection(options: OpenAIProviderOptions, signal?: AbortSignal): Promise<void> {
  const reply = createOpenAIProvider(options).streamChat(
    [{ role: "user", content: "Reply with OK." }],
    signal ? { signal } : undefined,
  );
  for await (const _ of reply) break;
}

interface RawModel {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
}

/**
 * A per-token price, or undefined when there isn't a real one. OpenRouter
 * lists routers (whose model, and so price, is picked per request) at "-1";
 * read as a number, that bills every token at minus a dollar.
 */
function listedPrice(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const price = Number(raw);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
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
    throw new Error(`Failed to list models (${response.status}): ${await errorDetail(response)}`);
  }

  const json = (await response.json()) as { data?: RawModel[] };
  const infos: ModelInfo[] = [];
  for (const entry of json.data ?? []) {
    if (typeof entry.id !== "string" || entry.id === "") continue;
    const info: ModelInfo = { id: entry.id };
    if (typeof entry.name === "string" && entry.name !== "") info.name = entry.name;
    if (typeof entry.context_length === "number") info.contextLength = entry.context_length;

    const promptPrice = listedPrice(entry.pricing?.prompt);
    const completionPrice = listedPrice(entry.pricing?.completion);
    const pricing: ModelInfo["pricing"] = {
      ...(promptPrice !== undefined ? { promptPerToken: promptPrice } : {}),
      ...(completionPrice !== undefined ? { completionPerToken: completionPrice } : {}),
    };
    if (Object.keys(pricing).length > 0) info.pricing = pricing;

    infos.push(info);
  }
  return infos.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listModels(options: { baseUrl: string; apiKey: string }): Promise<string[]> {
  return (await listModelInfos(options)).map((info) => info.id);
}

/** The key a named env var holds; no name, or an unset variable, is no key. */
export function apiKeyFrom(apiKeyEnv: string | undefined): string {
  const name = apiKeyEnv?.trim();
  return name ? (process.env[name] ?? "") : "";
}

export function createProviderFromSettings(settings: Settings): ChatProvider {
  const apiKey = apiKeyFrom(settings.apiKeyEnv);
  return createOpenAIProvider({
    baseUrl: settings.baseUrl ?? DEFAULT_BASE_URL,
    model: settings.model ?? DEFAULT_MODEL,
    apiKey,
    ...(settings.apiKeyEnv ? { apiKeyEnv: settings.apiKeyEnv } : {}),
  });
}
