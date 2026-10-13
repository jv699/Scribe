import type { RenderContext } from "@opentui/core";
import { formatTokenCount } from "../format.ts";
import type { ModelInfo } from "../provider/types.ts";
import { makeCombobox, type Combobox } from "./combobox.ts";

export interface ModelComboboxOptions {
  value?: string;
  placeholder?: string;
  loadModels: () => Promise<ModelInfo[]>;
  onError?: (message: string) => void;
  maxRows?: number;
}

export type ModelCombobox = Combobox;

function describe(model: ModelInfo): string {
  const parts: string[] = [];
  if (model.name && model.name !== model.id) parts.push(model.name);
  if (model.contextLength) parts.push(`${formatTokenCount(model.contextLength)} ctx`);
  return parts.join(" · ");
}

export function makeModelCombobox(ctx: RenderContext, options: ModelComboboxOptions): ModelCombobox {
  return makeCombobox(ctx, {
    ...(options.value !== undefined ? { value: options.value } : {}),
    ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
    messages: {
      loading: "Loading models…",
      empty: "No models returned by provider",
      noMatch: "No matching models",
    },
    loadItems: async () =>
      (await options.loadModels()).map((model) => ({
        value: model.id,
        description: describe(model),
        ...(model.name ? { keywords: model.name } : {}),
      })),
  });
}
