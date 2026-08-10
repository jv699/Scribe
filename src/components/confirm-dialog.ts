/**
 * Yes/no confirmation for a destructive action: a title, optional explanatory
 * body, a Cancel button and a confirm button. Built on `action-dialog.ts`,
 * which handles the layer, Escape, and Tab traversal.
 */
import { TextRenderable, type CliRenderer } from "@opentui/core";
import { makeActionDialog } from "./action-dialog.ts";
import { theme } from "../theme.ts";

export interface ConfirmDialogOptions {
  width?: number;
  /** The question, e.g. "Clear this conversation?" */
  title: string;
  /** Optional second line spelling out the consequence. */
  body?: string;
  /** Label for the destructive button, e.g. "Clear" / "Trash". */
  confirmLabel: string;
  onConfirm: () => void;
  /** Called once when the dialog closes, whichever way it went. */
  onClose?: () => void;
  /**
   * Focus the confirm button rather than Cancel. Off by default so the safe
   * choice is the one already focused.
   */
  focusConfirm?: boolean;
}

export function showConfirmDialog(renderer: CliRenderer, options: ConfirmDialogOptions): void {
  const dialog = makeActionDialog(renderer, {
    width: options.width ?? 54,
    ...(options.onClose ? { onClose: options.onClose } : {}),
  });

  dialog.content.add(
    new TextRenderable(renderer, {
      content: options.title,
      fg: theme.text,
      ...(options.body ? {} : { marginBottom: 1 }),
    }),
  );
  if (options.body) {
    dialog.content.add(
      new TextRenderable(renderer, { content: options.body, fg: theme.textMuted, marginBottom: 1 }),
    );
  }

  const addCancel = (): void => dialog.addButton("Cancel", "ghost", () => dialog.close());
  const addConfirm = (): void =>
    dialog.addButton(options.confirmLabel, "primary", () => {
      options.onConfirm();
      dialog.close();
    });

  // The first button added takes focus.
  if (options.focusConfirm) {
    addConfirm();
    addCancel();
  } else {
    addCancel();
    addConfirm();
  }
}
