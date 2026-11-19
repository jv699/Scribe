/**
 * ScribeBench results: one folder per run under the bench dir, holding the
 * prompt and one markdown file per model. Written as each model finishes, so
 * a run that cost money is on disk even if the user leaves straight away.
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { serializeFrontmatter } from "./frontmatter.ts";
import { slugify, today } from "./naming.ts";
import { createUniqueMarkdown } from "./safe-files.ts";

/** How much of the prompt names the run folder. */
const PROMPT_SLUG_LENGTH = 40;

export interface BenchResult {
  model: string;
  baseUrl: string;
  status: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  /** Omitted when the provider doesn't publish pricing. */
  cost?: number;
  toolCalls: number;
  /** The final answer, or the error for a run that didn't finish. */
  body: string;
}

/** Create `<date>-<prompt slug>/` with its `prompt.md`; returns the folder. */
export async function createBenchRunFolder(benchDir: string, prompt: string, models: number): Promise<string> {
  await mkdir(benchDir, { recursive: true });
  const slug = slugify(prompt.slice(0, PROMPT_SLUG_LENGTH)) || "run";
  const stem = `${today()}-${slug}`;
  for (let suffix = 1; ; suffix++) {
    const folder = join(benchDir, suffix === 1 ? stem : `${stem}-${suffix}`);
    try {
      await mkdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    await createUniqueMarkdown(folder, "prompt", serializeFrontmatter({ date: today(), models: String(models) }, `${prompt.trim()}\n`));
    return folder;
  }
}

/** Write one model's result beside the prompt; the same model twice gets `-2`. */
export async function writeBenchResult(folder: string, result: BenchResult): Promise<string> {
  const data: Record<string, string> = {
    model: result.model,
    baseUrl: result.baseUrl,
    status: result.status,
    durationMs: String(Math.round(result.durationMs)),
    promptTokens: String(result.promptTokens),
    completionTokens: String(result.completionTokens),
  };
  if (result.cost !== undefined) data["cost"] = result.cost.toFixed(6);
  data["toolCalls"] = String(result.toolCalls);
  const stem = slugify(result.model) || "model";
  // "prompt" is taken by the run's own prompt file.
  return createUniqueMarkdown(folder, stem === "prompt" ? "prompt-model" : stem, serializeFrontmatter(data, `${result.body.trim()}\n`));
}
