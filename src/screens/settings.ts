/**
 * Settings screen: edit model provider config (base URL, model, API key env
 * var name) and the campaigns / one-shots directories. Values persist to
 * config.json on save. Escape or Back returns without saving.
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
import { makeButton, tabWalk } from "../components/ui.ts";
import { theme } from "../theme.ts";
import { abbreviateHome, defaultConfigDir, expandHome, type Settings } from "../store/settings.ts";
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
  const titleRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    marginBottom: 1,
  });
  titleRow.add(new TextRenderable(renderer, { content: "Settings", fg: theme.accent }));
  titleRow.add(new TextRenderable(renderer, { content: abbreviateHome(defaultConfigDir()), fg: theme.textMuted }));
  container.add(titleRow);

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

  container.add(fieldLabel("One-shots directory"));
  const oneshotsInput = field(options.settings.oneshotsDir, "~/Scribe/One-Shots");
  container.add(oneshotsInput);

  container.add(fieldLabel("Sources directory"));
  const sourcesInput = field(options.settings.sourcesDir, "~/Scribe/Sources");
  container.add(sourcesInput);

  const status = new TextRenderable(renderer, { content: "", fg: theme.danger, height: 1 });
  container.add(status);

  const saveButton = makeButton(renderer, { label: "Save", variant: "primary", onClick: save });
  const backButton = makeButton(renderer, { label: "Back", onClick: leave });
  const buttonRow = new BoxRenderable(renderer, { flexDirection: "row" });
  buttonRow.add(saveButton);
  buttonRow.add(new BoxRenderable(renderer, { width: 2 }));
  buttonRow.add(backButton);
  container.add(buttonRow);

  const focusChain: Renderable[] = [
    baseUrlInput,
    modelInput,
    keyInput,
    dirInput,
    oneshotsInput,
    sourcesInput,
    saveButton,
    backButton,
  ];

  function save(): void {
    const campaignsDir = dirInput.value.trim();
    if (campaignsDir === "") {
      status.content = "Campaigns directory is required";
      dirInput.focus();
      return;
    }
    const oneshotsDir = oneshotsInput.value.trim();
    if (oneshotsDir === "") {
      status.content = "One-shots directory is required";
      oneshotsInput.focus();
      return;
    }
    const sourcesDir = sourcesInput.value.trim();
    if (sourcesDir === "") {
      status.content = "Sources directory is required";
      sourcesInput.focus();
      return;
    }
    const next: Settings = {
      campaignsDir: expandHome(campaignsDir),
      oneshotsDir: expandHome(oneshotsDir),
      sourcesDir: expandHome(sourcesDir),
    };
    const baseUrl = baseUrlInput.value.trim();
    if (baseUrl !== "") next.baseUrl = baseUrl;
    const model = modelInput.value.trim();
    if (model !== "") next.model = model;
    const apiKeyEnv = keyInput.value.trim();
    if (apiKeyEnv !== "") next.apiKeyEnv = apiKeyEnv;
    options.onSaved(next);
  }

  const onKeypress = (key: KeyEvent): void => {
    if (key.name === "escape") {
      key.preventDefault();
      leave();
      return;
    }
    tabWalk(renderer, focusChain, key);
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
  for (const input of [baseUrlInput, modelInput, keyInput, dirInput, oneshotsInput, sourcesInput]) {
    input.on(InputRenderableEvents.ENTER, () => advance(input));
  }

  renderer.keyInput.on("keypress", onKeypress);
  baseUrlInput.focus();

  return { node: container, focus: () => baseUrlInput.focus(), dispose };
}
