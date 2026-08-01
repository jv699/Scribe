/**
 * OpenAI-compatible chat client. One implementation covers OpenAI, OpenRouter,
 * Ollama, LM Studio, vLLM — any endpoint speaking the /chat/completions
 * protocol. Streams SSE deltas by default, with a non-stream fallback.
 */
import type { Settings } from "../store/settings.ts";
import type { ChatMessage, ChatProvider } from "./types.ts";

export interface OpenAIProviderOptions {
  /** Base URL without a trailing slash, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  model: string;
  apiKey: string;
}

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";

/** Yield the `content` deltas from a Server-Sent-Events response body. */
async function* streamSSE(response: Response): AsyncGenerator<string> {
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
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) yield delta;
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
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model: options.model, messages, stream: true }),
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
          choices?: { message?: { content?: string } }[];
        };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content === "string") yield content;
      }
    },
  };
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
