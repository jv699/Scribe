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
import { showModelPickerDialog } from "../components/model-picker-dialog.ts";
import { theme } from "../theme.ts";
import { abbreviateHome, defaultConfigDir, expandHome, type Settings } from "../store/settings.ts";
import { DEFAULT_BASE_URL, listModelInfos } from "../provider/openai.ts";
import type { Screen } from "./screen.ts";

export interface SettingsScreenOptions {
  settings: Settings;
  onSaved: (next: Settings) => void | Promise<void>;
  onBack: () => void;
}

export async function makeSettingsScreen(
  renderer: CliRenderer,
  options: SettingsScreenOptions,
): Promise<Screen> {
  // True while the model picker owns the keyboard (see onKeypress).
  let modalOpen = false;
  let modelLoading = false;
  let modelRequest = 0;
  let closeModelPicker: (() => void) | undefined;
  let saving = false;
  let disposed = false;
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
  const modelRow = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", marginBottom: 1 });
  const modelInput = new InputRenderable(renderer, {
    value: options.settings.model ?? "",
    placeholder: "gpt-4o-mini",
    flexGrow: 1,
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
  });
  modelRow.add(modelInput);
  modelRow.add(new BoxRenderable(renderer, { width: 2 }));
  const browseButton = makeButton(renderer, { label: "Browse...", onClick: browseModels });
  modelRow.add(browseButton);
  container.add(modelRow);

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

  function setStatus(message: string, tone: "error" | "info" = "error"): void {
    if (disposed) return;
    status.content = message;
    status.fg = tone === "error" ? theme.danger : theme.textMuted;
  }

  async function browseModels(): Promise<void> {
    if (disposed || modalOpen || modelLoading) return;
    modelLoading = true;
    const mine = ++modelRequest;
    setStatus("Loading models...", "info");
    try {
      const apiKeyEnv = keyInput.value.trim();
      const models = await listModelInfos({
        baseUrl: baseUrlInput.value.trim() || DEFAULT_BASE_URL,
        apiKey: apiKeyEnv ? (process.env[apiKeyEnv] ?? "") : "",
      });
      if (disposed || mine !== modelRequest) return;
      if (models.length === 0) {
        setStatus("No models returned by the provider");
        return;
      }
      setStatus("", "info");
      modalOpen = true;
      closeModelPicker = showModelPickerDialog(renderer, {
        models,
        onPick: (model) => {
          if (disposed) return;
          modelInput.value = model;
          modelInput.focus();
        },
        onClose: () => {
          closeModelPicker = undefined;
          modalOpen = false;
          if (disposed) return;
          modelInput.focus();
        },
      });
    } catch (error) {
      if (disposed || mine !== modelRequest) return;
      setStatus(error instanceof Error ? error.message : "Failed to load models");
    } finally {
      if (mine === modelRequest) modelLoading = false;
    }
  }

  const saveButton = makeButton(renderer, { label: "Save", variant: "primary", onClick: () => void save() });
  const backButton = makeButton(renderer, { label: "Back", onClick: leave });
  const buttonRow = new BoxRenderable(renderer, { flexDirection: "row" });
  buttonRow.add(saveButton);
  buttonRow.add(new BoxRenderable(renderer, { width: 2 }));
  buttonRow.add(backButton);
  container.add(buttonRow);

  const focusChain: Renderable[] = [
    baseUrlInput,
    modelInput,
    browseButton,
    keyInput,
    dirInput,
    oneshotsInput,
    sourcesInput,
    saveButton,
    backButton,
  ];

  async function save(): Promise<void> {
    if (disposed || saving) return;
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
      ...options.settings,
      campaignsDir: expandHome(campaignsDir),
      oneshotsDir: expandHome(oneshotsDir),
      sourcesDir: expandHome(sourcesDir),
    };
    const baseUrl = baseUrlInput.value.trim();
    if (baseUrl !== "") next.baseUrl = baseUrl;
    else delete next.baseUrl;
    const model = modelInput.value.trim();
    if (model !== "") next.model = model;
    else delete next.model;
    const apiKeyEnv = keyInput.value.trim();
    if (apiKeyEnv !== "") next.apiKeyEnv = apiKeyEnv;
    else delete next.apiKeyEnv;

    saving = true;
    setStatus("Saving...", "info");
    try {
      await options.onSaved(next);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save settings");
    } finally {
      saving = false;
    }
  }

  const onKeypress = (key: KeyEvent): void => {
    // The model picker registers its own keypress listener; without this guard
    // its Escape would also reach us and navigate the whole screen away.
    if (modalOpen) return;
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
    if (disposed) return;
    disposed = true;
    modelRequest++;
    closeModelPicker?.();
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
