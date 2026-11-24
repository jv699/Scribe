/**
 * Opt-in debug logging. The TUI owns the terminal, so nothing can go to
 * stdout: with `--debug` (or SCRIBE_DEBUG=1) events are appended as JSON lines
 * to `<config dir>/logs/<date>.log`. Off by default, and every call is a no-op
 * then.
 *
 * Two levels:
 * - "debug": what happened and how long it took — requests, statuses, tool
 *   names, sizes, which name source answered. No campaign or prompt text.
 * - "verbose" (`--debug=verbose`): also shortened tool arguments and results,
 *   for when the shape of the content is the question. Opt in knowingly: the
 *   log then holds pieces of your campaign.
 *
 * Keys never reach the file. Callers don't log them, and as a second line of
 * defence every key Scribe reads (`apiKeyFrom`) is registered with
 * `registerSecret`, and any string containing one is masked before writing.
 *
 * Logging must never break the app: a failed write turns logging off.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "off" | "debug" | "verbose";

/** How many days of log files to keep. */
export const LOG_RETENTION_DAYS = 7;
const MAX_STRING = 500;
const LOG_NAME = /^(\d{4}-\d{2}-\d{2})\.log$/;

let level: LogLevel = "off";
let file: string | null = null;
const appendLine = (path: string, line: string): void => appendFileSync(path, line);
let write = appendLine;
const secrets = new Set<string>();

/** The level asked for on the command line, or else by SCRIBE_DEBUG. */
export function logLevelFrom(args: readonly string[], env: Record<string, string | undefined>): LogLevel {
  for (const arg of args) {
    if (arg === "--debug") return "debug";
    if (arg === "--debug=verbose") return "verbose";
  }
  const value = env["SCRIBE_DEBUG"]?.trim().toLowerCase();
  if (value === "verbose") return "verbose";
  if (value && value !== "0" && value !== "false" && value !== "off") return "debug";
  return "off";
}

function localDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Delete `<date>.log` files older than the retention window; leave anything else alone. */
function prune(dir: string, now: Date): void {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - LOG_RETENTION_DAYS);
  const oldest = localDate(cutoff);
  for (const name of readdirSync(dir)) {
    const date = LOG_NAME.exec(name)?.[1];
    if (date !== undefined && date < oldest) rmSync(join(dir, name), { force: true });
  }
}

export interface LoggingOptions {
  level: LogLevel;
  /** Where log files go: `<config dir>/logs`. */
  dir: string;
  now?: Date;
  /** For tests. */
  write?: (path: string, line: string) => void;
}

/** Start (or stop) logging. Returns the file being written, or null when off or it couldn't be set up. */
export function configureLogging(options: LoggingOptions): string | null {
  level = "off";
  file = null;
  write = options.write ?? appendLine;
  if (options.level === "off") return null;
  const now = options.now ?? new Date();
  try {
    mkdirSync(options.dir, { recursive: true });
    prune(options.dir, now);
  } catch {
    return null;
  }
  level = options.level;
  file = join(options.dir, `${localDate(now)}.log`);
  return file;
}

export function loggingEnabled(): boolean {
  return level !== "off";
}

/** Whether content (tool arguments and results) may be logged. */
export function logContent(): boolean {
  return level === "verbose";
}

/** Mask this value wherever it would appear in the log. Short values aren't keys and would mask too much. */
export function registerSecret(value: string): void {
  if (value.length >= 8) secrets.add(value);
}

function mask(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** Cut long text for the log, saying how long it was. */
export function shorten(text: string, max = MAX_STRING): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;
}

function clean(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return shorten(mask(value));
  if (value instanceof Error) return clean({ name: value.name, message: value.message }, depth);
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => clean(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = clean(item, depth + 1);
  }
  return out;
}

/** Append one event. A no-op unless logging is on. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  if (level === "off" || file === null) return;
  try {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...(clean(fields) as object) });
    write(file, line + "\n");
  } catch {
    // A full disk or a vanished folder must not take the app down with it.
    level = "off";
  }
}

/** Log a failure with the error's message (masked like everything else). */
export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  if (level === "off") return;
  const detail = error instanceof Error ? { error: error.message, errorName: error.name } : { error: String(error) };
  log(event, { ...fields, ...detail });
}

/** Milliseconds since `start` (from `performance.now()`), rounded. */
export function since(start: number): number {
  return Math.round(performance.now() - start);
}
