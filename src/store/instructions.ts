/** Optional user-authored prompt layers. These files are never created by Scribe. */
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { defaultConfigDir } from "./settings.ts";

function instructionsPath(): string {
  return join(defaultConfigDir(), "instructions.md");
}

function oneshotInstructionsPath(): string {
  return join(defaultConfigDir(), "oneshot-instructions.md");
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function loadInstructions(path: string = instructionsPath()): Promise<string> {
  return readOptional(path);
}

export async function loadOneshotInstructions(path: string = oneshotInstructionsPath()): Promise<string> {
  return readOptional(path);
}

/** Returns `null` for missing, unreadable, or blank overrides. */
export async function loadPromptOverride(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    const text = await readFile(path, "utf8");
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}
