import { dirname, join } from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { ChatMessage } from "../provider/types.ts";

export type ChatLogMode = "plan" | "report";

export function chatLogPath(campaignDir: string, sessionNumber: number, mode: ChatLogMode): string {
  return join(campaignDir, ".scribe", `${mode}-session-${String(sessionNumber).padStart(3, "0")}.jsonl`);
}

/** Ignores corrupt lines. */
export async function loadChatLog(
  campaignDir: string,
  sessionNumber: number,
  mode: ChatLogMode,
): Promise<ChatMessage[]> {
  const path = chatLogPath(campaignDir, sessionNumber, mode);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const messages: ChatMessage[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      messages.push(JSON.parse(line) as ChatMessage);
    } catch {
      // Preserve the rest of a partially corrupt log.
    }
  }
  return messages;
}

export async function saveChatLog(
  campaignDir: string,
  sessionNumber: number,
  mode: ChatLogMode,
  messages: ChatMessage[],
): Promise<void> {
  const path = chatLogPath(campaignDir, sessionNumber, mode);
  await mkdir(dirname(path), { recursive: true });
  const raw = messages.map((m) => JSON.stringify(m)).join("\n");
  await writeFile(path, raw + (raw ? "\n" : ""), "utf8");
}

export async function clearChatLog(
  campaignDir: string,
  sessionNumber: number,
  mode: ChatLogMode,
): Promise<void> {
  await rm(chatLogPath(campaignDir, sessionNumber, mode), { force: true });
}
