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
import type { ChatScreen, ChatState } from "./chat.ts";
import {
  makeCampaignSettingsPane,
  makeCharactersPane,
  makeStoryPane,
  type CampaignPane,
} from "./campaign-views.ts";
import type { Screen } from "./screen.ts";

const SIDEBAR_WIDTH = 32;

export interface SessionChatHost {
  onBack: () => void;
  isInputActive: () => boolean;
  onInputFocus: () => void;
  onStateChange: (state: ChatState) => void;
}

export interface CampaignWorkspaceOptions {
  campaign: Campaign;
  onBack: () => void;
  makeSessionChat: (session: Session, host: SessionChatHost) => Promise<ChatScreen>;
}

type Destination = "characters" | "story" | "settings";

function sessionOptions(
  sessions: readonly Session[],
  activeSessionNumber: number | null,
  activeChatState: ChatState,
): SelectOption[] {
  return [
    ...sessions.map((session) => {
      const state = session.number === activeSessionNumber ? activeChatState : "idle";
      const activity = state === "working" ? "… " : state === "awaiting-answer" ? "? " : "";
      return {
        name: `${activity}${String(session.number).padStart(3, "0")} ${session.title} [${session.status}]`,
        description: "",
      };
    }),
    { name: "+ New Session", description: "" },
  ];
}

const destinationOptions: SelectOption[] = [
  { name: "Characters", description: "", value: "characters" satisfies Destination },
  { name: "Story So Far", description: "", value: "story" satisfies Destination },
  { name: "Settings", description: "", value: "settings" satisfies Destination },
];

export async function makeCampaignWorkspaceScreen(
  renderer: CliRenderer,
  options: CampaignWorkspaceOptions,
): Promise<Screen> {
  const { campaign } = options;
  let sessions = await listSessions(campaign);
  let disposed = false;
  let modalOpen = false;
  let creating = false;
  let pane: "sidebar" | "chat" | "view" = sessions.length > 0 ? "chat" : "sidebar";
  let sidebarFocus: "sessions" | "destinations" = "sessions";
  let activation = 0;
  let chatGeneration = 0;
  let activeSessionNumber: number | null = null;
  let activeChatState: ChatState = "idle";
  let activeChat: ChatScreen | null = null;
  let activeView: CampaignPane | null = null;
  let activeDestination: Destination | null = null;
  let auxiliaryChild: Renderable | null = null;

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
  const campaignName = new TextRenderable(renderer, { content: campaign.name, fg: theme.accent });
  const campaignSystem = new TextRenderable(renderer, {
    content: campaign.system || "System not set",
    fg: theme.textMuted,
    marginBottom: 1,
  });
  sidebar.add(campaignName);
  sidebar.add(campaignSystem);
  sidebar.add(new TextRenderable(renderer, { content: "Sessions", fg: theme.textDim }));

  const status = new TextRenderable(renderer, { content: "", fg: theme.danger, height: 1 });
  sidebar.add(status);

  const sessionMenu = new SelectRenderable(renderer, {
    width: "100%",
    height: 1,
    flexGrow: 1,
    showDescription: false,
    showScrollIndicator: true,
    options: sessionOptions(sessions, activeSessionNumber, activeChatState),
    selectedIndex: sessions.length > 0 ? sessions.length - 1 : 0,
    selectedBackgroundColor: theme.accent,
    selectedTextColor: theme.text,
  });
  enableSelectMouse(sessionMenu, () => !modalOpen && !creating);
  sidebar.add(sessionMenu);

  const destinationMenu = new SelectRenderable(renderer, {
    width: "100%",
    height: destinationOptions.length,
    flexShrink: 0,
    marginTop: 1,
    showDescription: false,
    options: destinationOptions,
    selectedBackgroundColor: theme.accent,
    selectedTextColor: theme.text,
  });
  enableSelectMouse(destinationMenu, () => !modalOpen && !creating);
  sidebar.add(destinationMenu);

  const rightPane = new BoxRenderable(renderer, {
    height: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: theme.background,
  });
  rightPane.onMouseDown = () => {
    if (disposed || modalOpen) return;
    if (activeChat?.node.visible) pane = "chat";
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
    box.add(new TextRenderable(renderer, {
      content: message,
      fg: tone === "error" ? theme.danger : theme.textMuted,
    }));
    return box;
  }

  function clearAuxiliary(): void {
    if (!auxiliaryChild) return;
    rightPane.remove(auxiliaryChild);
    auxiliaryChild.destroyRecursively();
    auxiliaryChild = null;
  }

  function showAuxiliary(child: Renderable): void {
    clearAuxiliary();
    auxiliaryChild = child;
    rightPane.add(child);
  }

  function disposeActiveView(): void {
    if (!activeView) return;
    const view = activeView;
    activeView = null;
    activeDestination = null;
    view.dispose();
    if (auxiliaryChild === view.node) auxiliaryChild = null;
    rightPane.remove(view.node);
    view.node.destroyRecursively();
  }

  function disposeActiveChat(): void {
    chatGeneration++;
    const chat = activeChat;
    activeChat = null;
    activeSessionNumber = null;
    activeChatState = "idle";
    if (chat) {
      chat.dispose?.();
      rightPane.remove(chat.node);
      chat.node.destroyRecursively();
    }
    if (!disposed) refreshSessionOptions();
  }

  function focusSidebar(target: "sessions" | "destinations" = sidebarFocus): void {
    if (disposed) return;
    pane = "sidebar";
    sidebarFocus = target;
    (target === "sessions" ? sessionMenu : destinationMenu).focus();
  }

  function refreshSessionOptions(): void {
    const selected = sessionMenu.getSelectedIndex();
    sessionMenu.options = sessionOptions(sessions, activeSessionNumber, activeChatState);
    sessionMenu.setSelectedIndex(Math.min(selected, sessions.length));
  }

  function clearPendingChat(sessionNumber: number, generation: number): void {
    if (generation !== chatGeneration || activeSessionNumber !== sessionNumber) return;
    chatGeneration++;
    activeSessionNumber = null;
    activeChatState = "idle";
    if (!disposed) refreshSessionOptions();
  }

  function leaveActiveView(next: () => void): void {
    if (!activeView) {
      next();
      return;
    }
    activeView.requestLeave(() => {
      disposeActiveView();
      next();
    });
  }

  function showChat(): void {
    clearAuxiliary();
    if (!activeChat) return;
    activeChat.node.visible = true;
    pane = "chat";
    activeChat.focus?.();
  }

  async function activateSessionNow(session: Session): Promise<void> {
    if (disposed) return;
    const index = sessions.findIndex((candidate) => candidate.number === session.number);
    if (index >= 0) sessionMenu.setSelectedIndex(index);
    sidebarFocus = "sessions";

    if (activeChat && activeSessionNumber === session.number) {
      showChat();
      return;
    }

    const request = ++activation;
    disposeActiveChat();
    const chatRequest = chatGeneration;
    activeSessionNumber = session.number;
    activeChatState = "idle";
    refreshSessionOptions();
    clearAuxiliary();
    showAuxiliary(placeholder(`Opening session ${String(session.number).padStart(3, "0")}…`));

    try {
      const chat = await options.makeSessionChat(session, {
        onBack: () => focusSidebar("sessions"),
        isInputActive: () => !disposed && pane === "chat" && !modalOpen,
        onInputFocus: () => {
          if (!disposed && !modalOpen && activeChat?.node.visible) pane = "chat";
        },
        onStateChange: (state) => {
          if (
            disposed ||
            chatRequest !== chatGeneration ||
            activeSessionNumber !== session.number
          ) return;
          activeChatState = state;
          refreshSessionOptions();
        },
      });
      if (disposed || request !== activation) {
        clearPendingChat(session.number, chatRequest);
        chat.dispose?.();
        chat.node.destroyRecursively();
        return;
      }
      clearAuxiliary();
      activeChat = chat;
      activeSessionNumber = session.number;
      rightPane.add(chat.node);
      pane = "chat";
      chat.focus?.();
    } catch (error) {
      clearPendingChat(session.number, chatRequest);
      if (disposed || request !== activation) return;
      showAuxiliary(placeholder(
        `Failed to open session: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      ));
      focusSidebar("sessions");
    }
  }

  function activateSession(session: Session): void {
    leaveActiveView(() => void activateSessionNow(session));
  }

  async function showDestinationNow(destination: Destination): Promise<void> {
    if (disposed) return;
    const request = ++activation;
    disposeActiveView();
    clearAuxiliary();
    if (activeChat) activeChat.node.visible = false;
    else disposeActiveChat();
    pane = "view";
    sidebarFocus = "destinations";
    showAuxiliary(placeholder(destination === "characters" ? "Opening characters…" : "Opening campaign…"));

    const paneOptions = {
      campaign,
      isActive: () => !disposed && pane === "view" && !modalOpen,
      onBack: () => focusSidebar("destinations"),
      onInputFocus: () => {
        if (!disposed && !modalOpen && activeView) pane = "view";
      },
      onCampaignChange: () => {
        campaignName.content = campaign.name;
        campaignSystem.content = campaign.system || "System not set";
      },
    };
    // Yield even for synchronous panes so the clicked menu finishes handling
    // focus before the newly mounted editor takes it.
    const view = await (destination === "characters"
      ? makeCharactersPane(renderer, paneOptions)
      : destination === "story"
        ? makeStoryPane(renderer, paneOptions)
        : makeCampaignSettingsPane(renderer, paneOptions));

    if (disposed || request !== activation) {
      view.dispose();
      view.node.destroyRecursively();
      return;
    }
    clearAuxiliary();
    activeView = view;
    activeDestination = destination;
    auxiliaryChild = view.node;
    rightPane.add(view.node);
    pane = "view";
    view.focus();
  }

  function showDestination(destination: Destination): void {
    if (activeView && activeDestination === destination && pane === "sidebar") {
      pane = "view";
      activeView.focus();
      return;
    }
    leaveActiveView(() => void showDestinationNow(destination));
  }

  function updateSessions(next: Session[], selected?: Session): void {
    sessions = next;
    refreshSessionOptions();
    const selectedIndex = selected
      ? sessions.findIndex((session) => session.number === selected.number)
      : Math.max(0, sessions.length - 1);
    sessionMenu.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : sessions.length);
  }

  let sessionDialog: ReturnType<typeof makeSessionDialog>;
  function openSessionDialog(): void {
    modalOpen = true;
    sessionDialog.open(campaign.nextSession);
  }

  sessionDialog = makeSessionDialog(renderer, {
    onSubmit: (sessionTitle) => {
      modalOpen = false;
      creating = true;
      status.fg = theme.textMuted;
      status.content = "Creating session…";
      void createSession(campaign, sessionTitle)
        .then(async (session) => {
          if (disposed) return;
          const next = await listSessions(campaign);
          if (disposed) return;
          updateSessions(next, session);
          status.content = "";
          creating = false;
          await activateSessionNow(session);
        })
        .catch((error: unknown) => {
          if (disposed) return;
          creating = false;
          status.fg = theme.danger;
          status.content = `Failed to create: ${error instanceof Error ? error.message : String(error)}`;
          focusSidebar("sessions");
        });
    },
    onCancel: () => {
      modalOpen = false;
      focusSidebar("sessions");
    },
  });
  renderer.root.add(sessionDialog.layer);

  sessionMenu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    if (modalOpen || creating) return;
    const session = sessions[index];
    if (session) activateSession(session);
    else if (index === sessions.length) leaveActiveView(openSessionDialog);
  });

  destinationMenu.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    if (modalOpen || creating) return;
    const destination = destinationOptions[index]?.value as Destination | undefined;
    if (destination) showDestination(destination);
  });

  const onScreenKeypress = (key: KeyEvent): void => {
    if (modalOpen || pane !== "sidebar") return;
    if (key.name === "escape") {
      key.preventDefault();
      leaveActiveView(options.onBack);
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      sidebarFocus = renderer.currentFocusedRenderable === sessionMenu ? "destinations" : "sessions";
      (sidebarFocus === "sessions" ? sessionMenu : destinationMenu).focus();
      return;
    }
    if (
      (key.name === "down" || key.name === "j") &&
      renderer.currentFocusedRenderable === sessionMenu &&
      sessionMenu.getSelectedIndex() === sessions.length
    ) {
      key.preventDefault();
      sidebarFocus = "destinations";
      destinationMenu.setSelectedIndex(0);
      destinationMenu.focus();
      return;
    }
    if (
      (key.name === "up" || key.name === "k") &&
      renderer.currentFocusedRenderable === destinationMenu &&
      destinationMenu.getSelectedIndex() === 0
    ) {
      key.preventDefault();
      sidebarFocus = "sessions";
      sessionMenu.setSelectedIndex(sessions.length);
      sessionMenu.focus();
    }
  };
  renderer.keyInput.on("keypress", onScreenKeypress);

  if (sessions.length > 0) await activateSessionNow(sessions[sessions.length - 1]!);
  else showAuxiliary(placeholder("No sessions yet — create one from the sidebar."));

  return {
    node: container,
    focus: () => {
      if (pane === "chat" && activeChat) activeChat.focus?.();
      else if (pane === "view" && activeView) activeView.focus();
      else (sidebarFocus === "sessions" ? sessionMenu : destinationMenu).focus();
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
      disposeActiveView();
      disposeActiveChat();
      clearAuxiliary();
    },
  };
}
