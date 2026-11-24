import { join } from "node:path";
import { abbreviateHome, defaultConfigDir } from "./store/settings.ts";
import { VERSION } from "./version.ts";
import { LOG_RETENTION_DAYS } from "./log.ts";

/** Where debug logs go: beside config.json, so SCRIBE_CONFIG_DIR moves them too. */
export function logsDir(): string {
  return join(defaultConfigDir(), "logs");
}

const DEBUG_FLAGS = new Set(["--debug", "--debug=verbose"]);

export interface CliExit {
  output: string;
  exitCode: number;
}

function helpText(): string {
  const configPath = abbreviateHome(join(defaultConfigDir(), "config.json"));
  const logsPath = abbreviateHome(logsDir());
  return [
    `Scribe ${VERSION} — a bring-your-own-model TTRPG campaign builder for the terminal.`,
    "",
    "Usage: scribe [options]",
    "",
    "Options:",
    "  -h, --help       Show this help",
    "  -v, --version    Show the version",
    "  --debug          Write a debug log (no campaign text) while Scribe runs",
    "  --debug=verbose  Also log shortened tool arguments and results",
    "",
    "Run with no options to open the interactive UI.",
    "",
    `Settings:   ${configPath}`,
    "            Set SCRIBE_CONFIG_DIR to keep settings somewhere else.",
    `Debug logs: ${logsPath}/<date>.log, kept ${LOG_RETENTION_DAYS} days.`,
    "            SCRIBE_DEBUG=1 (or verbose) turns them on like --debug.",
    "Campaigns:  ~/Scribe by default; change it from the Settings screen.",
    "",
    "Scribe talks to any OpenAI-compatible API. Set the base URL, model, and the",
    "name of the environment variable holding your API key in Settings.",
  ].join("\n");
}

/**
 * Decide whether to exit before the UI starts. Returns null when the
 * interactive app should run.
 */
export function cliExit(args: readonly string[], isTTY: boolean): CliExit | null {
  for (const arg of args) {
    if (arg === "--version" || arg === "-v") return { output: VERSION, exitCode: 0 };
    if (arg === "--help" || arg === "-h") return { output: helpText(), exitCode: 0 };
  }
  const unknown = args.find((arg) => !DEBUG_FLAGS.has(arg));
  if (unknown !== undefined) {
    return { output: `Unknown option: ${unknown}\nRun "scribe --help" for usage.`, exitCode: 1 };
  }
  if (!isTTY) {
    return {
      output: 'Scribe is an interactive terminal app and needs a real terminal. Run "scribe --help" for usage.',
      exitCode: 1,
    };
  }
  return null;
}
