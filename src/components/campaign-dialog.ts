/**
 * "New Campaign" form dialog: name, system, and background fields with
 * Create/Cancel buttons. Wraps `dialog.ts` and manages its own focus chain.
 */
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { makeDialog } from "./dialog.ts";
import { makeButton } from "./ui.ts";
import type { NewCampaign } from "../store/campaigns.ts";

export interface CampaignDialogOptions {
  onSubmit: (campaign: NewCampaign) => void;
  onCancel: () => void;
}

export interface CampaignDialog {
  /** Add this to the root once at startup. */
  layer: BoxRenderable;
  open(): void;
}

export function makeCampaignDialog(renderer: CliRenderer, options: CampaignDialogOptions): CampaignDialog {
  const dialog = makeDialog(renderer, { width: 52 });

  const title = new TextRenderable(renderer, {
    content: "New Campaign",
    fg: theme.accent,
    marginBottom: 1,
  });

  const nameInput = new InputRenderable(renderer, {
    placeholder: "Campaign name",
    maxLength: 40,
    width: "100%",
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    marginBottom: 1,
  });

  const systemInput = new InputRenderable(renderer, {
    placeholder: "System (e.g. D&D 5e, Shadowdark, Mothership)",
    maxLength: 40,
    width: "100%",
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    marginBottom: 1,
  });

  const descInput = new TextareaRenderable(renderer, {
    placeholder: "Campaign background (optional)",
    width: "100%",
    height: 4,
    backgroundColor: theme.surfaceRaised,
    focusedBackgroundColor: theme.surfaceActive,
    marginBottom: 1,
  });

  const hint = new TextRenderable(renderer, { content: "", fg: theme.danger, height: 1 });

  const createButton = makeButton(renderer, { label: "Create", variant: "primary", onClick: submit });
  const cancelButton = makeButton(renderer, { label: "Cancel", onClick: cancel });

  const buttonRow = new BoxRenderable(renderer, { flexDirection: "row" });
  buttonRow.add(createButton);
  buttonRow.add(new BoxRenderable(renderer, { width: 2 }));
  buttonRow.add(cancelButton);

  dialog.content.add(title);
  dialog.content.add(nameInput);
  dialog.content.add(systemInput);
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
    close();
  }

  function cancel(): void {
    options.onCancel();
    close();
  }

  function open(): void {
    nameInput.value = "";
    systemInput.value = "";
    descInput.clear();
    hint.content = "";
    dialog.open();
    renderer.keyInput.on("keypress", onKeypress);
    nameInput.focus();
  }

  function close(): void {
    renderer.keyInput.off("keypress", onKeypress);
    dialog.close();
  }

  // Global while open: Escape cancels, Tab/Shift+Tab walk the focus chain.
  function onKeypress(key: KeyEvent): void {
    if (key.name === "escape") {
      key.preventDefault();
      cancel();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      const index = focusChain.indexOf(renderer.currentFocusedRenderable as Renderable);
      const direction = key.shift ? -1 : 1;
      const next = focusChain[(index + direction + focusChain.length) % focusChain.length];
      next?.focus();
    }
  }

  // Enter in a single-line field submits the dialog directly. Tab still
  // walks the focus chain; the description textarea keeps Enter for newlines.
  nameInput.on(InputRenderableEvents.ENTER, () => submit());
  systemInput.on(InputRenderableEvents.ENTER, () => submit());

  // Enter "clicks" the focused button (mouse clicks work via makeButton).
  // Note: the main Enter key reports key.name === "return" ("enter" is the
  // keypad-enter alias in OpenTUI's keymap).
  createButton.onKeyDown = (key) => {
    if (key.name === "return") submit();
  };
  cancelButton.onKeyDown = (key) => {
    if (key.name === "return") cancel();
  };

  return { layer: dialog.layer, open };
}
