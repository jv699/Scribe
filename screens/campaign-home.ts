import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type SelectOption,
} from "@opentui/core";
import { makeDialog } from "../dialog.ts";
import { makeButton } from "../ui.ts";
import { makeSessionDialog } from "../session-dialog.ts";
import { listSessions, createSession, setSessionStatus, trashSession, type Session } from "../store/sessions.ts";
import { theme } from "../theme.ts";
import type { Campaign } from "../store/campaigns.ts";
import type { Screen } from "./screen.ts";

export interface CampaignHomeOptions {
  campaign: Campaign;
  onBack: () => void;
  /** Reload this screen after data changed (new session, status change, …). */
  onChanged: () => void;
}

/** First few non-empty lines of a markdown section, for the peek view. */
function peek(text: string, maxLines: number): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return "(nothing yet)";
  const shown = lines.slice(0, maxLines).join("\n");
  return lines.length > maxLines ? shown + "\n…" : shown;
}

export async function makeCampaignHomeScreen(
  renderer: CliRenderer,
  options: CampaignHomeOptions,
): Promise<Screen> {
  const { campaign } = options;
  const sessions = await listSessions(campaign);

  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    padding: 1,
    flexDirection: "column",
  });
  container.add(new TextRenderable(renderer, { content: campaign.name, fg: theme.accent, marginBottom: 1 }));
  container.add(
    new TextRenderable(renderer, {
      content: `System: ${campaign.system || "—"}    Created: ${campaign.created}    Folder: ${campaign.dir}`,
      fg: theme.textMuted,
      marginBottom: 1,
    }),
  );
  container.add(
    new TextRenderable(renderer, {
      content: `Background:\n${peek(campaign.description, 3)}`,
      fg: theme.textDim,
      marginBottom: 1,
    }),
  );
  container.add(
    new TextRenderable(renderer, {
      content: `The Story So Far:\n${peek(campaign.storySoFar, 3)}`,
      fg: theme.textDim,
      marginBottom: 1,
    }),
  );

  const items: SelectOption[] = [
    ...sessions.map((s) => ({
      name: `${String(s.number).padStart(3, "0")} — ${s.title} [${s.status}]`,
      description: "",
    })),
    { name: "+ New Session", description: "" },
    { name: "<- Back to Main Menu", description: "" },
  ];

  const menu = new SelectRenderable(renderer, {
    width: 50,
    height: items.length,
    showDescription: false,
    options: items,
    selectedBackgroundColor: theme.accent,
    selectedTextColor: theme.text,
  });
  container.add(menu);

  // While a dialog is open, the screen-level Escape handler stays out of
  // the way (the dialogs handle Escape themselves).
  let modalOpen = false;
  const disposers: (() => void)[] = [];

  // --- New Session dialog (created once per screen, layer added to root) ---
  const sessionDialog = makeSessionDialog(renderer, {
    onSubmit: (title) => {
      modalOpen = false;
      void (async () => {
        await createSession(campaign, title);
        options.onChanged();
      })();
    },
    onCancel: () => {
      modalOpen = false;
      menu.focus();
    },
  });
  renderer.root.add(sessionDialog.layer);
  disposers.push(() => {
    renderer.root.remove(sessionDialog.layer.id);
    sessionDialog.layer.destroyRecursively();
  });

  // --- Session detail dialog (created fresh on each open) ---
  let closeDetail: (() => void) | null = null;

  function openSessionDetail(session: Session): void {
    modalOpen = true;
    const dialog = makeDialog(renderer, { width: 60 });
    renderer.root.add(dialog.layer);

    dialog.content.add(new TextRenderable(renderer, { content: session.title, fg: theme.accent }));
    dialog.content.add(
      new TextRenderable(renderer, {
        content: `Session ${session.number} — status: ${session.status}`,
        marginBottom: 1,
      }),
    );
    dialog.content.add(
      new TextRenderable(renderer, { content: session.path, fg: theme.textMuted, width: "100%", marginBottom: 1 }),
    );

    const buttonRow = new BoxRenderable(renderer, { flexDirection: "row" });
    const buttons: Renderable[] = [];
    const addButton = (label: string, variant: "primary" | "ghost", action: () => void) => {
      const button = makeButton(renderer, { label, variant, onClick: action });
      button.onKeyDown = (key) => {
        if (key.name === "return") action();
      };
      if (buttons.length > 0) buttonRow.add(new BoxRenderable(renderer, { width: 2 }));
      buttonRow.add(button);
      buttons.push(button);
    };

    const act = (action: () => Promise<void>) => {
      void action().then(() => {
        close();
        options.onChanged();
      });
    };
    if (session.status === "planning") {
      addButton("Mark Ready", "primary", () => act(() => setSessionStatus(session, "ready")));
    }
    if (session.status === "ready") {
      addButton("Mark Played", "primary", () => act(() => setSessionStatus(session, "played")));
    }
    addButton("Move to Trash", "ghost", () => act(() => trashSession(campaign, session)));
    addButton("Close", "ghost", () => close());
    dialog.content.add(buttonRow);

    const onKeypress = (key: KeyEvent): void => {
      if (key.name === "escape") {
        key.preventDefault();
        close();
        return;
      }
      if (key.name === "tab" && buttons.length > 0) {
        key.preventDefault();
        const index = buttons.indexOf(renderer.currentFocusedRenderable as Renderable);
        const direction = key.shift ? -1 : 1;
        buttons[(index + direction + buttons.length) % buttons.length]?.focus();
      }
    };

    function close(): void {
      renderer.keyInput.off("keypress", onKeypress);
      renderer.root.remove(dialog.layer.id);
      dialog.layer.destroyRecursively();
      closeDetail = null;
      modalOpen = false;
      menu.focus();
    }

    closeDetail = close;
    dialog.open();
    renderer.keyInput.on("keypress", onKeypress);
    buttons[0]?.focus();
  }

  // --- Menu wiring ---
  menu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    const session = sessions[index];
    if (session) {
      openSessionDetail(session);
      return;
    }
    if (index === items.length - 2) {
      modalOpen = true;
      sessionDialog.open(campaign.nextSession);
      return;
    }
    options.onBack();
  });

  // --- Escape goes back to the main menu ---
  const onScreenKeypress = (key: KeyEvent): void => {
    if (key.name === "escape" && !modalOpen) {
      key.preventDefault();
      options.onBack();
    }
  };
  renderer.keyInput.on("keypress", onScreenKeypress);
  disposers.push(() => renderer.keyInput.off("keypress", onScreenKeypress));

  return {
    node: container,
    focus: () => menu.focus(),
    dispose: () => {
      closeDetail?.();
      for (const dispose of disposers) dispose();
    },
  };
}
