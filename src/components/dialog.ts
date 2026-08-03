/**
 * Generic centered modal primitive: an invisible full-screen layer that
 * centers a solid-background content box. Form dialogs (campaign, session)
 * are built on this. Callers handle focus themselves.
 */
import { BoxRenderable, type RenderContext } from "@opentui/core";
import { theme } from "../theme.ts";

export interface DialogOptions {
  width: number;
  backgroundColor?: string;
}

export interface Dialog {
  /** Full-screen layer — add this to the root once at startup. */
  layer: BoxRenderable;
  /** Centered box — put dialog content in here. */
  content: BoxRenderable;
  isOpen(): boolean;
  open(): void;
  close(): void;
}

/**
 * Generic centered modal. The layer is transparent so the UI behind stays
 * visible; the content box gets a solid background so it reads as a window.
 * Focus management is left to the caller.
 */
export function makeDialog(ctx: RenderContext, options: DialogOptions): Dialog {
  const content = new BoxRenderable(ctx, {
    width: options.width,
    backgroundColor: options.backgroundColor ?? theme.surface,
    padding: 1,
    flexDirection: "column",
  });

  const layer = new BoxRenderable(ctx, {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 100,
    visible: false,
  });
  layer.add(content);

  return {
    layer,
    content,
    isOpen: () => layer.visible,
    open: () => {
      layer.visible = true;
    },
    close: () => {
      layer.visible = false;
    },
  };
}
