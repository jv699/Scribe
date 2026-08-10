/**
 * App-level settings in `~/.config/scribe/config.json` (separate from
 * campaign data, which lives in the campaigns dir). Created with defaults on
 * first run; API keys are referenced by env var name, never stored.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * App settings live in ~/.config/scribe/config.json (campaign data lives
 * elsewhere — see PLAN.md). The API key is only ever an env var *name*.
 */
export interface Settings {
  /** Directory containing one folder per campaign. Default: ~/Scribe */
  campaignsDir: string;
  /** Directory where saved one-shot plans are written. Default: ~/Scribe/One-Shots */
  oneshotsDir: string;
  /** Directory containing source PDFs (rulebooks, bestiaries, etc.), organized by system folder. Default: ~/Scribe/Sources */
  sourcesDir: string;
  /** OpenAI-compatible base URL (Phase 1). */
  baseUrl?: string;
  /** Model name (Phase 1). */
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

/** Directory holding the app config files (config.json + prompts). */
export function defaultConfigDir(): string {
  // SCRIBE_CONFIG_DIR relocates the whole config dir (config.json + the user's
  // instruction files) — useful for separate profiles, and for tests.
  const override = process.env["SCRIBE_CONFIG_DIR"];
  if (override && override.trim() !== "") return expandHome(override);
  return join(homedir(), ".config", "scribe");
}

function defaultConfigPath(): string {
  return join(defaultConfigDir(), "config.json");
}

/** Expand a leading "~" to the home directory. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Abbreviate a path under the home directory to a leading "~". */
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
      settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
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

/** Persist settings back to the config file. */
export async function saveSettings(settings: Settings, configPath: string = defaultConfigPath()): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
