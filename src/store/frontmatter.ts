/**
 * Minimal frontmatter handling: flat `key: value` lines between `---` fences.
 * Deliberately NOT YAML — see PLAN.md ("no YAML dependency"). Multi-line
 * content belongs in the markdown body, not in frontmatter.
 */
import { readFile, writeFile } from "node:fs/promises";

export interface FrontmatterDoc {
  data: Record<string, string>;
  body: string;
}

const FENCE = "---";

export function parseFrontmatter(content: string): FrontmatterDoc {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== FENCE) {
    return { data: {}, body: content };
  }

  const data: Record<string, string> = {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === FENCE) {
      end = i;
      break;
    }
    const colon = line.indexOf(":");
    if (colon > 0) {
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (key !== "") data[key] = value;
    }
  }

  // No closing fence: treat the whole file as body (defensive).
  if (end === -1) {
    return { data: {}, body: content };
  }

  return { data, body: lines.slice(end + 1).join("\n") };
}

export function serializeFrontmatter(data: Record<string, string>, body: string): string {
  const lines = [FENCE];
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push(FENCE, "");
  return lines.join("\n") + body.replace(/^\n+/, "");
}

/**
 * Read a frontmatter file, let `update` compute the new data/body, and write
 * the result back. Consolidates the read-parse-modify-serialize-write
 * sequence duplicated across campaigns.ts and sessions.ts.
 */
export async function updateFrontmatterFile(
  path: string,
  update: (data: Record<string, string>, body: string) => FrontmatterDoc,
): Promise<FrontmatterDoc> {
  const { data, body } = parseFrontmatter(await readFile(path, "utf8"));
  const next = update(data, body);
  await writeFile(path, serializeFrontmatter(next.data, next.body), "utf8");
  return next;
}
