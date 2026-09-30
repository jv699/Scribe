import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { mkdir, readdir, type FileHandle } from "node:fs/promises";
import { parseFrontmatter, serializeFrontmatter, updateFrontmatterFile } from "./frontmatter.ts";
import { slugify, today } from "./naming.ts";
import { atomicReplaceRegularFile, openRegularFileNoFollow, readRegularFileNoFollow } from "./safe-files.ts";

/**
 * A plan's full-page map lives beside it as `<slug>.map.md`, marked by a
 * `plan: <slug>` frontmatter field. The marker, not the name, is what makes it
 * a map: the user owns this folder, so a `.map.md` file they wrote is still a
 * plan to list and never a map to overwrite.
 */
export const ONESHOT_MAP_SUFFIX = ".map.md";

function isOneshotMap(fileName: string, data: Record<string, string>): boolean {
  return fileName.endsWith(ONESHOT_MAP_SUFFIX) && data["plan"] === fileName.slice(0, -ONESHOT_MAP_SUFFIX.length);
}

export interface OneshotInput {
  title: string;
  system?: string;
  content: string;
}

export interface SavedOneshot {
  /** File name without `.md`; the stable identity exposed to the agent. */
  slug: string;
  displayName: string;
  /** Absolute runtime path, resolved by the store rather than model input. */
  path: string;
  data: Record<string, string>;
  body: string;
}

export function unslugOneshot(fileName: string): string {
  const words = fileName
    .replace(/\.md$/i, "")
    .replace(/-+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return words.replace(/(^|\s)\S/g, (match) => match.toUpperCase());
}

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
      // Revalidate the entry when opening because Dirent metadata can be stale.
      const { data, body } = parseFrontmatter(await readRegularFileNoFollow(path));
      if (isOneshotMap(entry.name, data)) continue;
      oneshots.push({
        slug: entry.name.slice(0, -3),
        displayName: unslugOneshot(entry.name),
        path,
        data,
        body,
      });
    } catch {
      // Keep readable documents when one entry fails.
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

export async function writeOneshot(saved: SavedOneshot, body: string): Promise<SavedOneshot> {
  const next = await updateFrontmatterFile(saved.path, (data) => ({ data, body }));
  return { ...saved, data: next.data, body: next.body };
}

/**
 * Write (or redraw) the plan's map file; `map` is the rendered page, fenced
 * here. Refuses to replace a file at that name that isn't this plan's map.
 */
export async function writeOneshotMap(saved: SavedOneshot, title: string, map: string): Promise<string> {
  const path = join(dirname(saved.path), `${saved.slug}${ONESHOT_MAP_SUFFIX}`);
  let existing: string | null = null;
  try {
    existing = await readRegularFileNoFollow(path);
  } catch (error) {
    // Anything but "not there" (a symlink, a folder) is also not ours to replace.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") existing = "";
  }
  if (existing !== null && !isOneshotMap(basename(path), parseFrontmatter(existing).data)) {
    throw new Error(`${basename(path)} already exists and isn't this plan's map; rename or move it to draw one`);
  }
  const content = serializeFrontmatter({ title, plan: saved.slug, updated: today() }, `\`\`\`text\n${map}\n\`\`\`\n`);
  if (!(await atomicReplaceRegularFile(path, content))) throw new Error("the one-shots folder is not a directory");
  return path;
}

export async function saveOneshot(dir: string, input: OneshotInput): Promise<string> {
  await mkdir(dir, { recursive: true });

  const slug = slugify(input.title) || "oneshot";
  const data: Record<string, string> = {
    title: input.title,
    created: today(),
  };
  if (input.system) data["system"] = input.system;
  const content = serializeFrontmatter(data, input.content);

  // Exclusive creation handles concurrent saves and refuses symlink targets.
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
