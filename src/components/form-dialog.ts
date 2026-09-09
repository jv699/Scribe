import { type BoxRenderable, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core";
import { makeDialog } from "./dialog.ts";
import { tabWalk } from "./ui.ts";

export interface FormDialogOptions {
  width: number;
  /** Read lazily, so callers can build their focus chain after the shell. */
  focusChain: () => readonly Renderable[];
  onEscape: () => void;
}

export interface FormDialogShell {
  layer: BoxRenderable;
  content: BoxRenderable;
  open(): void;
  close(): void;
}

export function makeFormDialog(renderer: CliRenderer, options: FormDialogOptions): FormDialogShell {
  const dialog = makeDialog(renderer, { width: options.width });
  let isOpen = false;

  const onKeypress = (key: KeyEvent): void => {
    if (key.name === "escape") {
      key.preventDefault();
      options.onEscape();
      return;
    }
    tabWalk(renderer, options.focusChain(), key);
  };

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    dialog.open();
    renderer.keyInput.on("keypress", onKeypress);
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    renderer.keyInput.off("keypress", onKeypress);
    dialog.close();
  }

  return { layer: dialog.layer, content: dialog.content, open, close };
}
