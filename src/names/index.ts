/**
 * Where `generate_names` gets its names: Behind the Name for real cultures
 * when a key is set, the offline generator for invented cultures and whenever
 * Behind the Name can't answer. One service per chat, so it can remember what
 * it has already handed out and not offer the same name twice.
 */
import { apiKeyFrom } from "../provider/openai.ts";
import { makeBehindTheNameClient, MAX_PER_REQUEST, type BehindTheNameClient } from "./behind-the-name.ts";
import type { Culture } from "./cultures.ts";
import { generateNames, type NameGender, type NameKind, type StyleId } from "./generator.ts";

export interface NameRequest {
  culture: Culture;
  count: number;
  gender: NameGender;
  kind: NameKind;
  surnames: boolean;
}

export interface NameBatch {
  names: string[];
  /** "none": no source could serve this culture (offline, with no stand-in style). */
  source: "behindthename" | "generated" | "none";
  /** The offline style used, when generated. */
  style?: StyleId;
  /** Behind the Name was tried and failed, so these came from the generator instead. */
  fellBack: boolean;
}

export interface NameService {
  generate(request: NameRequest): Promise<NameBatch>;
}

export interface NameServiceOptions {
  /** Name of the env var holding a Behind the Name key; unset or empty means offline only. */
  apiKeyEnv?: string;
  /** Injected client, for tests; overrides `apiKeyEnv`. */
  client?: BehindTheNameClient | null;
  random?: () => number;
}

/**
 * Behind the Name returns one surname per request, so full names cost one
 * request each. This caps a single call at 6 of them (about 3 s at the
 * permitted rate); the model can always ask again.
 */
export const MAX_FULL_NAMES_ONLINE = 6;
/** Room for a few duplicates on top of the requests a count strictly needs. */
const EXTRA_REQUESTS = 2;

export function makeNameService(options: NameServiceOptions = {}): NameService {
  const apiKey = apiKeyFrom(options.apiKeyEnv);
  const client = options.client !== undefined ? options.client : apiKey ? makeBehindTheNameClient({ apiKey }) : null;
  const used = new Set<string>();

  function remember(names: string[]): string[] {
    for (const name of names) used.add(name.toLowerCase());
    return names;
  }

  function offline(request: NameRequest, fellBack: boolean): NameBatch {
    const style = request.culture.style;
    if (!style) return { names: [], source: "none", fellBack };
    const names = generateNames({
      style,
      count: request.count,
      gender: request.gender,
      kind: request.kind,
      surnames: request.surnames,
      exclude: used,
      ...(options.random ? { random: options.random } : {}),
    });
    return { names: remember(names), source: "generated", style, fellBack };
  }

  async function online(client: BehindTheNameClient, usage: string, request: NameRequest): Promise<string[] | null> {
    const names: string[] = [];
    const seen = new Set(used);
    const add = (name: string): void => {
      if (seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());
      names.push(name);
    };

    const wanted = request.surnames ? Math.min(request.count, MAX_FULL_NAMES_ONLINE) : request.count;
    const perRequest = request.surnames ? 1 : MAX_PER_REQUEST;
    const maxRequests = Math.ceil(wanted / perRequest) + EXTRA_REQUESTS;
    for (let i = 0; i < maxRequests && names.length < wanted; i++) {
      const result = await client.random({
        usage,
        gender: request.gender,
        number: request.surnames ? 1 : Math.min(MAX_PER_REQUEST, wanted - names.length),
        surname: request.surnames,
      });
      // Keep a partial answer; with nothing at all, let the generator take over.
      if (result === null) return names.length > 0 ? names : null;
      if (request.surnames && result.surname) {
        const given = result.given[0];
        if (given) add(`${given} ${result.surname}`);
      } else {
        for (const given of result.given) add(given);
      }
    }
    return names.slice(0, wanted);
  }

  return {
    async generate(request) {
      const usage = request.culture.usage;
      // Behind the Name has people, not places.
      if (!client || !usage || request.kind === "place") return offline(request, false);
      const names = await online(client, usage, request);
      if (names === null) return offline(request, true);
      return { names: remember(names), source: "behindthename", fellBack: false };
    },
  };
}
