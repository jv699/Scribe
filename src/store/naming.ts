/**
 * Filesystem-safe naming helpers.
 *
 * Campaign folders keep the human-readable name ("Curse of Strahd"), only
 * stripping characters that are illegal in paths. Session files use a
 * lowercase slug ("001-death-house.md").
 */

/** Strip characters that are illegal or troublesome in file/folder names. */
export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(/[<>:"\/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  // A name made only of dots ("." or "..") survives the strip above but would
  // resolve to the campaigns folder itself or its parent, writing campaign
  // files outside the confined directory. Fall back like slugify does.
  return /^\.*$/.test(cleaned) ? "Campaign" : cleaned;
}

/** Lowercase slug for file names: "Death House!" -> "death-house" */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Today's date as an ISO "YYYY-MM-DD" string, for frontmatter `created`/`ready`/`played` stamps. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pick a name that doesn't collide with existing entries.
 *
 * `ext` is appended after the disambiguating counter rather than before it, so
 * file names stay valid ("001-death-house-2.md", not "001-death-house.md 2" —
 * the latter no longer ends in .md and would be filtered out of listings).
 */
export function uniqueName(
  desired: string,
  existing: readonly string[],
  opts: { ext?: string; separator?: string } = {},
): string {
  const { ext = "", separator = " " } = opts;
  if (!existing.includes(desired + ext)) return desired + ext;
  for (let i = 2; ; i++) {
    const candidate = `${desired}${separator}${i}${ext}`;
    if (!existing.includes(candidate)) return candidate;
  }
}
