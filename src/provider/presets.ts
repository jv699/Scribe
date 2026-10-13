export interface ProviderPreset {
  name: string;
  baseUrl: string;
}

/** OpenAI-compatible endpoints offered by the Settings base URL field. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
  { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { name: "xAI", baseUrl: "https://api.x.ai/v1" },
  { name: "Together AI", baseUrl: "https://api.together.xyz/v1" },
  { name: "Ollama (local)", baseUrl: "http://localhost:11434/v1" },
  { name: "LM Studio (local)", baseUrl: "http://localhost:1234/v1" },
];
