export function sanitizeFolderName(name: string): string {
  const cleaned = name
    .replace(/[<>:"\/\\|?*\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  // Dot-only names can escape the campaign directory.
  return /^\.*$/.test(cleaned) ? "Campaign" : cleaned;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Keeps `ext` after any collision suffix so the resulting extension remains valid. */
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
