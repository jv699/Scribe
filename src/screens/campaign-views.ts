import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  MarkdownRenderable,
  RenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import { showConfirmDialog } from "../components/confirm-dialog.ts";
import { enableSelectMouse, makeButton, tabWalk } from "../components/ui.ts";
import { createMarkdownSyntaxStyle } from "../markdown-style.ts";
import {
  type Campaign,
  type CampaignDetails,
  replaceStorySoFar,
  updateCampaignDetails,
} from "../store/campaigns.ts";
import {
  createCharacter,
  listCharacters,
  trashCharacter,
  updateCharacter,
  type Character,
  type CharacterInput,
} from "../store/characters.ts";
import { theme } from "../theme.ts";

export interface CampaignPane {
  node: BoxRenderable;
  focus(): void;
  requestLeave(next: () => void): void;
  dispose(): void;
}

interface PaneOptions {
  campaign: Campaign;
  isActive: () => boolean;
  onBack: () => void;
  onInputFocus: () => void;
  onCampaignChange?: () => void;
}

function paneRoot(renderer: CliRenderer): BoxRenderable {
  return new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    flexDirection: "column",
    backgroundColor: theme.background,
  });
}

function title(renderer: CliRenderer, content: string): TextRenderable {
  return new TextRenderable(renderer, { content, fg: theme.accent, marginBottom: 1, flexShrink: 0 });
}

function label(renderer: CliRenderer, content: string): TextRenderable {
  return new TextRenderable(renderer, { content, fg: theme.textMuted });
}

function input(renderer: CliRenderer, value: string, placeholder: string): InputRenderable {
  return new InputRenderable(renderer, {
    value,
    placeholder,
    width: "100%",
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    marginBottom: 1,
  });
}

function textarea(
  renderer: CliRenderer,
  value: string,
  placeholder: string,
  height: number,
): TextareaRenderable {
  return new TextareaRenderable(renderer, {
    initialValue: value,
    placeholder,
    width: "100%",
    height,
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    focusedTextColor: theme.text,
    marginBottom: 1,
  });
}

function buttonRow(renderer: CliRenderer, buttons: Renderable[]): BoxRenderable {
  const row = new BoxRenderable(renderer, { flexDirection: "row", flexShrink: 0 });
  buttons.forEach((button, index) => {
    if (index > 0) row.add(new BoxRenderable(renderer, { width: 2 }));
    row.add(button);
  });
  return row;
}

interface EditorLifecycleOptions {
  isActive: () => boolean;
  onBack: () => void;
  isDirty: () => boolean;
  resetDraft: () => void;
  discardTitle: string;
  focus: () => void;
  focusChain: () => Renderable[];
}

function makeEditorLifecycle(renderer: CliRenderer, options: EditorLifecycleOptions) {
  let disposed = false;
  let modalOpen = false;
  let saving = false;

  function closeModal(): void {
    modalOpen = false;
    if (!disposed && options.isActive()) options.focus();
  }

  function requestLeave(next: () => void): void {
    if (disposed || modalOpen || saving) return;
    if (!options.isDirty()) {
      next();
      return;
    }
    modalOpen = true;
    showConfirmDialog(renderer, {
      title: options.discardTitle,
      body: "Your unsaved changes will be lost.",
      confirmLabel: "Discard",
      onConfirm: () => {
        if (disposed) return;
        options.resetDraft();
        next();
      },
      onClose: closeModal,
    });
  }

  const onKeypress = (key: KeyEvent): void => {
    if (disposed || !options.isActive() || modalOpen) return;
    if (key.name === "escape") {
      key.preventDefault();
      requestLeave(options.onBack);
      return;
    }
    tabWalk(renderer, options.focusChain(), key);
  };
  renderer.keyInput.on("keypress", onKeypress);

  return {
    requestLeave,
    beginModal(): boolean {
      if (disposed || modalOpen) return false;
      modalOpen = true;
      return true;
    },
    closeModal,
    beginSaving(): boolean {
      if (disposed || saving) return false;
      saving = true;
      return true;
    },
    finishSaving(): void {
      saving = false;
    },
    get blocked(): boolean {
      return modalOpen || saving;
    },
    get disposed(): boolean {
      return disposed;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      renderer.keyInput.off("keypress", onKeypress);
    },
  };
}

export async function makeCharactersPane(
  renderer: CliRenderer,
  options: PaneOptions,
): Promise<CampaignPane> {
  const root = paneRoot(renderer);
  let characters = await listCharacters(options.campaign);
  let current: Renderable | null = null;
  let focusChain: Renderable[] = [];
  let editing: Character | null | undefined;
  let baseline: CharacterInput | null = null;
  let nameInput: InputRenderable | null = null;
  let classInput: InputRenderable | null = null;
  let descriptionInput: TextareaRenderable | null = null;

  function show(child: Renderable): void {
    if (current) {
      root.remove(current);
      current.destroyRecursively();
    }
    current = child;
    root.add(child);
  }

  function draft(): CharacterInput {
    return {
      name: nameInput?.value.trim() ?? "",
      className: classInput?.value.trim() ?? "",
      description: descriptionInput?.plainText.trim() ?? "",
    };
  }

  function dirty(): boolean {
    if (editing === undefined || !baseline) return false;
    const value = draft();
    return (
      value.name !== baseline.name ||
      value.className !== baseline.className ||
      value.description !== baseline.description
    );
  }

  function renderList(selectedPath?: string): void {
    editing = undefined;
    baseline = null;
    nameInput = null;
    classInput = null;
    descriptionInput = null;

    const box = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
    box.add(title(renderer, "Characters"));
    box.add(
      new TextRenderable(renderer, {
        content: characters.length === 0 ? "No party characters yet." : `${characters.length} party character${characters.length === 1 ? "" : "s"}`,
        fg: theme.textMuted,
        marginBottom: 1,
      }),
    );
    const selectedIndex = Math.max(0, characters.findIndex((character) => character.path === selectedPath));
    const menu = new SelectRenderable(renderer, {
      width: "100%",
      height: Math.max(2, Math.min(8, characters.length + 1)),
      flexShrink: 0,
      showDescription: false,
      options: [
        ...characters.map((character) => ({
          name: character.className ? `${character.name} — ${character.className}` : character.name,
          description: "",
        })),
        { name: "+ Add Character", description: "" },
      ],
      selectedIndex,
      selectedBackgroundColor: theme.accent,
      selectedTextColor: theme.text,
    });
    enableSelectMouse(menu, () => options.isActive() && !lifecycle.blocked);
    box.add(menu);

    const details = new TextRenderable(renderer, {
      content: "",
      fg: theme.text,
      marginTop: 1,
      marginBottom: 1,
      flexGrow: 1,
    });
    box.add(details);

    let selected: Character | undefined;
    const editButton = makeButton(renderer, { label: "Edit", onClick: () => selected && renderEditor(selected) });
    const removeButton = makeButton(renderer, { label: "Remove", onClick: () => selected && confirmRemove(selected) });
    box.add(buttonRow(renderer, [editButton, removeButton]));
    focusChain = [menu, editButton, removeButton];
    menu.on(RenderableEvents.FOCUSED, options.onInputFocus);

    const updateDetails = (index: number): void => {
      selected = characters[index];
      details.content = selected
        ? `${selected.name}${selected.className ? `\n${selected.className}` : ""}${selected.description ? `\n\n${selected.description}` : ""}`
        : "Create a party character for Scribe to use while planning.";
      details.fg = selected ? theme.text : theme.textMuted;
    };
    menu.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number) => updateDetails(index));
    menu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
      const character = characters[index];
      if (character) renderEditor(character);
      else if (index === characters.length) renderEditor(null);
    });
    updateDetails(selectedIndex);
    show(box);
    if (options.isActive()) menu.focus();
  }

  function renderEditor(character: Character | null): void {
    editing = character;
    baseline = {
      name: character?.name ?? "",
      className: character?.className ?? "",
      description: character?.description ?? "",
    };
    const box = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
    box.add(title(renderer, character ? `Edit ${character.name}` : "Add Character"));
    box.add(label(renderer, "Name"));
    nameInput = input(renderer, baseline.name, "Character name");
    box.add(nameInput);
    box.add(label(renderer, "Class"));
    classInput = input(renderer, baseline.className, "Class, playbook, or role (optional)");
    box.add(classInput);
    box.add(label(renderer, "Description"));
    descriptionInput = textarea(
      renderer,
      baseline.description,
      "Personality, history, relationships, and useful planning hooks",
      8,
    );
    box.add(descriptionInput);
    const status = new TextRenderable(renderer, { content: "", fg: theme.danger, height: 1 });
    box.add(status);
    const saveButton = makeButton(renderer, {
      label: "Save",
      variant: "primary",
      onClick: () => void saveCharacter(status),
    });
    const cancelButton = makeButton(renderer, { label: "Cancel", onClick: () => requestList() });
    box.add(buttonRow(renderer, [saveButton, cancelButton]));
    focusChain = [nameInput, classInput, descriptionInput, saveButton, cancelButton];
    [nameInput, classInput, descriptionInput].forEach((field) => field.on(RenderableEvents.FOCUSED, options.onInputFocus));
    nameInput.on(InputRenderableEvents.ENTER, () => classInput?.focus());
    classInput.on(InputRenderableEvents.ENTER, () => descriptionInput?.focus());
    show(box);
    nameInput.focus();
  }

  async function saveCharacter(status: TextRenderable): Promise<void> {
    if (editing === undefined || !lifecycle.beginSaving()) return;
    try {
      const value = draft();
      if (value.name === "") {
        status.content = "Name is required";
        nameInput?.focus();
        return;
      }
      status.fg = theme.textMuted;
      status.content = "Saving…";
      const saved = editing
        ? await updateCharacter(options.campaign, editing, value)
        : await createCharacter(options.campaign, value);
      characters = await listCharacters(options.campaign);
      renderList(saved.path);
    } catch (error) {
      status.fg = theme.danger;
      status.content = error instanceof Error ? error.message : "Failed to save character";
    } finally {
      lifecycle.finishSaving();
    }
  }

  function confirmRemove(character: Character): void {
    if (!lifecycle.beginModal()) return;
    showConfirmDialog(renderer, {
      title: `Remove ${character.name}?`,
      body: "The character file will be moved to the campaign trash.",
      confirmLabel: "Remove",
      onConfirm: () => {
        void trashCharacter(options.campaign, character)
          .then(async () => {
            characters = await listCharacters(options.campaign);
            if (!lifecycle.disposed) renderList();
          })
          .catch((error: unknown) => {
            if (!lifecycle.disposed) {
              renderList(character.path);
              const message = error instanceof Error ? error.message : "Failed to remove character";
              root.add(new TextRenderable(renderer, { content: message, fg: theme.danger }));
            }
          });
      },
      onClose: lifecycle.closeModal,
    });
  }

  function requestList(): void {
    requestLeave(() => renderList(editing?.path));
  }

  function focus(): void {
    (focusChain[0] ?? current)?.focus();
  }
  const lifecycle = makeEditorLifecycle(renderer, {
    isActive: options.isActive,
    onBack: options.onBack,
    isDirty: dirty,
    resetDraft: () => {
      if (!baseline) return;
      if (nameInput) nameInput.value = baseline.name;
      if (classInput) classInput.value = baseline.className;
      descriptionInput?.setText(baseline.description);
    },
    discardTitle: "Discard character changes?",
    focus,
    focusChain: () => focusChain,
  });
  const requestLeave = lifecycle.requestLeave;
  renderList();

  return {
    node: root,
    focus,
    requestLeave,
    dispose: lifecycle.dispose,
  };
}

export function makeStoryPane(renderer: CliRenderer, options: PaneOptions): CampaignPane {
  const root = paneRoot(renderer);
  const syntaxStyle = createMarkdownSyntaxStyle();
  let current: Renderable | null = null;
  let editor: TextareaRenderable | null = null;
  let baseline = options.campaign.storySoFar;
  let focusChain: Renderable[] = [];

  function show(child: Renderable): void {
    if (current) {
      root.remove(current);
      current.destroyRecursively();
    }
    current = child;
    root.add(child);
  }

  function renderStory(): void {
    editor = null;
    const box = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
    box.add(title(renderer, "The Story So Far"));
    const scroll = new ScrollBoxRenderable(renderer, { width: "100%", flexGrow: 1, scrollY: true });
    const markdown = new MarkdownRenderable(renderer, {
      content: baseline.trim() || "*Nothing has been recorded yet.*",
      width: "100%",
      syntaxStyle,
      fg: theme.text,
      internalBlockMode: "top-level",
      streaming: true,
    });
    scroll.content.add(markdown);
    box.add(scroll);
    const editButton = makeButton(renderer, {
      label: baseline.trim() ? "Edit" : "Add campaign history",
      variant: "primary",
      onClick: renderEditor,
    });
    box.add(buttonRow(renderer, [editButton]));
    focusChain = [editButton];
    show(box);
    if (options.isActive()) editButton.focus();
  }

  function renderEditor(): void {
    const box = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
    box.add(title(renderer, "Edit The Story So Far"));
    editor = textarea(renderer, baseline, "Record the campaign's history in markdown", 12);
    editor.flexGrow = 1;
    box.add(editor);
    const status = new TextRenderable(renderer, { content: "", fg: theme.danger, height: 1 });
    box.add(status);
    const saveButton = makeButton(renderer, {
      label: "Save",
      variant: "primary",
      onClick: () => void save(status),
    });
    const cancelButton = makeButton(renderer, { label: "Cancel", onClick: () => requestLeave(renderStory) });
    box.add(buttonRow(renderer, [saveButton, cancelButton]));
    focusChain = [editor, saveButton, cancelButton];
    editor.on(RenderableEvents.FOCUSED, options.onInputFocus);
    show(box);
    editor.focus();
  }

  function dirty(): boolean {
    return editor !== null && editor.plainText.trim() !== baseline.trim();
  }

  async function save(status: TextRenderable): Promise<void> {
    if (!editor || !lifecycle.beginSaving()) return;
    status.fg = theme.textMuted;
    status.content = "Saving…";
    try {
      await replaceStorySoFar(options.campaign, editor.plainText, baseline);
      baseline = options.campaign.storySoFar;
      renderStory();
    } catch (error) {
      status.fg = theme.danger;
      status.content = error instanceof Error ? error.message : "Failed to save story";
    } finally {
      lifecycle.finishSaving();
    }
  }

  function focus(): void {
    (focusChain[0] ?? current)?.focus();
  }
  const lifecycle = makeEditorLifecycle(renderer, {
    isActive: options.isActive,
    onBack: options.onBack,
    isDirty: dirty,
    resetDraft: () => editor?.setText(baseline),
    discardTitle: "Discard story changes?",
    focus,
    focusChain: () => focusChain,
  });
  const requestLeave = lifecycle.requestLeave;
  renderStory();

  return {
    node: root,
    focus,
    requestLeave,
    dispose: () => {
      if (lifecycle.disposed) return;
      lifecycle.dispose();
      syntaxStyle.destroy();
    },
  };
}

function campaignDetails(campaign: Campaign): CampaignDetails {
  return {
    name: campaign.name,
    system: campaign.system,
    shortDescription: campaign.shortDescription,
    description: campaign.description,
    planningPreferences: campaign.planningPreferences,
  };
}

export function makeCampaignSettingsPane(renderer: CliRenderer, options: PaneOptions): CampaignPane {
  const root = paneRoot(renderer);
  let baseline = campaignDetails(options.campaign);
  root.add(title(renderer, "Campaign Settings"));

  const scroll = new ScrollBoxRenderable(renderer, { width: "100%", flexGrow: 1, scrollY: true });
  const fields = new BoxRenderable(renderer, { width: "100%", flexDirection: "column" });
  scroll.content.add(fields);
  root.add(scroll);

  fields.add(label(renderer, "Name"));
  const nameInput = input(renderer, baseline.name, "Campaign name");
  fields.add(nameInput);
  fields.add(label(renderer, "Game System"));
  const systemInput = input(renderer, baseline.system, "D&D 5e, Shadowdark, Mothership…");
  fields.add(systemInput);
  fields.add(label(renderer, "Short Description"));
  const shortInput = input(renderer, baseline.shortDescription, "A one-line campaign premise");
  fields.add(shortInput);
  fields.add(label(renderer, "Background / Backstory"));
  const backgroundInput = textarea(renderer, baseline.description, "Setting, premise, factions, and starting situation", 5);
  fields.add(backgroundInput);
  fields.add(label(renderer, "Planning Preferences"));
  const preferencesInput = textarea(renderer, baseline.planningPreferences, "Tone, house rules, boundaries, and planning preferences", 5);
  fields.add(preferencesInput);

  const status = new TextRenderable(renderer, { content: "", fg: theme.danger, height: 1, flexShrink: 0 });
  root.add(status);
  const saveButton = makeButton(renderer, { label: "Save", variant: "primary", onClick: () => void save() });
  const cancelButton = makeButton(renderer, { label: "Cancel", onClick: () => requestLeave(options.onBack) });
  root.add(buttonRow(renderer, [saveButton, cancelButton]));
  const focusChain: Renderable[] = [
    nameInput,
    systemInput,
    shortInput,
    backgroundInput,
    preferencesInput,
    saveButton,
    cancelButton,
  ];
  [nameInput, systemInput, shortInput, backgroundInput, preferencesInput].forEach(
    (field) => field.on(RenderableEvents.FOCUSED, options.onInputFocus),
  );
  nameInput.on(InputRenderableEvents.ENTER, () => systemInput.focus());
  systemInput.on(InputRenderableEvents.ENTER, () => shortInput.focus());
  shortInput.on(InputRenderableEvents.ENTER, () => backgroundInput.focus());

  function draft(): CampaignDetails {
    return {
      name: nameInput.value.trim(),
      system: systemInput.value.trim(),
      shortDescription: shortInput.value.trim(),
      description: backgroundInput.plainText.trim(),
      planningPreferences: preferencesInput.plainText.trim(),
    };
  }

  function dirty(): boolean {
    const value = draft();
    return (Object.keys(value) as Array<keyof CampaignDetails>).some((key) => value[key] !== baseline[key]);
  }

  async function save(): Promise<void> {
    if (!lifecycle.beginSaving()) return;
    try {
      const value = draft();
      if (value.name === "") {
        status.content = "Name is required";
        nameInput.focus();
        return;
      }
      status.fg = theme.textMuted;
      status.content = "Saving…";
      await updateCampaignDetails(options.campaign, value, baseline);
      baseline = campaignDetails(options.campaign);
      options.onCampaignChange?.();
      status.fg = theme.textMuted;
      status.content = "Saved";
    } catch (error) {
      status.fg = theme.danger;
      status.content = error instanceof Error ? error.message : "Failed to save campaign";
    } finally {
      lifecycle.finishSaving();
    }
  }

  function focus(): void {
    nameInput.focus();
  }
  const lifecycle = makeEditorLifecycle(renderer, {
    isActive: options.isActive,
    onBack: options.onBack,
    isDirty: dirty,
    resetDraft: () => {
      nameInput.value = baseline.name;
      systemInput.value = baseline.system;
      shortInput.value = baseline.shortDescription;
      backgroundInput.setText(baseline.description);
      preferencesInput.setText(baseline.planningPreferences);
    },
    discardTitle: "Discard campaign changes?",
    focus,
    focusChain: () => focusChain,
  });
  const requestLeave = lifecycle.requestLeave;

  return {
    node: root,
    focus,
    requestLeave,
    dispose: lifecycle.dispose,
  };
}
