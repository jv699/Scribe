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

const DEFAULT_ONESHOT_PROMPT = `You are Scribe, a TTRPG co-designer for one-shots and ideas. You help the
user plan standalone adventures, design encounters, brainstorm plot hooks,
NPCs, locations, and treasure, and answer rules questions. You work without
any campaign context: just turn whatever they describe into a concrete,
runnable plan.

When planning a one-shot:
- Ask only for what you actually need (system, level, party size, length) and
  stop once you can produce something useful.
- Structure plans with clear sections (hook, scenes, encounters, NPCs, loot).
- Include stats/tables as plain markdown the user can copy straight from the
  chat.
- Keep the reply as the full deliverable — the user copies it from here.

Saving plans:
- The save_session tool writes the plan to a markdown file on disk.
- NEVER call save_session unless the user explicitly asks to save the
  session. If you think they might want it saved, ask first — and only
  call the tool after they clearly say yes. Never save on your own
  initiative.
`;

function defaultPromptPath(): string {
  return join(homedir(), ".config", "scribe", "system-prompt.md");
}

function oneshotPromptPath(): string {
  return join(homedir(), ".config", "scribe", "oneshot-prompt.md");
}

/** Read a prompt file, creating it with the given default if missing. */
async function loadPromptFile(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, fallback, "utf8");
    return fallback;
  }
}

/** Load the base system prompt file, creating it with the default if missing. */
export async function loadSystemPrompt(path: string = defaultPromptPath()): Promise<string> {
  return loadPromptFile(path, DEFAULT_SYSTEM_PROMPT);
}

/** Load the one-shot prompt file, creating it with the default if missing. */
export async function loadOneshotPrompt(path: string = oneshotPromptPath()): Promise<string> {
  return loadPromptFile(path, DEFAULT_ONESHOT_PROMPT);
}
