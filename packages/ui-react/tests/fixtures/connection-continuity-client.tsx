import { createRoot } from "react-dom/client";
import { AppShell, BrainUiProvider, ChatPage, ConnectionGate, createBrainUiRoot } from "../../src/index.ts";
import { trackerViews } from "../../src/stores/tracker-state.ts";

// Connection drops in the whole app (#1013): ChatPage in AppShell behind the
// ConnectionGate, the way a hosting shell composes them, on one root with a
// stable storage prefix. The test drives it only through the browser and the
// host; this probe reads state and never changes it.
// Observe native frame delivery; tests read these counts on a later page task
// and separately check committed replay state. The production history/status
// handlers are synchronous; this does not drain arbitrary asynchronous handlers.
const frames: unknown[] = [];
const received = new Map<string, number>();
const NativeSocket = WebSocket;
class ObservedSocket extends NativeSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.addEventListener("message", event => {
      const frame = JSON.parse(event.data);
      frames.push({ at: Date.now(), type: frame.type, sessionId: frame.sessionId, turnId: frame.turnId,
        status: frame.status, text: frame.text?.slice(-240), followUps: frame.followUps, started: frame.started, dropped: frame.dropped });
      if (frames.length > 256) frames.shift();
      queueMicrotask(() => {
        const key = `${frame.type}:${frame.sessionId ?? ""}`;
        received.set(key, (received.get(key) ?? 0) + 1);
        received.set(`${frame.type}:*`, (received.get(`${frame.type}:*`) ?? 0) + 1);
      });
    });
  }
}
Object.assign(window, { WebSocket: ObservedSocket });

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
    diagnostic: () => {
      const chat = root.stores.chat.getState();
      return { activeSessionId: chat.activeSessionId, queueNotes: chat.queueNotes, frames,
        buffers: Object.fromEntries(Object.entries(chat.buffers).map(([id, buffer]) => [id, {
          streaming: buffer.isStreaming, replay: Boolean(buffer.replay),
          messages: buffer.messages.slice(-4).map(message => ({ id: message.id, turnId: message.turnId,
            role: message.role, streaming: message.isStreaming, content: message.content.slice(-2000) })),
        }])) };
    },
    replayComplete: (sessionId: string) => !root.stores.chat.getState().buffers[sessionId]?.replay,
    received: (type: string, sessionId: string) => received.get(`${type}:${sessionId}`) ?? 0,
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
