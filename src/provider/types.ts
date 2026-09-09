export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Assistant messages that made tool calls must carry them for the next turn. */
  tool_calls?: ToolCall[];
  /** Present on role "tool" messages, linking the result to its call. */
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema for the arguments. */
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  tools?: ToolDefinition[];
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; toolCall: ToolCallDelta }
  | { type: "usage"; usage: UsageInfo };

/** Per-token prices in US dollars. */
export interface ModelPricing {
  promptPerToken?: number;
  completionPerToken?: number;
}

/**
 * Model metadata from a provider's `GET /models` listing. Only `id` is
 * guaranteed by the OpenAI schema — the rest are populated opportunistically
 * when a provider includes them (OpenRouter does; OpenAI/Ollama/LM Studio
 * generally don't).
 */
export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  pricing?: ModelPricing;
}

export interface ChatProvider {
  streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatEvent>;
}
