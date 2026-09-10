import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { mkdir, readdir, rename, type FileHandle } from "node:fs/promises";
import type { Campaign } from "./campaigns.ts";
import { parseFrontmatter, serializeFrontmatter, updateFrontmatterFile } from "./frontmatter.ts";
import { slugify, uniqueName } from "./naming.ts";
import { isDirectoryNoFollow, openRegularFileNoFollow, readRegularFileNoFollow } from "./safe-files.ts";

export interface Character {
  name: string;
  className: string;
  description: string;
  /** Absolute runtime path. The filename remains stable when the character is renamed. */
  path: string;
  /** Raw file contents used for best-effort edit conflict detection. */
  revision: string;
}

export interface CharacterInput {
  name: string;
  className: string;
  description: string;
}

const CHARACTERS_DIR = "characters";

function characterFromMarkdown(path: string, content: string): Character {
  const { data, body } = parseFrontmatter(content);
  return {
    name: data["name"] ?? basename(path, ".md"),
    className: data["class"] ?? "",
    description: body.trim(),
    path,
    revision: content,
  };
}

async function assertCharacterPath(campaign: Campaign, path: string): Promise<void> {
  if (dirname(path) !== join(campaign.dir, CHARACTERS_DIR)) {
    throw new Error("Character does not belong to this campaign.");
  }
  if (!(await isDirectoryNoFollow(campaign.dir).catch(() => false))) {
    throw new Error("Campaign folder is unavailable.");
  }
  if (!(await isDirectoryNoFollow(dirname(path)).catch(() => false))) {
    throw new Error("characters is not a safe directory.");
  }
}

async function ensureChildDirectory(parent: string, name: string): Promise<string> {
  if (!(await isDirectoryNoFollow(parent).catch(() => false))) throw new Error("Campaign folder is unavailable.");
  const path = join(parent, name);
  await mkdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await isDirectoryNoFollow(path).catch(() => false))) throw new Error(`${name} is not a safe directory.`);
  return path;
}

export async function listCharacters(campaign: Campaign): Promise<Character[]> {
  const charactersDir = join(campaign.dir, CHARACTERS_DIR);
  let entries;
  try {
    if (!(await isDirectoryNoFollow(campaign.dir)) || !(await isDirectoryNoFollow(charactersDir))) return [];
    entries = await readdir(charactersDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const characters: Character[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(charactersDir, entry.name);
    try {
      characters.push(characterFromMarkdown(path, await readRegularFileNoFollow(path)));
    } catch {
      // Keep readable characters when one entry fails.
    }
  }
  return characters.sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
}

export async function createCharacter(campaign: Campaign, input: CharacterInput): Promise<Character> {
  const charactersDir = await ensureChildDirectory(campaign.dir, CHARACTERS_DIR);
  const existing = await readdir(charactersDir);
  const base = slugify(input.name) || "character";
  const fileName = uniqueName(base, existing, { ext: ".md", separator: "-" });
  const path = join(charactersDir, fileName);
  const content = serializeFrontmatter({ name: input.name, class: input.className }, `${input.description.trim()}\n`);
  let file: FileHandle | undefined;
  try {
    file = await openRegularFileNoFollow(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o666,
    );
    await file.writeFile(content, "utf8");
  } finally {
    await file?.close();
  }
  return characterFromMarkdown(path, content);
}

export async function updateCharacter(
  campaign: Campaign,
  character: Character,
  input: CharacterInput,
): Promise<Character> {
  await assertCharacterPath(campaign, character.path);
  const current = await readRegularFileNoFollow(character.path);
  if (current !== character.revision) throw new Error("Character changed on disk; reload before saving.");
  const next = await updateFrontmatterFile(character.path, (data) => ({
    data: { ...data, name: input.name, class: input.className },
    body: `${input.description.trim()}\n`,
  }));
  return characterFromMarkdown(character.path, serializeFrontmatter(next.data, next.body));
}

export async function trashCharacter(campaign: Campaign, character: Character): Promise<void> {
  await assertCharacterPath(campaign, character.path);
  const current = await readRegularFileNoFollow(character.path);
  if (current !== character.revision) throw new Error("Character changed on disk; reload before removing.");
  const scribeDir = await ensureChildDirectory(campaign.dir, ".scribe");
  const trashRoot = await ensureChildDirectory(scribeDir, "trash");
  const trashDir = await ensureChildDirectory(trashRoot, "characters");
  const existing = await readdir(trashDir);
  const original = basename(character.path);
  const stem = original.endsWith(".md") ? original.slice(0, -3) : original;
  const target = uniqueName(stem, existing, { ext: ".md", separator: "-" });
  await rename(character.path, join(trashDir, target));
}
