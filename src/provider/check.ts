/**
 * Validating and proving a base URL / key variable / model triple — shared by
 * the Settings screen and ScribeBench's model entries, so both refuse the same
 * fields with the same words and both enforce "never store keys".
 */
import { DEFAULT_BASE_URL, DEFAULT_MODEL, testConnection } from "./openai.ts";

export const CHECK_TIMEOUT_MS = 20_000;

export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_PREFIX = /^(sk|pk|gsk|xai|key)[-_]/i;

/**
 * Whether the "env var" field holds a pasted key rather than a variable's
 * name. A name that resolves in this environment is always taken as a name.
 */
export function looksLikeApiKey(value: string): boolean {
  if (process.env[value] !== undefined) return false;
  if (KEY_PREFIX.test(value)) return true;
  return value.length >= 20 && /[a-z]/.test(value) && /\d/.test(value);
}

/** Why no request could use this base URL (blank means the default), or null. */
export function baseUrlProblem(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed !== "" && !/^https?:\/\/\S+$/i.test(trimmed)) return "The base URL must start with http:// or https://";
  return null;
}

/** Why this can't be saved as a key variable's name (blank means none), or null. */
export function keyVarProblem(apiKeyEnv: string): string | null {
  const trimmed = apiKeyEnv.trim();
  if (trimmed === "") return null;
  if (looksLikeApiKey(trimmed)) {
    return "That looks like an API key. Export it in your shell and enter the variable's name here.";
  }
  if (!ENV_VAR_NAME.test(trimmed)) return "An environment variable name can only use letters, digits, and underscores";
  return null;
}

export interface ProviderFields {
  /** Blank means DEFAULT_BASE_URL. */
  baseUrl: string;
  /** Blank means no key. */
  apiKeyEnv: string;
  /** Blank means DEFAULT_MODEL. */
  model: string;
}

/**
 * Prove the fields work together with one real (tiny) chat request, behind a
 * timeout. Resolves to null when connected, or to the reason it didn't — a
 * refused field and an unset key variable are reported without a request.
 */
export async function checkProvider(fields: ProviderFields, timeoutMs: number = CHECK_TIMEOUT_MS): Promise<string | null> {
  const problem = baseUrlProblem(fields.baseUrl) ?? keyVarProblem(fields.apiKeyEnv);
  if (problem) return problem;
  const apiKeyEnv = fields.apiKeyEnv.trim();
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : "";
  if (apiKey === undefined) return `The environment variable ${apiKeyEnv} is not set. Export it, then restart Scribe.`;

  // Aborting on timeout ends the request too, rather than leaving it open (and billed) behind the verdict.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await testConnection(
      {
        baseUrl: fields.baseUrl.trim() || DEFAULT_BASE_URL,
        model: fields.model.trim() || DEFAULT_MODEL,
        apiKey,
        ...(apiKeyEnv ? { apiKeyEnv } : {}),
      },
      signal,
    );
    return null;
  } catch (error) {
    if (signal.aborted) return `No reply after ${timeoutMs / 1000} seconds. Check the base URL.`;
    return error instanceof Error ? error.message : "Connection test failed";
  }
}
