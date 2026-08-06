/**
 * Markdown-first persistence for saved one-shot plans: one file per plan in a
 * configurable `oneshotsDir` (`<slug>.md`) with flat frontmatter (title,
 * system, created) and the plan markdown as the body. Colliding names get a
 * numeric suffix.
 */
import { join } from "node:path";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { serializeFrontmatter } from "./frontmatter.ts";
import { slugify } from "./naming.ts";

export interface OneshotInput {
  title: string;
  system?: string;
  content: string;
}

/** Write a one-shot plan to `dir`, returning the absolute path written. */
export async function saveOneshot(dir: string, input: OneshotInput): Promise<string> {
  await mkdir(dir, { recursive: true });

  const slug = slugify(input.title) || "oneshot";
  const existing = await readdir(dir);
  let fileName = `${slug}.md`;
  for (let i = 2; existing.includes(fileName); i++) {
    fileName = `${slug}-${i}.md`;
  }

  const data: Record<string, string> = {
    title: input.title,
    created: new Date().toISOString().slice(0, 10),
  };
  if (input.system) data["system"] = input.system;

  const path = join(dir, fileName);
  await writeFile(path, serializeFrontmatter(data, input.content), "utf8");
  return path;
}
