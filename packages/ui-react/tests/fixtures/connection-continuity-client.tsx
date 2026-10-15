import { createRoot } from "react-dom/client";
import { AppShell, BrainUiProvider, ChatPage, ConnectionGate, createBrainUiRoot } from "../../src/index.ts";
import { trackerViews } from "../../src/stores/tracker-state.ts";
import { restorationOf } from "../../src/stores/chat-state.ts";

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
const observePreparation = (window as unknown as { __observeContinuityPreparation?: boolean }).__observeContinuityPreparation === true;
type PreparationFrame = { socket: number; direction: "sent" | "received"; type: string; sessionId?: string; turnId?: string; detail?: string; append?: boolean };
const preparationFrames: PreparationFrame[] = [];
const socketIds = new WeakMap<WebSocket, number>();
let currentSocket = 0, observationErrors = 0, recording = observePreparation;
function recordPreparation(socket: number, direction: PreparationFrame["direction"], frame: PreparationFrame) {
  if (!recording) return;
  if (preparationFrames.length >= 1_000) { observationErrors++; return; }
  preparationFrames.push({ socket, direction, type: frame.type, sessionId: frame.sessionId,
    turnId: frame.turnId, detail: frame.detail, append: frame.append });
}
class ObservedSocket extends NativeSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    const socket = recording ? ++currentSocket : 0;
    if (recording) socketIds.set(this, socket);
    this.addEventListener("message", event => {
      const frame = JSON.parse(event.data);
      frames.push({ at: Date.now(), type: frame.type, sessionId: frame.sessionId, turnId: frame.turnId,
        status: frame.status, text: frame.text?.slice(-240), followUps: frame.followUps, started: frame.started, dropped: frame.dropped });
      if (frames.length > 256) frames.shift();
      queueMicrotask(() => {
        recordPreparation(socket, "received", frame);
        const key = `${frame.type}:${frame.sessionId ?? ""}`;
        received.set(key, (received.get(key) ?? 0) + 1);
        received.set(`${frame.type}:*`, (received.get(`${frame.type}:*`) ?? 0) + 1);
      });
    });
  }
}
// Only the three snapshot cases observe sends. This is the fixture class's
// own prototype, not the native WebSocket prototype; actual return/throw and
// argument identity are preserved, and failed sends are never counted.
const originalSend = ObservedSocket.prototype.send;
const originalSendDescriptor = Object.getOwnPropertyDescriptor(ObservedSocket.prototype, "send");
if (observePreparation) Object.defineProperty(ObservedSocket.prototype, "send", { configurable: true, writable: true,
  value: function(this: WebSocket, ...args: Parameters<typeof originalSend>) {
    const result = Reflect.apply(originalSend, this, args);
    try { recordPreparation(socketIds.get(this) ?? 0, "sent", JSON.parse(String(args[0]))); }
    catch { observationErrors++; }
    return result;
  } });
function disposePreparation() {
  recording = false;
  if (observePreparation) {
    if (originalSendDescriptor) Object.defineProperty(ObservedSocket.prototype, "send", originalSendDescriptor);
    else delete (ObservedSocket.prototype as { send?: typeof originalSend }).send;
  }
  const restored = Object.getOwnPropertyDescriptor(ObservedSocket.prototype, "send");
  const descriptorRestored = originalSendDescriptor === undefined ? restored === undefined
    : restored !== undefined && (["value", "writable", "get", "set", "enumerable", "configurable"] as const)
      .every(key => restored[key] === originalSendDescriptor[key]);
  return { sendRestored: descriptorRestored && ObservedSocket.prototype.send === originalSend, recording };
}
Object.assign(window, { __disposeContinuityPreparation: disposePreparation });
Object.assign(window, { WebSocket: ObservedSocket });

let disposeRoot: (() => void) | undefined;
try {
  const root = createBrainUiRoot({ storagePrefix: "odysseus-continuity", config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });

  disposeRoot = () => root.dispose();
  const mount = document.getElementById("app");
  if (!mount) throw new Error("Connection-continuity fixture mount is missing");
  createRoot(mount).render(
    <BrainUiProvider root={root}>
      <ConnectionGate>
        <AppShell><ChatPage /></AppShell>
      </ConnectionGate>
    </BrainUiProvider>,
  );

  // Acknowledged current content, not a generic pending=false snapshot.
  // Host-sequence fences exclude older refresh reads; native context writes
  // and the later captured-history observations remain independent.
  function currentDraftAcknowledged(sessionId: string, text: string) {
    const drafts = root.stores.drafts.getState();
    const draft = drafts.drafts[drafts.idFor(sessionId)];
    const restore = root.localWork?.restore.getState();
    return draft?.text === text && draft.attachments.length === 0 && draft.host !== null
      && draft.host.revision > 0 && draft.host.edit === draft.edit && draft.savingSince === null
      && !draft.bind && !draft.uncertain && !draft.failure && !draft.conflict && !draft.deviceConflict && !draft.deviceOnly
      && drafts.orphans.length === 0 && !restore?.selection && !restore?.focusId && !restore?.scroll;
  }

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
      preparation: observePreparation ? {
        restoring: () => root.localWork!.restoring(),
        recovered: (sessionId: string, text: string) => {
          const chat = root.stores.chat.getState();
          const connection = root.stores.connection.getState();
          return recording && observationErrors === 0 && currentSocket > 0
            && connection.wsStatus === "connected" && connection.vpnStatus === "connected"
            && chat.activeSessionId === sessionId && restorationOf(chat) === null
            && Object.keys(chat.turnRetries).length === 0
            && (root.stores.followUp.getState().pending[sessionId]?.length ?? 0) === 0
            && currentDraftAcknowledged(sessionId, text);
        },
        checkpoint: (sessionId: string) => ({ socket: currentSocket, cursor: preparationFrames.length,
          heldResumes: preparationFrames.filter(f => f.socket === currentSocket && f.direction === "sent" && f.type === "session_resume" && f.sessionId === sessionId).length }),
        ready: (checkpoint: { socket: number; cursor: number }, sessionId: string, oldTurn: string, text: string) => {
          if (!recording || observationErrors || checkpoint.socket !== currentSocket) return false;
          const frames = preparationFrames.slice(checkpoint.cursor).filter(f => f.socket === checkpoint.socket && f.sessionId === sessionId);
          const resumes = frames.filter(f => f.direction === "sent" && f.type === "session_resume").length;
          const replies = frames.filter(f => f.direction === "received");
          const histories = replies.filter(f => f.type === "session_history" && f.append !== true).length;
          const completed = replies.filter(f => f.type === "status" && (f.detail === "Session loaded" || f.detail === "Session in progress")).length;
          const newer = replies.findLast(f => f.type === "text_delta" && f.turnId && f.turnId !== oldTurn)?.turnId;
          const chat = root.stores.chat.getState();
          const buffer = chat.buffers[sessionId];
          const answer = buffer?.messages.at(-1);
          // The captured reconnect reads are still held. Only the old result's
          // subsequent resync can produce these history/detail completions.
          // Native synchronous handlers have run before this later page task;
          // committed replay/current-turn state is checked separately.
          return resumes > 0 && histories === resumes && completed === resumes && newer !== undefined
            && chat.activeSessionId === sessionId && buffer?.isStreaming === true && !buffer.replay
            && (answer?.streamTurnId ?? answer?.turnId) === newer && restorationOf(chat) === null
            && Object.keys(chat.turnRetries).length === 0 && (root.stores.followUp.getState().pending[sessionId]?.length ?? 0) === 0
            && currentDraftAcknowledged(sessionId, text);
        },
      } : undefined,
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
  window.addEventListener("pagehide", () => { try { disposePreparation(); } finally { root.dispose(); } }, { once: true });
} catch (error) {
  // Initialization can fail before pagehide is installed. Restore the fixture's
  // own send descriptor even then; test teardown reads it back before closing.
  try { disposePreparation(); } finally { disposeRoot?.(); }
  throw error;
}
