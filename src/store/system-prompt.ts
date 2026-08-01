/**
 * The base system prompt is a user-owned file (default
 * `~/.config/scribe/system-prompt.md`) so users can steer the LLM at a system
 * level. Created with a sensible default on first load.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const DEFAULT_SYSTEM_PROMPT = `You are Scribe, a TTRPG campaign co-designer. You help the user plan
sessions for their campaign: you know the campaign's system, background, and
the running story so far, and you have tools to read and update session notes.

When planning a session:
- Read the current session notes before changing them.
- Plan scenes and encounters that fit the established story.
- Write the finished plan into the session notes using update_session_notes.
- Keep your replies concise; put the actual plan in the notes file.
`;

export function defaultSystemPromptPath(): string {
  return join(homedir(), ".config", "scribe", "system-prompt.md");
}

/** Load the system prompt file, creating it with the default if missing. */
export async function loadSystemPrompt(path: string = defaultSystemPromptPath()): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, DEFAULT_SYSTEM_PROMPT, "utf8");
    return DEFAULT_SYSTEM_PROMPT;
  }
}
