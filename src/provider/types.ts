/**
 * Provider abstraction: the single seam between the app and any model backend.
 * Phase 1 implemented text streaming; Phase 2 adds tool (function) calling so
 * the agent loop can read/write campaign files. Other providers (e.g.
 * Anthropic-native) implement the same interface without touching the UI.
 */
export type ChatRole = "system" | "user" | "assistant" | "tool";

/** A completed tool call (OpenAI shape — sent back with the assistant reply). */
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

/** OpenAI-style function tool description sent in the request. */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema describing the arguments. */
    parameters: Record<string, unknown>;
  };
}

export interface ChatOptions {
  tools?: ToolDefinition[];
}

/** Partial tool-call info streamed by the provider; the agent loop accumulates. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; toolCall: ToolCallDelta };

/**
 * Streams assistant output for a conversation. Yields text deltas and
 * tool-call fragments; throws on transport or HTTP errors so callers can
 * surface a readable message.
 */
export interface ChatProvider {
  streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatEvent>;
}
