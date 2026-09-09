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
import { makeSessionDialog } from "../components/session-dialog.ts";
import { enableSelectMouse } from "../components/ui.ts";
import { createSession, listSessions, type Session } from "../store/sessions.ts";
import type { Campaign } from "../store/campaigns.ts";
import { theme } from "../theme.ts";
import type { ChatScreen } from "./chat.ts";
import type { Screen } from "./screen.ts";

const SIDEBAR_WIDTH = 32;

export interface SessionChatHost {
  /** Return keyboard control to the workspace sidebar. */
  onBack: () => void;
  /** Global chat shortcuts must stand down while the sidebar owns focus. */
  isInputActive: () => boolean;
  /** Restore chat key ownership when its prompt is focused directly. */
  onInputFocus: () => void;
}

export interface CampaignWorkspaceOptions {
  campaign: Campaign;
  onBack: () => void;
  makeSessionChat: (session: Session, host: SessionChatHost) => Promise<ChatScreen>;
}

function sessionOptions(sessions: readonly Session[]): SelectOption[] {
  return [
    ...sessions.map((session) => ({
      name: `${String(session.number).padStart(3, "0")} ${session.title} [${session.status}]`,
      description: "",
    })),
    { name: "+ New Session", description: "" },
  ];
}

export async function makeCampaignWorkspaceScreen(
  renderer: CliRenderer,
  options: CampaignWorkspaceOptions,
): Promise<Screen> {
  const { campaign } = options;
  let sessions = await listSessions(campaign);
  let disposed = false;
  let modalOpen = false;
  let creating = false;
  let pane: "sidebar" | "chat" = sessions.length > 0 ? "chat" : "sidebar";
  let activation = 0;
  let activeSessionNumber: number | null = null;
  let activeChat: ChatScreen | null = null;
  let rightChild: Renderable | null = null;

  const container = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "row",
    backgroundColor: theme.background,
  });

  const sidebar = new BoxRenderable(renderer, {
    width: SIDEBAR_WIDTH,
    height: "100%",
    flexShrink: 0,
    flexDirection: "column",
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 1,
    paddingRight: 1,
    border: ["right"],
    borderColor: theme.surfaceActive,
    backgroundColor: theme.surface,
  });
  sidebar.add(new TextRenderable(renderer, { content: campaign.name, fg: theme.accent }));
  sidebar.add(
    new TextRenderable(renderer, {
      content: campaign.system || "System not set",
      fg: theme.textMuted,
      marginBottom: 1,
    }),
  );
  sidebar.add(new TextRenderable(renderer, { content: "Sessions", fg: theme.textDim }));

  const status = new TextRenderable(renderer, { content: "", fg: theme.danger, height: 1 });
  sidebar.add(status);

  const menu = new SelectRenderable(renderer, {
    width: "100%",
    height: 1,
    flexGrow: 1,
    showDescription: false,
    options: sessionOptions(sessions),
    selectedIndex: sessions.length > 0 ? sessions.length - 1 : 0,
    selectedBackgroundColor: theme.accent,
    selectedTextColor: theme.text,
  });
  enableSelectMouse(menu, () => !modalOpen && !creating);
  sidebar.add(menu);

  sidebar.add(
    new TextRenderable(renderer, {
      content: "Settings (coming soon)",
      fg: theme.textMuted,
      flexShrink: 0,
      marginTop: 1,
    }),
  );

  const rightPane = new BoxRenderable(renderer, {
    height: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: theme.background,
  });
  // Clicking the prompt restores chat shortcuts after Escape focused the sidebar.
  rightPane.onMouseDown = () => {
    if (activeChat) pane = "chat";
  };

  container.add(sidebar);
  container.add(rightPane);

  function placeholder(message: string, tone: "normal" | "error" = "normal"): BoxRenderable {
    const box = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      justifyContent: "center",
      alignItems: "center",
    });
    box.add(
      new TextRenderable(renderer, {
        content: message,
        fg: tone === "error" ? theme.danger : theme.textMuted,
      }),
    );
    return box;
  }

  function removeRightChild(): void {
    if (!rightChild) return;
    rightPane.remove(rightChild);
    rightChild.destroyRecursively();
    rightChild = null;
  }

  function disposeActiveChat(): void {
    if (!activeChat) return;
    activeChat.dispose?.();
    activeChat = null;
    activeSessionNumber = null;
  }

  function showRight(child: Renderable): void {
    removeRightChild();
    rightChild = child;
    rightPane.add(child);
  }

  function focusSidebar(): void {
    if (disposed) return;
    pane = "sidebar";
    menu.focus();
  }

  async function activateSession(session: Session): Promise<void> {
    if (disposed) return;
    const index = sessions.findIndex((candidate) => candidate.number === session.number);
    if (index >= 0) menu.setSelectedIndex(index);

    if (activeChat && activeSessionNumber === session.number) {
      pane = "chat";
      activeChat.focus?.();
      return;
    }

    const request = ++activation;
    disposeActiveChat();
    showRight(placeholder(`Opening session ${String(session.number).padStart(3, "0")}…`));

    try {
      const chat = await options.makeSessionChat(session, {
        onBack: focusSidebar,
        isInputActive: () => !disposed && pane === "chat" && !modalOpen,
        onInputFocus: () => {
          if (!disposed && !modalOpen) pane = "chat";
        },
      });
      if (disposed || request !== activation) {
        chat.dispose?.();
        chat.node.destroyRecursively();
        return;
      }
      removeRightChild();
      activeChat = chat;
      activeSessionNumber = session.number;
      rightChild = chat.node;
      rightPane.add(chat.node);
      pane = "chat";
      chat.focus?.();
    } catch (error) {
      if (disposed || request !== activation) return;
      showRight(
        placeholder(
          `Failed to open session: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        ),
      );
      focusSidebar();
    }
  }

  function updateSessions(next: Session[], selected?: Session): void {
    sessions = next;
    menu.options = sessionOptions(sessions);
    const selectedIndex = selected
      ? sessions.findIndex((session) => session.number === selected.number)
      : Math.max(0, sessions.length - 1);
    menu.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : sessions.length);
  }

  const sessionDialog = makeSessionDialog(renderer, {
    onSubmit: (title) => {
      modalOpen = false;
      creating = true;
      status.fg = theme.textMuted;
      status.content = "Creating session…";
      void createSession(campaign, title)
        .then(async (session) => {
          if (disposed) return;
          const next = await listSessions(campaign);
          if (disposed) return;
          updateSessions(next, session);
          status.content = "";
          creating = false;
          await activateSession(session);
        })
        .catch((error: unknown) => {
          if (disposed) return;
          creating = false;
          status.fg = theme.danger;
          status.content = `Failed to create: ${error instanceof Error ? error.message : String(error)}`;
          focusSidebar();
        });
    },
    onCancel: () => {
      modalOpen = false;
      focusSidebar();
    },
  });
  renderer.root.add(sessionDialog.layer);

  menu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    if (modalOpen || creating) return;
    const session = sessions[index];
    if (session) {
      void activateSession(session);
      return;
    }
    if (index === sessions.length) {
      modalOpen = true;
      sessionDialog.open(campaign.nextSession);
    }
  });

  const onScreenKeypress = (key: KeyEvent): void => {
    if (modalOpen || pane !== "sidebar" || key.name !== "escape") return;
    key.preventDefault();
    options.onBack();
  };
  renderer.keyInput.on("keypress", onScreenKeypress);

  if (sessions.length > 0) {
    await activateSession(sessions[sessions.length - 1]!);
  } else {
    showRight(placeholder("No sessions yet — create one from the sidebar."));
  }

  return {
    node: container,
    focus: () => {
      if (pane === "chat" && activeChat) activeChat.focus?.();
      else menu.focus();
    },
    handleInterrupt: () =>
      pane === "chat" && activeChat ? (activeChat.handleInterrupt?.() ?? "quit") : "quit",
    dispose: () => {
      if (disposed) return;
      disposed = true;
      activation++;
      renderer.keyInput.off("keypress", onScreenKeypress);
      sessionDialog.close();
      renderer.root.remove(sessionDialog.layer);
      sessionDialog.layer.destroyRecursively();
      disposeActiveChat();
      removeRightChild();
    },
  };
}
