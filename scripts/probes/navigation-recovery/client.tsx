import { createRoot } from "react-dom/client";
import {
  AppShell,
  ActivityPage,
  BrainUiProvider,
  ChatPage,
  GraphPage,
  activeChat,
  createBrainUiRoot,
  useUIStore,
} from "@schlessera/brain-ui-react";

let root = createBrainUiRoot({
  storagePrefix: "odysseus-navigation-probe",
  config: { appName: "Odysseus’s notebook", assistantName: "Brain" },
});
let release = root.connection.connect();
const mount = createRoot(document.getElementById("app")!);
function Shell() {
  const view = useUIStore((s) => s.activeView);
  return (
    <AppShell>
      {view === "activity" ? (
        <ActivityPage />
      ) : view === "graph" ? (
        <GraphPage />
      ) : (
        <ChatPage />
      )}
    </AppShell>
  );
}
function render() {
  mount.render(
    <BrainUiProvider root={root}>
      <Shell />
    </BrainUiProvider>
  );
}
render();
Object.assign(window, {
  probe: {
    ready: () => root.stores.connection.getState().wsStatus === "connected",
    state: () => {
      const chat = root.stores.chat.getState();
      return {
        active: chat.activeSessionId,
        pendingDraftId: chat.pendingDraftId,
        buffers: chat.buffers,
        runStates: chat.runStates,
        draft: chat.draft,
        receipts: chat.chatReceipts,
        activeChat: activeChat(chat),
        ui: root.stores.ui.getState(),
        ack: root.stores.connection.getState().chatRequestAck,
      };
    },
    frame: (
      frame: Parameters<typeof root.connection.handleServerMessage>[0]
    ) => {
      root.connection.handleServerMessage(frame);
      root.connection.flushChatDeltas();
    },
    reset: (occupied = true) => {
      root.stores.ui.getState().closeAllPanels();
      root.stores.ui.getState().setActiveView("chat");
      root.stores.chat.setState({
        buffers: {},
        draft: null,
        activeSessionId: null,
        runStates: {},
        queueNotes: {},
        pendingDraftId: null,
      });
      if (occupied) {
        const c = root.stores.chat.getState();
        c.setActiveSession("odysseus-A");
        c.addUserMessage("odysseus-A", "Raft supplies");
        c.startAssistantMessage("odysseus-A");
        c.appendText("odysseus-A", "Timber and rope are packed.");
        c.finishAssistantMessage("odysseus-A");
      }
    },
    view: (name: string) => {
      const u = root.stores.ui.getState();
      if (name === "files") u.setFilePanelOpen(true);
      else if (name === "settings") u.setSettingsPanelOpen(true);
      else u.setActiveView(name as any);
    },
    sessions: () => root.stores.ui.getState().setSessionPanelOpen(true),
    select: (id: string) => root.stores.chat.getState().setActiveSession(id),
    clear: () => root.stores.chat.getState().clearMessages(),
    send: (value: Parameters<typeof root.connection.send>[0]) =>
      root.connection.send(value),
    disconnect: () => root.connection.dispose(),
    fresh: () => {
      release();
      root.dispose();
      root = createBrainUiRoot({
        storagePrefix: "odysseus-navigation-probe",
        config: { appName: "Odysseus’s notebook", assistantName: "Brain" },
      });
      release = root.connection.connect();
      render();
    },
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
