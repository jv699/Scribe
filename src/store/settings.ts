import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface Settings {
  /** One folder per campaign. */
  campaignsDir: string;
  oneshotsDir: string;
  /** Source PDFs organized by system folder. */
  sourcesDir: string;
  baseUrl?: string;
  model?: string;
  /** Name of the env var holding the API key — never the key itself. */
  apiKeyEnv?: string;
  /**
   * Advanced, config-file only: path to a file replacing the built-in campaign
   * core prompt. Campaign context and the user's instructions still apply.
   */
  systemPromptOverride?: string;
  /** Advanced, config-file only: same, for the one-shot core prompt. */
  oneshotPromptOverride?: string;
}

const DEFAULT_SETTINGS: Settings = {
  campaignsDir: join(homedir(), "Scribe"),
  oneshotsDir: join(homedir(), "Scribe", "One-Shots"),
  sourcesDir: join(homedir(), "Scribe", "Sources"),
};

const OPTIONAL_STRING_SETTINGS = [
  "baseUrl",
  "model",
  "apiKeyEnv",
  "systemPromptOverride",
  "oneshotPromptOverride",
] as const satisfies readonly (keyof Settings)[];

/** Accept only well-typed values from hand-edited config. */
function settingsFromJson(value: unknown): Settings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ...DEFAULT_SETTINGS };
  const raw = value as Record<string, unknown>;
  const settings: Settings = { ...DEFAULT_SETTINGS };

  for (const key of ["campaignsDir", "oneshotsDir", "sourcesDir"] as const) {
    const candidate = raw[key];
    if (typeof candidate === "string" && candidate.trim() !== "") settings[key] = candidate;
  }
  for (const key of OPTIONAL_STRING_SETTINGS) {
    const candidate = raw[key];
    if (typeof candidate === "string" && candidate.trim() !== "") settings[key] = candidate;
  }
  return settings;
}

export function defaultConfigDir(): string {
  // Relocates config and instruction files together.
  const override = process.env["SCRIBE_CONFIG_DIR"];
  if (override && override.trim() !== "") return expandHome(override);
  return join(homedir(), ".config", "scribe");
}

function defaultConfigPath(): string {
  return join(defaultConfigDir(), "config.json");
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function abbreviateHome(path: string): string {
  if (path === homedir()) return "~";
  if (path.startsWith(homedir() + "/")) return "~" + path.slice(homedir().length);
  return path;
}

/**
 * Load settings, creating the config file (and campaigns dir) with defaults
 * on first run. `configPath` is injectable for tests.
 */
export async function loadSettings(configPath: string = defaultConfigPath()): Promise<Settings> {
  let raw: string | null = null;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    // Missing file — fall through to defaults.
  }

  let settings: Settings = { ...DEFAULT_SETTINGS };
  if (raw !== null) {
    try {
      settings = settingsFromJson(JSON.parse(raw) as unknown);
    } catch {
      // Corrupt config — keep defaults rather than crash at startup.
    }
  }

  settings.campaignsDir = expandHome(settings.campaignsDir);
  settings.oneshotsDir = expandHome(settings.oneshotsDir);
  settings.sourcesDir = expandHome(settings.sourcesDir);
  if (settings.systemPromptOverride) settings.systemPromptOverride = expandHome(settings.systemPromptOverride);
  if (settings.oneshotPromptOverride) settings.oneshotPromptOverride = expandHome(settings.oneshotPromptOverride);

  if (raw === null) {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
  await mkdir(settings.campaignsDir, { recursive: true });
  await mkdir(settings.oneshotsDir, { recursive: true });
  await mkdir(settings.sourcesDir, { recursive: true });

  return settings;
}

export async function saveSettings(settings: Settings, configPath: string = defaultConfigPath()): Promise<void> {
  await mkdir(settings.campaignsDir, { recursive: true });
  await mkdir(settings.oneshotsDir, { recursive: true });
  await mkdir(settings.sourcesDir, { recursive: true });
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
