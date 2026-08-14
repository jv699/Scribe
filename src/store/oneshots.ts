/**
 * Markdown-first persistence for saved one-shot plans: one file per plan in a
 * configurable `oneshotsDir` (`<slug>.md`) with flat frontmatter (title,
 * system, created) and the plan markdown as the body. Colliding names get a
 * numeric suffix.
 */
import { constants } from "node:fs";
import { join } from "node:path";
import { mkdir, readdir, type FileHandle } from "node:fs/promises";
import { parseFrontmatter, serializeFrontmatter, updateFrontmatterFile } from "./frontmatter.ts";
import { slugify, today } from "./naming.ts";
import { openRegularFileNoFollow, readRegularFileNoFollow } from "./safe-files.ts";

export interface OneshotInput {
  title: string;
  system?: string;
  content: string;
}

/** A saved one-shot discovered directly inside the configured directory. */
export interface SavedOneshot {
  /** File name without `.md`; the stable identity exposed to the agent. */
  slug: string;
  /** Human-readable name derived from the file name for the Drafting Table. */
  displayName: string;
  /** Absolute runtime path, resolved by the store rather than model input. */
  path: string;
  /** Flat frontmatter exactly as it appeared in the document. */
  data: Record<string, string>;
  /** Markdown body without frontmatter. */
  body: string;
}

/** Turn `lighthouse-siege-2.md` into `Lighthouse Siege 2`. */
export function unslugOneshot(fileName: string): string {
  const words = fileName
    .replace(/\.md$/i, "")
    .replace(/-+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words.replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

/** List readable regular `.md` files directly inside `dir`, sorted for display. */
export async function listOneshots(dir: string): Promise<SavedOneshot[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const oneshots: SavedOneshot[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const path = join(dir, entry.name);

    try {
      // Dirent metadata can be stale by the time the entry is opened. The
      // shared reader refuses a replacement symlink or non-regular target.
      const { data, body } = parseFrontmatter(await readRegularFileNoFollow(path));
      oneshots.push({
        slug: entry.name.slice(0, -3),
        displayName: unslugOneshot(entry.name),
        path,
        data,
        body,
      });
    } catch {
      // One unreadable document should not hide the rest of the drafting table.
    }
  }
  return oneshots.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.slug.localeCompare(b.slug));
}

/**
 * Resolve an exact slug or display name from the scanned library. Ambiguous
 * display names fail closed, and model input is never joined into a path.
 */
export async function findOneshot(dir: string, identity: string): Promise<SavedOneshot | null> {
  const needle = identity.trim().toLowerCase();
  if (needle === "") return null;
  const oneshots = await listOneshots(dir);
  const slugMatches = oneshots.filter((oneshot) => oneshot.slug.toLowerCase() === needle);
  if (slugMatches.length !== 0) return slugMatches.length === 1 ? slugMatches[0]! : null;
  const displayMatches = oneshots.filter((oneshot) => oneshot.displayName.toLowerCase() === needle);
  return displayMatches.length === 1 ? displayMatches[0]! : null;
}

/** Replace the markdown body of a discovered one-shot, preserving frontmatter. */
export async function writeOneshot(saved: SavedOneshot, body: string): Promise<SavedOneshot> {
  const next = await updateFrontmatterFile(saved.path, (data) => ({ data, body }));
  return { ...saved, data: next.data, body: next.body };
}

/** Write a one-shot plan to `dir`, returning the absolute path written. */
export async function saveOneshot(dir: string, input: OneshotInput): Promise<string> {
  await mkdir(dir, { recursive: true });

  const slug = slugify(input.title) || "oneshot";
  const data: Record<string, string> = {
    title: input.title,
    created: today(),
  };
  if (input.system) data["system"] = input.system;
  const content = serializeFrontmatter(data, input.content);

  // Exclusive creation makes collision handling atomic across Scribe instances
  // and refuses to overwrite a symlink installed at a candidate path.
  for (let suffix = 1; ; suffix++) {
    const fileName = suffix === 1 ? `${slug}.md` : `${slug}-${suffix}.md`;
    const path = join(dir, fileName);
    let file: FileHandle | undefined;
    try {
      file = await openRegularFileNoFollow(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o666,
      );
      await file.writeFile(content, "utf8");
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      await file?.close();
    }
  }
}
