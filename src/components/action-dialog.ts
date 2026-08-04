/**
 * Generic modal with a body and a row of buttons: adds the layer to the root,
 * wires Tab/Shift+Tab focus traversal and Escape-to-close, and returns focus
 * via `onClose`. Callers add body content and buttons; activating a button
 * (click or Enter) runs its action.
 */
import { BoxRenderable, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core";
import { makeDialog } from "./dialog.ts";
import { makeButton, tabWalk } from "./ui.ts";

export interface ActionDialogOptions {
  width: number;
  /** Called once when the dialog closes (Escape or a button action). */
  onClose?: () => void;
}

export interface ActionDialog {
  /** Centered content box — add body content here (above the button row). */
  content: BoxRenderable;
  /** Append a button to the row. The first button added gets initial focus. */
  addButton(label: string, variant: "primary" | "ghost", action: () => void): void;
  /** Close the dialog (idempotent) and run onClose. */
  close(): void;
}

export function makeActionDialog(renderer: CliRenderer, options: ActionDialogOptions): ActionDialog {
  const dialog = makeDialog(renderer, { width: options.width });
  renderer.root.add(dialog.layer);

  const buttonRow = new BoxRenderable(renderer, { flexDirection: "row" });
  const buttons: Renderable[] = [];
  let buttonRowAdded = false;

  function addButton(label: string, variant: "primary" | "ghost", action: () => void): void {
    if (!buttonRowAdded) {
      dialog.content.add(buttonRow);
      buttonRowAdded = true;
    }
    const button = makeButton(renderer, { label, variant, onClick: action });
    if (buttons.length > 0) buttonRow.add(new BoxRenderable(renderer, { width: 2 }));
    buttonRow.add(button);
    buttons.push(button);
    if (buttons.length === 1) button.focus();
  }

  const onKeypress = (key: KeyEvent): void => {
    if (key.name === "escape") {
      key.preventDefault();
      close();
      return;
    }
    tabWalk(renderer, buttons, key);
  };

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    renderer.keyInput.off("keypress", onKeypress);
    renderer.root.remove(dialog.layer.id);
    dialog.layer.destroyRecursively();
    options.onClose?.();
  }

  renderer.keyInput.on("keypress", onKeypress);
  dialog.open();

  return { content: dialog.content, addButton, close };
}
