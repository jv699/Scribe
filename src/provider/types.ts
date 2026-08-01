/**
 * Provider abstraction: the single seam between the app and any model backend.
 * Phase 1 implements the OpenAI-compatible client; other providers (e.g.
 * Anthropic-native) implement the same interface without touching the UI.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Streams assistant content deltas for a conversation. Throws on transport
 * or HTTP errors so callers can surface a readable message.
 */
export interface ChatProvider {
  streamChat(messages: ChatMessage[]): AsyncIterable<string>;
}
