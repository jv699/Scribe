import { basename, dirname, join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { isScribePlanPdf } from "../pdf.ts";
import { parseFrontmatter, serializeFrontmatter, updateFrontmatterFile } from "./frontmatter.ts";
import { slugify, today } from "./naming.ts";
import { atomicReplaceRegularFile, createUniqueMarkdown, readRegularFileNoFollow } from "./safe-files.ts";

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
/**
 * What is at `path` before a write replaces it: its text, null when nothing
 * is there, or "" when it isn't a regular file (a symlink, a folder) — which
 * is never ours to replace. Any other failure to read it (permissions, I/O)
 * throws with the real cause instead of passing for someone else's file.
 */
async function readExisting(path: string): Promise<string | null> {
  try {
    return await readRegularFileNoFollow(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    // ELOOP/EMLINK: a symlink refused by O_NOFOLLOW; no code: not a regular file.
    if (code === undefined || code === "ELOOP" || code === "EMLINK" || code === "EISDIR") return "";
    throw new Error(`couldn't read the existing ${basename(path)} to check it (${code})`);
  }
}

export async function writeOneshotMap(saved: SavedOneshot, title: string, map: string): Promise<string> {
  const path = join(dirname(saved.path), `${saved.slug}${ONESHOT_MAP_SUFFIX}`);
  const existing = await readExisting(path);
  if (existing !== null && !isOneshotMap(basename(path), parseFrontmatter(existing).data)) {
    throw new Error(`${basename(path)} already exists and isn't this plan's map; rename or move it to draw one`);
  }
  const content = serializeFrontmatter({ title, plan: saved.slug, updated: today() }, `\`\`\`text\n${map}\n\`\`\`\n`);
  if (!(await atomicReplaceRegularFile(path, content))) throw new Error("the one-shots folder is not a directory");
  return path;
}

/**
 * The plan's map page, if `<slug>.map.md` is this plan's map (by its `plan:`
 * marker): the fenced text `writeOneshotMap` wrote, or null.
 */
export async function readOneshotMap(saved: SavedOneshot): Promise<string | null> {
  const path = join(dirname(saved.path), `${saved.slug}${ONESHOT_MAP_SUFFIX}`);
  let content: string;
  try {
    content = await readRegularFileNoFollow(path);
  } catch {
    return null;
  }
  const { data, body } = parseFrontmatter(content);
  if (!isOneshotMap(basename(path), data)) return null;
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```/m.exec(body);
  return fenced ? fenced[1]! : null;
}

/**
 * A plan's printable copy lives beside it as `<slug>.pdf`. Like the map, it
 * is only ever replaced when it is Scribe's own printout of this plan (by the
 * marker `renderPlanPdf` records from `slug`): a PDF the user put there under
 * that name is refused rather than overwritten.
 */
export async function writeOneshotPdf(saved: SavedOneshot, bytes: Uint8Array): Promise<string> {
  const path = join(dirname(saved.path), `${saved.slug}.pdf`);
  const existing = await readExisting(path);
  if (existing !== null && !isScribePlanPdf(existing, saved.slug)) {
    throw new Error(`${basename(path)} already exists and wasn't made by Scribe; rename or move it to export a PDF`);
  }
  if (!(await atomicReplaceRegularFile(path, bytes))) throw new Error("the one-shots folder is not a directory");
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
  return createUniqueMarkdown(dir, slug, content);
}
