import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  RenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import { isAbsolute } from "node:path";
import { makeCombobox } from "../components/combobox.ts";
import { makeActionDialog } from "../components/action-dialog.ts";
import { makeQuitGuard } from "../components/confirm-dialog.ts";
import { makeModelCombobox } from "../components/model-combobox.ts";
import { makeButton, tabWalk, TEXT_FIELD_KEYS } from "../components/ui.ts";
import { theme } from "../theme.ts";
import { abbreviateHome, defaultConfigDir, expandHome, type Settings } from "../store/settings.ts";
import { DEFAULT_BASE_URL, DEFAULT_MODEL, listModelInfos, testConnection } from "../provider/openai.ts";
import { PROVIDER_PRESETS } from "../provider/presets.ts";
import type { Screen } from "./screen.ts";

export interface SettingsScreenOptions {
  settings: Settings;
  onSaved: (next: Settings) => void | Promise<void>;
  onBack: () => void;
}

const LABEL_WIDTH = 22;
const CHECK_WIDTH = 13;
const TEST_TIMEOUT_MS = 20_000;

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KEY_PREFIX = /^(sk|pk|gsk|xai|key)[-_]/i;

/**
 * Whether the "env var" field holds a pasted key rather than a variable's
 * name. A name that resolves in this environment is always taken as a name.
 */
export function looksLikeApiKey(value: string): boolean {
  if (process.env[value] !== undefined) return false;
  if (KEY_PREFIX.test(value)) return true;
  return value.length >= 20 && /[a-z]/.test(value) && /\d/.test(value);
}

export async function makeSettingsScreen(
  renderer: CliRenderer,
  options: SettingsScreenOptions,
): Promise<Screen> {
  let saving = false;
  let disposed = false;
  let modalOpen = false;
  // Which part of the screen wrote the status line, so each can retract only its own message.
  let statusOwner: "listing" | "check" | null = null;
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

  const hint = new TextRenderable(renderer, { content: "", fg: theme.textMuted, height: 1 });

  // One label-beside-control row per setting, so the whole form fits a 24-row
  // terminal. Earlier rows stack above later ones because a dropdown hangs
  // below its field, over the rows that follow.
  let rowCount = 0;
  function addRow(
    label: string,
    control: Renderable,
    focusTarget: Renderable,
    help: string,
    trailing?: Renderable,
  ): void {
    const row = new BoxRenderable(renderer, { flexDirection: "row", width: "100%", zIndex: 100 - rowCount++ });
    row.add(new TextRenderable(renderer, { content: label, fg: theme.textMuted, width: LABEL_WIDTH, flexShrink: 0 }));
    const slot = new BoxRenderable(renderer, { flexGrow: 1, flexShrink: 1, flexBasis: 0 });
    slot.add(control);
    row.add(slot);
    if (trailing) row.add(trailing);
    container.add(row);
    showHintFor(focusTarget, help);
  }
  function showHintFor(target: Renderable, help: string): void {
    target.on(RenderableEvents.FOCUSED, () => {
      if (!disposed) hint.content = help;
    });
  }
  const field = (value: string, placeholder: string): InputRenderable =>
    new InputRenderable(renderer, {
      value,
      placeholder,
      width: "100%",
      backgroundColor: theme.surfaceRaised,
      focusedBackgroundColor: theme.surfaceActive,
      keyBindings: TEXT_FIELD_KEYS,
      placeholderColor: theme.textMuted,
      marginBottom: 1,
    });
  const addField = (label: string, value: string, placeholder: string, help: string): InputRenderable => {
    const input = field(value, placeholder);
    addRow(label, input, input, help);
    return input;
  };

  const baseUrlCombobox = makeCombobox(renderer, {
    value: options.settings.baseUrl ?? "",
    placeholder: DEFAULT_BASE_URL,
    maxRows: PROVIDER_PRESETS.length,
    loadItems: () =>
      PROVIDER_PRESETS.map((preset) => ({ value: preset.baseUrl, label: preset.name, description: preset.baseUrl })),
    onChange: () => {
      modelCombobox.invalidate();
      markCheckStale();
    },
  });
  const baseUrlInput = baseUrlCombobox.input;
  addRow(
    "Base URL",
    baseUrlCombobox.node,
    baseUrlInput,
    "Any OpenAI-compatible endpoint. Type a provider name, or press ↓ to browse.",
  );

  // The key comes before the model: listing models needs it.
  const keyInput = addField(
    "API key env var",
    options.settings.apiKeyEnv ?? "",
    "OPENAI_API_KEY",
    "The name of the environment variable holding your key, never the key itself.",
  );

  const modelCombobox = makeModelCombobox(renderer, {
    value: options.settings.model ?? "",
    placeholder: "gpt-4o-mini",
    loadModels: () => {
      const apiKeyEnv = keyInput.value.trim();
      return listModelInfos({
        baseUrl: baseUrlInput.value.trim() || DEFAULT_BASE_URL,
        apiKey: apiKeyEnv ? (process.env[apiKeyEnv] ?? "") : "",
      });
    },
    onError: (message) => {
      if (message === "") retractStatus("listing");
      else setStatus(message, "error", "listing");
    },
    onChange: () => markCheckStale(),
    // Picking a model is the moment to find out whether it answers.
    onPick: () => void checkConnection("auto"),
  });
  const modelInput = modelCombobox.input;
  // The connection check's verdict, beside the model it is about.
  const checkMark = new TextRenderable(renderer, {
    content: "",
    fg: theme.textMuted,
    width: CHECK_WIDTH,
    flexShrink: 0,
    marginLeft: 1,
  });
  addRow(
    "Model",
    modelCombobox.node,
    modelInput,
    "Type to search the provider's models, or ↓ to browse. Picking one tests it.",
    checkMark,
  );

  const dirInput = addField(
    "Campaigns directory",
    abbreviateHome(options.settings.campaignsDir),
    "~/Scribe",
    "One folder per campaign lives here. Changing it does not move existing campaigns.",
  );
  const oneshotsInput = addField(
    "One-shots directory",
    abbreviateHome(options.settings.oneshotsDir),
    "~/Scribe/One-Shots",
    "Plans saved from the Drafting Table live here. Changing it does not move them.",
  );
  const sourcesInput = addField(
    "Sources directory",
    abbreviateHome(options.settings.sourcesDir),
    "~/Scribe/Sources",
    "Reference PDFs live here, one folder per system. Changing it does not move them.",
  );

  container.add(hint);
  // Last on the screen, so a long provider error can wrap without moving anything.
  const status = new TextRenderable(renderer, { content: "", fg: theme.danger, wrapMode: "word" });

  function setStatus(message: string, tone: "error" | "info" = "error", owner: typeof statusOwner = null): void {
    if (disposed) return;
    statusOwner = message === "" ? null : owner;
    status.content = message;
    status.fg = tone === "error" ? theme.danger : theme.textMuted;
  }
  /** Clear the status line only if `owner` wrote what is on it. */
  function retractStatus(owner: NonNullable<typeof statusOwner>): void {
    if (statusOwner === owner) setStatus("");
  }

  const saveButton = makeButton(renderer, { label: "Save", variant: "primary", onClick: () => void save() });
  const testButton = makeButton(renderer, { label: "Test connection", onClick: () => void checkConnection("manual") });
  const cancelButton = makeButton(renderer, { label: "Cancel", onClick: requestLeave });
  const buttonRow = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0 });
  buttonRow.add(saveButton);
  buttonRow.add(new BoxRenderable(renderer, { width: 2 }));
  buttonRow.add(testButton);
  buttonRow.add(new BoxRenderable(renderer, { width: 2 }));
  buttonRow.add(cancelButton);
  container.add(buttonRow);
  container.add(status);
  showHintFor(saveButton, "Saves these settings and returns to the menu.");
  showHintFor(testButton, "Sends a one-line message to the model using the values above, saved or not.");
  showHintFor(cancelButton, "Returns to the menu without saving.");

  const inputs = [baseUrlInput, keyInput, modelInput, dirInput, oneshotsInput, sourcesInput];
  const focusChain: Renderable[] = [...inputs, saveButton, testButton, cancelButton];
  // What is on disk: the baseline for "unsaved", and what a save builds on.
  const saved = options.settings;
  const savedValues = inputs.map((input) => input.value);
  const isDirty = (): boolean => inputs.some((input, index) => input.value !== savedValues[index]);

  function reject(input: InputRenderable, message: string): void {
    setStatus(message);
    input.focus();
  }

  /** The base URL (blank means the default), or null after refusing one no request could use. */
  function readBaseUrl(): string | null {
    const baseUrl = baseUrlInput.value.trim();
    if (baseUrl !== "" && !/^https?:\/\/\S+$/i.test(baseUrl)) {
      reject(baseUrlInput, "The base URL must start with http:// or https://");
      return null;
    }
    return baseUrl;
  }

  /** An absolute directory path, or null after refusing a blank or relative one. */
  function readDir(input: InputRenderable, name: string): string | null {
    const dir = expandHome(input.value.trim());
    if (dir === "") {
      reject(input, `${name} directory is required`);
      return null;
    }
    // A relative path would resolve against wherever Scribe was launched from.
    if (!isAbsolute(dir)) {
      reject(input, `${name} directory must be a full path, starting with / or ~/`);
      return null;
    }
    return dir;
  }

  /** The key variable's name, or null after refusing one that can't be saved or used. */
  function readKeyVar(): string | null {
    const apiKeyEnv = keyInput.value.trim();
    if (apiKeyEnv !== "" && looksLikeApiKey(apiKeyEnv)) {
      // Take it off the screen too; it would only be refused again.
      keyInput.value = "";
      reject(keyInput, "That looks like an API key. Export it in your shell and enter the variable's name here.");
      return null;
    }
    if (apiKeyEnv !== "" && !ENV_VAR_NAME.test(apiKeyEnv)) {
      reject(keyInput, "An environment variable name can only use letters, digits, and underscores");
      return null;
    }
    return apiKeyEnv;
  }

  // A connection check sends the request a chat would make, with what is in
  // the fields now, saved or not. Each one is a real (if tiny) model request,
  // so "auto" checks run only when a model is picked or an edited model field
  // is left, never per keystroke. Any edit to the provider fields makes the
  // last verdict stale, and a newer check supersedes an older one in flight.
  let checkGeneration = 0;
  // What the last check was about, so leaving the field after a pick doesn't repeat it.
  let lastChecked = "";
  let modelOnFocus = modelInput.value;
  const checkSubject = (): string => [baseUrlInput.value, keyInput.value, modelInput.value].join("\n");

  function setCheckMark(content: string, fg: string): void {
    if (!disposed) {
      checkMark.content = content;
      checkMark.fg = fg;
    }
  }

  function markCheckStale(): void {
    // The edit buffer reports its starting text as a change; that edits nothing.
    if (checkSubject() === lastChecked) return;
    checkGeneration++;
    setCheckMark("", theme.textMuted);
    retractStatus("check");
  }

  async function checkConnection(mode: "auto" | "manual"): Promise<void> {
    if (disposed) return;
    lastChecked = checkSubject();
    const mine = ++checkGeneration;
    // Whatever the last verdict was, it no longer stands; a refusal below leaves no verdict at all.
    setCheckMark("", theme.textMuted);
    const fail = (message: string): void => {
      setCheckMark("✗ failed", theme.danger);
      setStatus(message, "error", "check");
    };

    let baseUrl: string | null;
    let apiKeyEnv: string | null;
    if (mode === "manual") {
      // An explicit test points at whatever is in the way.
      baseUrl = readBaseUrl();
      if (baseUrl === null) return;
      apiKeyEnv = readKeyVar();
      if (apiKeyEnv === null) return;
    } else {
      // An automatic one never moves focus or edits a field under the user.
      baseUrl = baseUrlInput.value.trim();
      apiKeyEnv = keyInput.value.trim();
      if (baseUrl !== "" && !/^https?:\/\/\S+$/i.test(baseUrl)) {
        fail("The base URL must start with http:// or https://");
        return;
      }
      if (apiKeyEnv !== "" && (looksLikeApiKey(apiKeyEnv) || !ENV_VAR_NAME.test(apiKeyEnv))) {
        fail("The API key env var must be the name of an environment variable.");
        return;
      }
    }
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : "";
    if (apiKey === undefined) {
      fail(`The environment variable ${apiKeyEnv} is not set. Export it, then restart Scribe.`);
      if (mode === "manual") keyInput.focus();
      return;
    }

    const model = modelInput.value.trim() || DEFAULT_MODEL;
    setCheckMark("checking…", theme.textMuted);
    retractStatus("check");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        testConnection({
          baseUrl: baseUrl || DEFAULT_BASE_URL,
          model,
          apiKey,
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`No reply after ${TEST_TIMEOUT_MS / 1000} seconds. Check the base URL.`)),
            TEST_TIMEOUT_MS,
          );
        }),
      ]);
      if (mine === checkGeneration) setCheckMark("✓ connected", theme.success);
    } catch (error) {
      if (mine === checkGeneration) fail(error instanceof Error ? error.message : "Connection test failed");
    } finally {
      clearTimeout(timer);
    }
  }

  async function save(): Promise<void> {
    if (disposed || saving) return;
    const baseUrl = readBaseUrl();
    if (baseUrl === null) return;
    const apiKeyEnv = readKeyVar();
    if (apiKeyEnv === null) return;
    const campaignsDir = readDir(dirInput, "Campaigns");
    if (campaignsDir === null) return;
    const oneshotsDir = readDir(oneshotsInput, "One-shots");
    if (oneshotsDir === null) return;
    const sourcesDir = readDir(sourcesInput, "Sources");
    if (sourcesDir === null) return;
    const next: Settings = { ...saved, campaignsDir, oneshotsDir, sourcesDir };
    if (baseUrl !== "") next.baseUrl = baseUrl;
    else delete next.baseUrl;
    const model = modelInput.value.trim();
    if (model !== "") next.model = model;
    else delete next.model;
    if (apiKeyEnv !== "") next.apiKeyEnv = apiKeyEnv;
    else delete next.apiKeyEnv;

    saving = true;
    setStatus("Saving...", "info");
    try {
      await options.onSaved(next);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save settings");
      return;
    } finally {
      saving = false;
    }
    leave();
  }

  const onKeypress = (key: KeyEvent): void => {
    // The discard dialog owns the keyboard while it is up.
    if (modalOpen) return;
    if (baseUrlCombobox.handleKey(key) || modelCombobox.handleKey(key)) return;
    if (key.name === "escape") {
      key.preventDefault();
      requestLeave();
      return;
    }
    tabWalk(renderer, focusChain, key);
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    baseUrlCombobox.dispose();
    modelCombobox.dispose();
    keyInput.onContentChange = undefined;
    modelInput.off(RenderableEvents.FOCUSED, onModelFocus);
    modelInput.off(RenderableEvents.BLURRED, onModelBlur);
    renderer.keyInput.off("keypress", onKeypress);
  }
  function leave(): void {
    dispose();
    options.onBack();
  }
  function requestLeave(): void {
    if (disposed || modalOpen) return;
    if (!isDirty()) {
      leave();
      return;
    }
    const returnTo = renderer.currentFocusedRenderable;
    modalOpen = true;
    const dialog = makeActionDialog(renderer, {
      width: 54,
      onClose: () => {
        modalOpen = false;
        if (!disposed) (returnTo ?? baseUrlInput).focus();
      },
    });
    dialog.content.add(new TextRenderable(renderer, { content: "Save changes to settings?", fg: theme.text }));
    dialog.content.add(
      new TextRenderable(renderer, {
        content: "Your edits haven't been saved yet.",
        fg: theme.textMuted,
        marginBottom: 1,
      }),
    );
    // Keep editing first, so the safe choice holds focus.
    dialog.addButton("Keep editing", "ghost", () => dialog.close());
    dialog.addButton("Discard", "ghost", () => {
      dialog.close();
      leave();
    });
    dialog.addButton("Save", "primary", () => {
      // Closing first hands focus back, so a refused field can take it from there.
      dialog.close();
      void save();
    });
  }

  let quitReturnTo: Renderable | null = null;
  const handleInterrupt = makeQuitGuard(renderer, {
    isDirty,
    isBlocked: () => modalOpen,
    onOpen: () => {
      quitReturnTo = renderer.currentFocusedRenderable;
      modalOpen = true;
    },
    onClose: () => {
      modalOpen = false;
      if (!disposed) (quitReturnTo ?? baseUrlInput).focus();
    },
  });

  const advance = (from: Renderable): void => {
    const index = focusChain.indexOf(from);
    focusChain[index + 1]?.focus();
  };
  for (const input of inputs) {
    input.on(InputRenderableEvents.ENTER, () => advance(input));
  }
  keyInput.onContentChange = () => {
    modelCombobox.invalidate();
    markCheckStale();
  };
  // Leaving a model field that was typed into (rather than picked) checks it too.
  const onModelFocus = (): void => {
    modelOnFocus = modelInput.value;
  };
  const onModelBlur = (): void => {
    if (modalOpen || modelInput.value === modelOnFocus || checkSubject() === lastChecked) return;
    void checkConnection("auto");
  };
  modelInput.on(RenderableEvents.FOCUSED, onModelFocus);
  modelInput.on(RenderableEvents.BLURRED, onModelBlur);

  renderer.keyInput.on("keypress", onKeypress);
  baseUrlInput.focus();

  return { node: container, focus: () => baseUrlInput.focus(), handleInterrupt, dispose };
}
