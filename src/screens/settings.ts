/**
 * Settings screen: edit model provider config (base URL, model, API key env
 * var name) and the campaigns directory. Values persist to config.json on
 * save. Escape or Back returns without saving.
 */
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import { makeButton } from "../ui.ts";
import { theme } from "../theme.ts";
import { expandHome, type Settings } from "../store/settings.ts";
import type { Screen } from "./screen.ts";

export interface SettingsScreenOptions {
  settings: Settings;
  onSaved: (next: Settings) => void;
  onBack: () => void;
}

export async function makeSettingsScreen(
  renderer: CliRenderer,
  options: SettingsScreenOptions,
): Promise<Screen> {
  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    padding: 1,
    flexDirection: "column",
  });
  container.add(new TextRenderable(renderer, { content: "Settings", fg: theme.accent, marginBottom: 1 }));

  const fieldLabel = (label: string): TextRenderable =>
    new TextRenderable(renderer, { content: label, fg: theme.textMuted, marginBottom: 1 });
  const field = (value: string, placeholder: string): InputRenderable =>
    new InputRenderable(renderer, {
      value,
      placeholder,
      width: "100%",
      backgroundColor: theme.surfaceRaised,
      focusedBackgroundColor: theme.surfaceActive,
      marginBottom: 1,
    });

  container.add(fieldLabel("Base URL (OpenAI-compatible)"));
  const baseUrlInput = field(options.settings.baseUrl ?? "", "https://api.openai.com/v1");
  container.add(baseUrlInput);

  container.add(fieldLabel("Model"));
  const modelInput = field(options.settings.model ?? "", "gpt-4o-mini");
  container.add(modelInput);

  container.add(fieldLabel("API key env var (never the key itself)"));
  const keyInput = field(options.settings.apiKeyEnv ?? "", "OPENAI_API_KEY");
  container.add(keyInput);

  container.add(fieldLabel("Campaigns directory"));
  const dirInput = field(options.settings.campaignsDir, "~/Scribe");
  container.add(dirInput);

  const status = new TextRenderable(renderer, { content: "", fg: theme.danger, height: 1 });
  container.add(status);

  const saveButton = makeButton(renderer, { label: "Save", variant: "primary", onClick: save });
  const backButton = makeButton(renderer, { label: "Back", onClick: leave });
  const buttonRow = new BoxRenderable(renderer, { flexDirection: "row" });
  buttonRow.add(saveButton);
  buttonRow.add(new BoxRenderable(renderer, { width: 2 }));
  buttonRow.add(backButton);
  container.add(buttonRow);

  const focusChain: Renderable[] = [baseUrlInput, modelInput, keyInput, dirInput, saveButton, backButton];

  function save(): void {
    const campaignsDir = dirInput.value.trim();
    if (campaignsDir === "") {
      status.content = "Campaigns directory is required";
      dirInput.focus();
      return;
    }
    options.onSaved({
      campaignsDir: expandHome(campaignsDir),
      baseUrl: baseUrlInput.value.trim() || undefined,
      model: modelInput.value.trim() || undefined,
      apiKeyEnv: keyInput.value.trim() || undefined,
    });
  }

  const onKeypress = (key: KeyEvent): void => {
    if (key.name === "escape") {
      key.preventDefault();
      leave();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      const index = focusChain.indexOf(renderer.currentFocusedRenderable as Renderable);
      const direction = key.shift ? -1 : 1;
      focusChain[(index + direction + focusChain.length) % focusChain.length]?.focus();
    }
  };

  // dispose() only cleans up listeners (called by the screen manager on
  // navigation); leave() is the explicit user action that also navigates back.
  function dispose(): void {
    renderer.keyInput.off("keypress", onKeypress);
  }
  function leave(): void {
    dispose();
    options.onBack();
  }

  // Enter in a field moves to the next one; Save/Back handled on the buttons.
  const advance = (from: Renderable): void => {
    const index = focusChain.indexOf(from);
    focusChain[index + 1]?.focus();
  };
  baseUrlInput.on(InputRenderableEvents.ENTER, () => advance(baseUrlInput));
  modelInput.on(InputRenderableEvents.ENTER, () => advance(modelInput));
  keyInput.on(InputRenderableEvents.ENTER, () => advance(keyInput));
  dirInput.on(InputRenderableEvents.ENTER, () => advance(dirInput));

  saveButton.onKeyDown = (key) => {
    if (key.name === "return") save();
  };
  backButton.onKeyDown = (key) => {
    if (key.name === "return") leave();
  };

  renderer.keyInput.on("keypress", onKeypress);
  baseUrlInput.focus();

  return { node: container, focus: () => baseUrlInput.focus(), dispose };
}
