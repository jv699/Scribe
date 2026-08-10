/**
 * Shared shell for the reusable form dialogs (campaign, session).
 *
 * These differ from `action-dialog.ts`: their layer is created once, added to
 * the root by the caller, and shown/hidden repeatedly rather than destroyed on
 * close. What they share is the lifecycle wired here — take over the keyboard
 * while open (Escape cancels, Tab/Shift+Tab walk the focus chain) and release
 * it on close. Callers own their fields, buttons, and focus.
 */
import { type BoxRenderable, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core";
import { makeDialog } from "./dialog.ts";
import { tabWalk } from "./ui.ts";

export interface FormDialogOptions {
  width: number;
  /** Read lazily, so callers can build their focus chain after the shell. */
  focusChain: () => readonly Renderable[];
  /** Escape pressed while open — callers usually cancel and close. */
  onEscape: () => void;
}

export interface FormDialogShell {
  /** Add this to the root once, at construction. */
  layer: BoxRenderable;
  /** Centered box — put fields and buttons in here. */
  content: BoxRenderable;
  /** Show and take over the keyboard. Idempotent. */
  open(): void;
  /** Hide and release the keyboard. Idempotent. */
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
