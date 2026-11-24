/**
 * Where `generate_names` gets its names: Behind the Name for real cultures
 * when a key is set, the offline generator for invented cultures and whenever
 * Behind the Name can't answer. One service per chat, so it can remember what
 * it has already handed out and not offer the same name twice.
 */
import { log } from "../log.ts";
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
  /**
   * Why Behind the Name wasn't used, when it wasn't: no key set, a request
   * for places (it has only people), or a culture it doesn't cover. Absent
   * when it was used, or when it failed (`fellBack`).
   */
  skipped?: "no-key" | "places" | "no-usage";
  /** The offline style used, when generated. */
  style?: StyleId;
  /** Behind the Name was tried and failed, so these came from the generator instead. */
  fellBack: boolean;
}

export interface NameService {
  generate(request: NameRequest): Promise<NameBatch>;
  /** Count these as already handed out: how a resumed chat keeps its memory. */
  exclude(names: Iterable<string>): void;
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

  function offline(request: NameRequest, fellBack: boolean, skipped?: NameBatch["skipped"]): NameBatch {
    const style = request.culture.style;
    const why = skipped ? { skipped } : {};
    if (!style) return { names: [], source: "none", fellBack, ...why };
    const names = generateNames({
      style,
      count: request.count,
      gender: request.gender,
      kind: request.kind,
      surnames: request.surnames,
      exclude: used,
      ...(options.random ? { random: options.random } : {}),
    });
    return { names: remember(names), source: "generated", style, fellBack, ...why };
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

  async function choose(request: NameRequest): Promise<NameBatch> {
    const usage = request.culture.usage;
    if (!usage) return offline(request, false, "no-usage");
    // Behind the Name has people, not places.
    if (request.kind === "place") return offline(request, false, "places");
    if (!client) return offline(request, false, "no-key");
    const names = await online(client, usage, request);
    if (names === null) return offline(request, true);
    return { names: remember(names), source: "behindthename", fellBack: false };
  }

  return {
    async generate(request) {
      const batch = await choose(request);
      log("names.batch", {
        culture: request.culture.label,
        kind: request.kind,
        gender: request.gender,
        surnames: request.surnames,
        asked: request.count,
        returned: batch.names.length,
        source: batch.source,
        style: batch.style,
        fellBack: batch.fellBack,
        skipped: batch.skipped,
      });
      return batch;
    },
    exclude(names) {
      for (const name of names) used.add(name.toLowerCase());
    },
  };
}
