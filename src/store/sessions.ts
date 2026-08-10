/**
 * Markdown-first persistence for sessions: one file per session in the
 * campaign's `sessions/` folder (`00N-slug.md`) with flat frontmatter and a
 * "## Plan" / "## Outcome" body. Handles numbering, status transitions, and
 * soft-delete to `.scribe/trash/`.
 */
import { basename, join } from "node:path";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { parseFrontmatter, serializeFrontmatter, updateFrontmatterFile } from "./frontmatter.ts";
import { slugify, today, uniqueName } from "./naming.ts";
import { updateCampaignMeta, type Campaign } from "./campaigns.ts";

export type SessionStatus = "planning" | "ready" | "played";

/**
 * A session is a markdown file in the campaign's `sessions/` folder:
 *
 *   ---
 *   number: 1
 *   title: Death House
 *   status: planning
 *   created: 2026-07-27
 *   ---
 *   # Death House
 *   ## Plan
 *   ...
 *   ## Outcome
 *   ...
 */
export interface Session {
  number: number;
  title: string;
  status: SessionStatus;
  created: string;
  /** Absolute path to the session file (runtime only, not persisted). */
  path: string;
}

const SESSIONS_DIR = "sessions";
const TRASH_DIR = join(".scribe", "trash");
const VALID_STATUSES: readonly SessionStatus[] = ["planning", "ready", "played"];

function sessionFromMarkdown(path: string, content: string): Session {
  const { data } = parseFrontmatter(content);
  const status = VALID_STATUSES.includes(data["status"] as SessionStatus)
    ? (data["status"] as SessionStatus)
    : "planning";
  return {
    // Clamped like campaignFromMarkdown's `nextSession` (campaigns.ts): session
    // numbering starts at 1, so malformed/missing frontmatter should not
    // produce a "session 0" that would sort before every real session.
    number: Math.max(1, Number.parseInt(data["number"] ?? "1", 10) || 1),
    title: data["title"] ?? basename(path, ".md"),
    status,
    created: data["created"] ?? "",
    path,
  };
}

/** Create session N (from campaign.nextSession) and bump the campaign counter. */
export async function createSession(campaign: Campaign, title: string): Promise<Session> {
  const number = campaign.nextSession;
  const sessionsDir = join(campaign.dir, SESSIONS_DIR);
  const existing = await readdir(sessionsDir);
  const fileName = uniqueName(
    `${String(number).padStart(3, "0")}-${slugify(title)}`,
    existing,
    { ext: ".md", separator: "-" },
  );
  const path = join(sessionsDir, fileName);

  const body = `# ${title}\n\n## Plan\n\n\n## Outcome\n`;
  const markdown = serializeFrontmatter(
    { number: String(number), title, status: "planning", created: today() },
    body,
  );
  await writeFile(path, markdown, "utf8");
  await updateCampaignMeta(campaign, { nextSession: number + 1 });
  campaign.nextSession = number + 1; // keep the in-memory object in sync

  return { number, title, status: "planning", created: today(), path };
}

/** List sessions sorted by number. */
export async function listSessions(campaign: Campaign): Promise<Session[]> {
  const sessionsDir = join(campaign.dir, SESSIONS_DIR);
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch {
    return [];
  }
  const sessions: Session[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const path = join(sessionsDir, file);
    sessions.push(sessionFromMarkdown(path, await readFile(path, "utf8")));
  }
  return sessions.sort((a, b) => a.number - b.number);
}

/** Transition status, stamping the corresponding date in frontmatter. */
export async function setSessionStatus(session: Session, status: SessionStatus): Promise<void> {
  await updateFrontmatterFile(session.path, (data, body) => {
    const patch: Record<string, string> = { status };
    if (status === "ready" && !data["ready"]) patch["ready"] = today();
    if (status === "played" && !data["played"]) patch["played"] = today();
    return { data: { ...data, ...patch }, body };
  });
  session.status = status;
}

/** Read the session's markdown body (the Plan/Outcome sections, no frontmatter). */
export async function readSessionNotes(session: Session): Promise<string> {
  const { body } = parseFrontmatter(await readFile(session.path, "utf8"));
  return body;
}

/** Replace the session's markdown body, preserving frontmatter. */
export async function writeSessionNotes(session: Session, body: string): Promise<void> {
  await updateFrontmatterFile(session.path, (data) => ({ data, body }));
}

/** Soft-delete: move the session file into the campaign's .scribe/trash/. */
export async function trashSession(campaign: Campaign, session: Session): Promise<void> {
  const trashDir = join(campaign.dir, TRASH_DIR);
  await mkdir(trashDir, { recursive: true });
  await rename(session.path, join(trashDir, basename(session.path)));
}
