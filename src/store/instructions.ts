/**
 * The user's optional instruction files — the layer appended *after* the
 * code-owned core prompt (`agent/prompts.ts`) and the campaign context.
 *
 * Read-only by design: these files are never created, so a user who hasn't
 * written one gets whatever the current version of Scribe ships, and can't end
 * up pinned to a stale copy of a prompt they never edited.
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { defaultConfigDir } from "./settings.ts";

function instructionsPath(): string {
  return join(defaultConfigDir(), "instructions.md");
}

function oneshotInstructionsPath(): string {
  return join(defaultConfigDir(), "oneshot-instructions.md");
}

/** Read a file, returning "" when it is missing or unreadable. */
async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** The user's campaign instructions, or "" when they haven't written any. */
export async function loadInstructions(path: string = instructionsPath()): Promise<string> {
  return readOptional(path);
}

/** The user's one-shot instructions, or "" when they haven't written any. */
export async function loadOneshotInstructions(path: string = oneshotInstructionsPath()): Promise<string> {
  return readOptional(path);
}

/**
 * Read a core-prompt override file. Returns `null` when unset or unreadable so
 * a bad path in config.json falls back to the built-in core rather than
 * leaving the agent with no instructions at all.
 */
export async function loadPromptOverride(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    const text = await readFile(path, "utf8");
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}
