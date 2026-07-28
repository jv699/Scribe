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
import { makeDialog } from "./dialog.ts";
import { makeButton } from "./ui.ts";
import type { Campaign } from "./campaigns.ts";

export interface CampaignDialogOptions {
  onSubmit: (campaign: Campaign) => void;
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
    fg: "#00AAFF",
    marginBottom: 1,
  });

  const nameInput = new InputRenderable(renderer, {
    placeholder: "Campaign name",
    maxLength: 40,
    width: "100%",
    backgroundColor: "#222222",
    focusedBackgroundColor: "#333333",
    marginBottom: 1,
  });

  const descInput = new TextareaRenderable(renderer, {
    placeholder: "Description (optional)",
    width: "100%",
    height: 4,
    backgroundColor: "#222222",
    focusedBackgroundColor: "#333333",
    marginBottom: 1,
  });

  const hint = new TextRenderable(renderer, { content: "", fg: "#FF5555", height: 1 });

  const createButton = makeButton(renderer, { label: "Create", variant: "primary", onClick: submit });
  const cancelButton = makeButton(renderer, { label: "Cancel", onClick: cancel });

  const buttonRow = new BoxRenderable(renderer, { flexDirection: "row" });
  buttonRow.add(createButton);
  buttonRow.add(new BoxRenderable(renderer, { width: 2 }));
  buttonRow.add(cancelButton);

  dialog.content.add(title);
  dialog.content.add(nameInput);
  dialog.content.add(descInput);
  dialog.content.add(hint);
  dialog.content.add(buttonRow);

  const focusChain: Renderable[] = [nameInput, descInput, createButton, cancelButton];

  function submit(): void {
    const name = nameInput.value.trim();
    if (name === "") {
      hint.content = "Name is required";
      nameInput.focus();
      return;
    }
    options.onSubmit({ name, description: descInput.plainText.trim() });
    close();
  }

  function cancel(): void {
    options.onCancel();
    close();
  }

  function open(): void {
    nameInput.value = "";
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

  // Enter in the name field jumps to the description.
  nameInput.on(InputRenderableEvents.ENTER, () => descInput.focus());

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
