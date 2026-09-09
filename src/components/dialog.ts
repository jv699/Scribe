import { BoxRenderable, type RenderContext } from "@opentui/core";
import { theme } from "../theme.ts";

export interface DialogOptions {
  width: number;
  backgroundColor?: string;
}

export interface Dialog {
  layer: BoxRenderable;
  content: BoxRenderable;
  open(): void;
  close(): void;
}

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
    open: () => {
      layer.visible = true;
    },
    close: () => {
      layer.visible = false;
    },
  };
}
