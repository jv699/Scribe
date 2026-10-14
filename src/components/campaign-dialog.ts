import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { makeFormDialog } from "./form-dialog.ts";
import { makeButton, TEXT_FIELD_KEYS } from "./ui.ts";
import type { NewCampaign } from "../store/campaigns.ts";

export interface CampaignDialogOptions {
  onSubmit: (campaign: NewCampaign) => void;
  onCancel: () => void;
}

export interface CampaignDialog {
  layer: BoxRenderable;
  open(): void;
  close(): void;
}

export function makeCampaignDialog(renderer: CliRenderer, options: CampaignDialogOptions): CampaignDialog {
  const dialog = makeFormDialog(renderer, {
    width: 52,
    focusChain: () => focusChain,
    onEscape: cancel,
  });

  const title = new TextRenderable(renderer, {
    content: "New Campaign",
    fg: theme.accent,
    marginBottom: 1,
  });

  const nameInput = new InputRenderable(renderer, {
    placeholder: "The Sunken Crown",
    maxLength: 40,
    width: "100%",
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    keyBindings: TEXT_FIELD_KEYS,
    placeholderColor: theme.textMuted,
    marginBottom: 1,
  });

  const systemInput = new InputRenderable(renderer, {
    placeholder: "D&D 5e, Shadowdark, Mothership…",
    maxLength: 40,
    width: "100%",
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    keyBindings: TEXT_FIELD_KEYS,
    placeholderColor: theme.textMuted,
    marginBottom: 1,
  });

  const descInput = new TextareaRenderable(renderer, {
    placeholder: "Setting, premise, and starting situation",
    width: "100%",
    height: 4,
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    keyBindings: TEXT_FIELD_KEYS,
    placeholderColor: theme.textMuted,
    marginBottom: 1,
  });

  const hint = new TextRenderable(renderer, { content: "", fg: theme.danger, height: 1 });

  const createButton = makeButton(renderer, { label: "Create", variant: "primary", onClick: submit });
  const cancelButton = makeButton(renderer, { label: "Cancel", onClick: cancel });

  const buttonRow = new BoxRenderable(renderer, { flexDirection: "row" });
  buttonRow.add(createButton);
  buttonRow.add(new BoxRenderable(renderer, { width: 2 }));
  buttonRow.add(cancelButton);

  // Labels stay put once typing hides the placeholders.
  const label = (content: string): TextRenderable => new TextRenderable(renderer, { content, fg: theme.textMuted });
  dialog.content.add(title);
  dialog.content.add(label("Name"));
  dialog.content.add(nameInput);
  dialog.content.add(label("Game system"));
  dialog.content.add(systemInput);
  dialog.content.add(label("Background (optional)"));
  dialog.content.add(descInput);
  dialog.content.add(hint);
  dialog.content.add(buttonRow);

  const focusChain: Renderable[] = [nameInput, systemInput, descInput, createButton, cancelButton];

  function submit(): void {
    const name = nameInput.value.trim();
    if (name === "") {
      hint.content = "Name is required";
      nameInput.focus();
      return;
    }
    options.onSubmit({
      name,
      system: systemInput.value.trim(),
      description: descInput.plainText.trim(),
    });
    dialog.close();
  }

  function cancel(): void {
    options.onCancel();
    dialog.close();
  }

  function open(): void {
    nameInput.value = "";
    systemInput.value = "";
    descInput.clear();
    hint.content = "";
    dialog.open();
    nameInput.focus();
  }

  // Enter moves on, like every other form; Create (or Enter on it) submits.
  nameInput.on(InputRenderableEvents.ENTER, () => systemInput.focus());
  systemInput.on(InputRenderableEvents.ENTER, () => descInput.focus());

  return { layer: dialog.layer, open, close: dialog.close };
}
