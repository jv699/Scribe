/**
 * Campaign home screen: campaign metadata with background/story-so-far peeks,
 * a session list with statuses, and dialogs for creating/editing sessions
 * (mark ready/played, trash). Escape returns to the main menu.
 */
import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core";
import { makeActionDialog, type ActionDialog } from "../components/action-dialog.ts";
import { makeSessionDialog } from "../components/session-dialog.ts";
import { listSessions, createSession, setSessionStatus, trashSession, type Session } from "../store/sessions.ts";
import { theme } from "../theme.ts";
import type { Campaign } from "../store/campaigns.ts";
import type { Screen } from "./screen.ts";

export interface CampaignHomeOptions {
  campaign: Campaign;
  onBack: () => void;
  /** Reload this screen after data changed (new session, status change, …). */
  onChanged: () => void;
  /** Open planning mode for a session (agent writes its notes). */
  onPlan: (session: Session) => void;
  /** Open report mode for a session (agent records the outcome). */
  onReport: (session: Session) => void;
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

  // --- Session detail dialog (built fresh on each open) ---
  let detailDialog: ActionDialog | null = null;

  function openSessionDetail(session: Session): void {
    modalOpen = true;
    const dialog = makeActionDialog(renderer, {
      width: 60,
      onClose: () => {
        modalOpen = false;
        menu.focus();
      },
    });
    detailDialog = dialog;

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

    const act = (action: () => Promise<void>) => {
      void action()
        .then(() => {
          dialog.close();
          options.onChanged();
        })
        .catch((err: unknown) => {
          dialog.close();
          console.error("Action failed:", err);
        });
    };
    if (session.status === "planning") {
      dialog.addButton("Plan with Agent", "primary", () => {
        dialog.close();
        options.onPlan(session);
      });
      dialog.addButton("Mark Ready", "ghost", () => act(() => setSessionStatus(session, "ready")));
    }
    if (session.status === "ready") {
      dialog.addButton("Report outcome", "primary", () => {
        dialog.close();
        options.onReport(session);
      });
      dialog.addButton("Mark Played", "ghost", () => act(() => setSessionStatus(session, "played")));
    }
    dialog.addButton("Move to Trash", "ghost", () => {
      dialog.close();
      confirmTrash(session);
    });
    dialog.addButton("Close", "ghost", () => dialog.close());
  }

  // --- Trash confirmation (status guard for the destructive action) ---
  function confirmTrash(session: Session): void {
    modalOpen = true;
    const dialog = makeActionDialog(renderer, {
      width: 52,
      onClose: () => {
        modalOpen = false;
        menu.focus();
      },
    });

    dialog.content.add(
      new TextRenderable(renderer, {
        content: `Move session ${session.number} — "${session.title}" to trash?`,
        marginBottom: 1,
      }),
    );

    dialog.addButton("Trash", "primary", () => {
      void trashSession(campaign, session)
        .then(() => {
          dialog.close();
          options.onChanged();
        })
        .catch((err: unknown) => {
          dialog.close();
          console.error("Failed to trash session:", err);
        });
    });
    dialog.addButton("Cancel", "ghost", () => dialog.close());
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
      detailDialog?.close();
      for (const dispose of disposers) dispose();
    },
  };
}
