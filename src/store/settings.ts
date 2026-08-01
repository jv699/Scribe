/**
 * App-level settings in `~/.config/scribe/config.json` (separate from
 * campaign data, which lives in the campaigns dir). Created with defaults on
 * first run; API keys are referenced by env var name, never stored.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

/**
 * App settings live in ~/.config/scribe/config.json (campaign data lives
 * elsewhere — see PLAN.md). The API key is only ever an env var *name*.
 */
export interface Settings {
  /** Directory containing one folder per campaign. Default: ~/Scribe */
  campaignsDir: string;
  /** OpenAI-compatible base URL (Phase 1). */
  baseUrl?: string;
  /** Model name (Phase 1). */
  model?: string;
  /** Name of the env var holding the API key — never the key itself. */
  apiKeyEnv?: string;
}

const DEFAULT_SETTINGS: Settings = {
  campaignsDir: join(homedir(), "Scribe"),
};

function defaultConfigPath(): string {
  return join(homedir(), ".config", "scribe", "config.json");
}

/** Expand a leading "~" to the home directory. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
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

  if (raw === null) {
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(configPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }
  await mkdir(settings.campaignsDir, { recursive: true });

  return settings;
}

/** Persist settings back to the config file. */
export async function saveSettings(settings: Settings, configPath: string = defaultConfigPath()): Promise<void> {
  await mkdir(join(configPath, ".."), { recursive: true });
  await writeFile(configPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
