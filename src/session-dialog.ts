import {
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";
import { theme } from "./theme.ts";
import { makeDialog } from "./dialog.ts";
import { makeButton } from "./ui.ts";

export interface SessionDialogOptions {
  onSubmit: (title: string) => void;
  onCancel: () => void;
}

export interface SessionDialog {
  /** Add to the root (once) before use. */
  layer: BoxRenderable;
  open(nextSessionNumber: number): void;
}

export function makeSessionDialog(renderer: CliRenderer, options: SessionDialogOptions): SessionDialog {
  const dialog = makeDialog(renderer, { width: 44 });

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
    close();
  }

  function cancel(): void {
    options.onCancel();
    close();
  }

  function open(nextSessionNumber: number): void {
    titleInput.value = "";
    hint.content = "";
    title.content = `New Session ${nextSessionNumber}`;
    dialog.open();
    renderer.keyInput.on("keypress", onKeypress);
    titleInput.focus();
  }

  function close(): void {
    renderer.keyInput.off("keypress", onKeypress);
    dialog.close();
  }

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

  titleInput.on(InputRenderableEvents.ENTER, () => createButton.focus());

  createButton.onKeyDown = (key) => {
    if (key.name === "return") submit();
  };
  cancelButton.onKeyDown = (key) => {
    if (key.name === "return") cancel();
  };

  return { layer: dialog.layer, open };
}
