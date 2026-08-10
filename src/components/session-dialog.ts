/**
 * "New Session" form dialog: a single title field with Create/Cancel
 * buttons. Wraps `dialog.ts` and manages its own focus chain.
 */
import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type Renderable,
} from "@opentui/core";
import { theme } from "../theme.ts";
import { makeFormDialog } from "./form-dialog.ts";
import { makeButton } from "./ui.ts";

export interface SessionDialogOptions {
  onSubmit: (title: string) => void;
  onCancel: () => void;
}

export interface SessionDialog {
  /** Add to the root (once) before use. */
  layer: BoxRenderable;
  open(nextSessionNumber: number): void;
  /** Hide and release the keyboard. Safe to call when already closed. */
  close(): void;
}

export function makeSessionDialog(renderer: CliRenderer, options: SessionDialogOptions): SessionDialog {
  const dialog = makeFormDialog(renderer, {
    width: 44,
    focusChain: () => focusChain,
    onEscape: cancel,
  });

  const title = new TextRenderable(renderer, { content: "New Session", fg: theme.accent, marginBottom: 1 });

  const titleInput = new InputRenderable(renderer, {
    placeholder: "Session title",
    maxLength: 60,
    width: "100%",
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
  dialog.content.add(titleInput);
  dialog.content.add(hint);
  dialog.content.add(buttonRow);

  const focusChain: Renderable[] = [titleInput, createButton, cancelButton];

  function submit(): void {
    const sessionTitle = titleInput.value.trim();
    if (sessionTitle === "") {
      hint.content = "Title is required";
      titleInput.focus();
      return;
    }
    options.onSubmit(sessionTitle);
    dialog.close();
  }

  function cancel(): void {
    options.onCancel();
    dialog.close();
  }

  function open(nextSessionNumber: number): void {
    titleInput.value = "";
    hint.content = "";
    title.content = `New Session ${nextSessionNumber}`;
    dialog.open();
    titleInput.focus();
  }

  // Enter in the title field submits the dialog directly.
  titleInput.on(InputRenderableEvents.ENTER, () => submit());

  return { layer: dialog.layer, open, close: dialog.close };
}
