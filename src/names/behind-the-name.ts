/**
 * Behind the Name's `random` endpoint: real given names (and optionally a
 * surname) for a usage code. Free with a personal key, which lives in an env
 * var like the model key: config.json stores only the variable's name.
 *
 * Every argument that reaches the URL comes from Scribe's own tables
 * (`cultures.ts`) or is clamped here; nothing the model wrote is passed
 * through. The key goes into the URL and nowhere else — failures are reported
 * as a bare "unavailable", never with the URL or the response body.
 *
 * Usage limits (from Behind the Name): 2 requests a second, 400 an hour,
 * 4,000 a day. Requests are spaced to respect the first; the others are far
 * beyond what planning uses, and a refusal falls back to the offline generator.
 */
import { log, registerSecret, since } from "../log.ts";
import type { NameGender } from "./generator.ts";

export const DEFAULT_NAMES_KEY_ENV = "BEHINDTHENAME_API_KEY";
const ENDPOINT = "https://www.behindthename.com/api/random.json";
const REQUEST_TIMEOUT_MS = 5_000;
/** Behind the Name allows two requests a second. */
const MIN_INTERVAL_MS = 550;
/** The most given names one request returns. */
export const MAX_PER_REQUEST = 6;

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export interface BehindTheNameOptions {
  apiKey: string;
  fetch?: FetchLike;
  /** Spacing between requests; tests pass 0. */
  minIntervalMs?: number;
}

export interface RandomNamesRequest {
  usage: string;
  gender: NameGender;
  /** Given names wanted, 1..MAX_PER_REQUEST. */
  number: number;
  surname: boolean;
}

export interface RandomNames {
  given: string[];
  surname?: string;
}

export interface BehindTheNameClient {
  /** Null when Behind the Name couldn't or wouldn't answer, whatever the reason. */
  random(request: RandomNamesRequest): Promise<RandomNames | null>;
}

/** Shared across clients: the rate limit belongs to the key, not to one chat. */
let nextSlot = 0;

async function waitForSlot(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + minIntervalMs;
  if (at > now) await Bun.sleep(at - now);
}

/**
 * A name as it should reach the model: letters (any script), marks, spaces,
 * hyphens and apostrophes, at most 40 characters. Anything else is dropped,
 * since this is text from the network landing in the model's context.
 */
export function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFC").trim();
  if (trimmed === "" || trimmed.length > 40) return null;
  if (!/^[\p{L}\p{M}][\p{L}\p{M}' ’-]*$/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * Behind the Name answers `{"names": [...]}`, with the surname (when asked
 * for) appended after the given names, or `{"error_code": n, "error": "..."}`.
 */
export function parseRandomNames(body: unknown, request: RandomNamesRequest): RandomNames | null {
  if (typeof body !== "object" || body === null || "error" in body) return null;
  const raw = (body as { names?: unknown }).names;
  if (!Array.isArray(raw)) return null;
  const names = raw.map(cleanName).filter((name): name is string => name !== null);
  if (names.length !== raw.length) return null;
  if (request.surname) {
    // Only a response with given names *and* a surname is unambiguous.
    if (names.length < 2) return null;
    const surname = names.pop()!;
    return { given: names, surname };
  }
  return names.length > 0 ? { given: names } : null;
}

export function makeBehindTheNameClient(options: BehindTheNameOptions): BehindTheNameClient {
  registerSecret(options.apiKey);
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;

  return {
    async random(request) {
      const params = new URLSearchParams({
        key: options.apiKey,
        usage: request.usage,
        number: String(Math.min(MAX_PER_REQUEST, Math.max(1, Math.floor(request.number)))),
      });
      if (request.gender === "male") params.set("gender", "m");
      if (request.gender === "female") params.set("gender", "f");
      if (request.surname) params.set("randomsurname", "yes");

      await waitForSlot(minIntervalMs);
      // Everything in the request but the key, so a log shows exactly what was asked.
      const asked = { usage: request.usage, number: params.get("number"), gender: params.get("gender") ?? "any", surname: request.surname };
      const started = performance.now();
      let response: Response;
      try {
        response = await fetchImpl(`${ENDPOINT}?${params}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch (error) {
        // Offline or timed out: either way, use the generator.
        const outcome = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable";
        log("names.btn", { ...asked, outcome, ms: since(started) });
        return null;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        // The timeout covers the body too: a stalled reply is slow, not malformed.
        const name = error instanceof Error ? error.name : "";
        const outcome = name === "TimeoutError" ? "timeout" : name === "SyntaxError" ? "not-json" : "unreachable";
        log("names.btn", { ...asked, outcome, status: response.status, ms: since(started) });
        return null;
      }
      const result = response.ok ? parseRandomNames(body, request) : null;
      // The raw names (public data, not campaign text) and Behind the Name's
      // own error are what tell a wrong usage code or response shape apart.
      const raw = body && typeof body === "object" ? (body as { names?: unknown; error?: unknown; error_code?: unknown }) : {};
      log("names.btn", {
        ...asked,
        outcome: result ? "ok" : response.ok ? "unexpected-body" : "http-error",
        status: response.status,
        ms: since(started),
        names: raw.names,
        error: raw.error,
        errorCode: raw.error_code,
      });
      return result;
    },
  };
}
