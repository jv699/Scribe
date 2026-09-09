import { TextRenderable, type CliRenderer } from "@opentui/core";
import { makeActionDialog } from "./action-dialog.ts";
import { theme } from "../theme.ts";

export interface ConfirmDialogOptions {
  width?: number;
  title: string;
  body?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose?: () => void;
  /** Defaults to false so Cancel holds initial focus. */
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

  if (options.focusConfirm) {
    addConfirm();
    addCancel();
  } else {
    addCancel();
    addConfirm();
  }
}
