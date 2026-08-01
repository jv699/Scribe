/**
 * Filesystem-safe naming helpers.
 *
 * Campaign folders keep the human-readable name ("Curse of Strahd"), only
 * stripping characters that are illegal in paths. Session files use a
 * lowercase slug ("001-death-house.md").
 */

/** Strip characters that are illegal or troublesome in file/folder names. */
export function sanitizeFolderName(name: string): string {
  return name
    .replace(/[<>:"\/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercase slug for file names: "Death House!" -> "death-house" */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Pick a folder name that doesn't collide with existing entries. */
export function uniqueName(desired: string, existing: readonly string[]): string {
  if (!existing.includes(desired)) return desired;
  for (let i = 2; ; i++) {
    const candidate = `${desired} ${i}`;
    if (!existing.includes(candidate)) return candidate;
  }
}
