import { createRoot } from "react-dom/client";
import { AppShell, BrainUiProvider, ChatPage, ConnectionGate, createBrainUiRoot } from "../../src/index.ts";
import { trackerViews } from "../../src/stores/tracker-state.ts";

// Connection drops in the whole app (#1013): ChatPage in AppShell behind the
// ConnectionGate, the way a hosting shell composes them, on one root with a
// stable storage prefix. The test drives it only through the browser and the
// host; this probe reads state and never changes it.
const root = createBrainUiRoot({ storagePrefix: "odysseus-continuity", config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });

const mount = document.getElementById("app");
if (!mount) throw new Error("Connection-continuity fixture mount is missing");
createRoot(mount).render(
  <BrainUiProvider root={root}>
    <ConnectionGate>
      <AppShell><ChatPage /></AppShell>
    </ConnectionGate>
  </BrainUiProvider>,
);

Object.assign(window, {
  __continuity: {
    connected: () => root.stores.connection.getState().wsStatus === "connected",
    wsStatus: () => root.stores.connection.getState().wsStatus,
    vpnStatus: () => root.stores.connection.getState().vpnStatus,
    draftsSupported: () => root.stores.drafts.getState().supported,
    activeSessionId: () => root.stores.chat.getState().activeSessionId,
    streaming: (sessionId: string) => Boolean(root.stores.chat.getState().buffers[sessionId]?.isStreaming),
    views: () => trackerViews(root.stores.trackers.getState(), root.stores.chat.getState().queueNotes)
      .map((v) => ({ sessionId: v.sessionId, state: v.state })),
    draft: () => {
      const drafts = root.stores.drafts.getState();
      const d = drafts.drafts[drafts.idFor(root.stores.chat.getState().activeSessionId)];
      return { text: d?.text ?? "", images: d?.attachments.length ?? 0, sessionId: d?.sessionId ?? null };
    },
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
