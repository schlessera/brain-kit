import { SESSION_RECOVERY_CAPABILITY, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { isSettledExchange, pendingApprovals, type ChatState } from "../stores/chat-state.js";
import { isWork, trackerEventsForFrame } from "./trackers.js";

/**
 * Keeps one root's trackers (D52 §4, #948) in step with its chat state and
 * its socket. It reads; it never sends a frame, selects a session, replies
 * to an interaction or starts a turn. The recovery read it makes is the
 * authenticated, read-only `GET /api/sessions/:id/recovery`, and only when
 * the host advertises it.
 */
/** How long one recovery read may take before it counts as unreachable. */
const RECOVERY_READ_TIMEOUT_MS = 10_000;

export function createTrackerClient(root: BrainUiServices) {
  const trackers = root.stores.trackers;
  const chat = root.stores.chat;
  let disposed = false;
  /** Reads asked for while one was in flight: run once more when it lands. */
  const again = new Set<string>();

  /** The newest send in a session that the host has neither accepted nor refused. */
  function unconfirmedRequest(state: ChatState, sessionId: string): string | null {
    if (!root.stores.connection.getState().chatRequestAck) return null;
    // A follow-up sent while the session was busy waits as a local entry
    // (#1002), not in the transcript; it is the newest send when present.
    const local = root.stores.followUp.getState().local[sessionId]?.at(-1)?.requestId;
    const requestId = local ?? state.buffers[sessionId]?.messages.findLast((m) => m.role === "user")?.requestId;
    if (!requestId) return null;
    if (trackers.getState().refusedRequests.includes(requestId)) return null;
    // The composer consumes a receipt once it has acted on it, so a missing
    // receipt proves nothing. The frames that accepted the request were
    // also tracker evidence: the session's latest request is this one.
    if (state.chatReceipts[requestId]) return null;
    const store = trackers.getState();
    if (store.acceptedRequests.includes(requestId)) return null;
    return store.evidence[sessionId]?.latest?.requestId === requestId ? null : requestId;
  }

  /** Something in the session is still in flight, or waits on the reader (D52 §4). */
  function qualifies(state: ChatState, sessionId: string): boolean {
    return working(state, sessionId) || unconfirmedRequest(state, sessionId) !== null;
  }

  /** Accepted work in flight, or an interaction waiting on the reader. */
  function working(state: ChatState, sessionId: string): boolean {
    const run = state.runStates[sessionId];
    if (run === "streaming" || run === "queued") return true;
    const buffer = state.buffers[sessionId];
    if (buffer) {
      if (buffer.isStreaming) return true;
      if (pendingApprovals({ buffers: { [sessionId]: buffer }, draft: null }).length > 0) return true;
      if (buffer.askUser && !isSettledExchange(buffer.askUser)) return true;
    }
    const evidence = trackers.getState().evidence[sessionId];
    if (evidence && (evidence.pending.length > 0 || evidence.latest?.state === "running" || evidence.latest?.state === "queued")) return true;
    return (root.stores.followUp.getState().pending[sessionId]?.length ?? 0) > 0;
  }

  /** The reader left `sessionId`: by New chat, by selecting another session, or by leaving the page. */
  function leave(sessionId: string): void {
    const state = chat.getState();
    if (qualifies(state, sessionId)) {
      const unconfirmedRequestId = unconfirmedRequest(state, sessionId);
      const onlyUnconfirmed = unconfirmedRequestId !== null && !working(state, sessionId);
      trackers.getState().track(sessionId, { unconfirmedRequestId, onlyUnconfirmed });
      refresh(sessionId);
    } else {
      trackers.getState().leftIdle(sessionId);
    }
  }

  function refresh(sessionId: string): void {
    if (disposed || trackers.getState().recoverySupported !== true) return;
    if (root.stores.connection.getState().wsStatus !== "connected") return;
    const store = trackers.getState();
    if (!store.records[sessionId]) return;
    if (!store.beginRead(sessionId)) { again.add(sessionId); return; }
    const epoch = store.epoch;
    // Bounded, so a stalled request cannot hold the session's live frames
    // forever: a timeout reads as host unreachable, and the next end of a
    // turn or hello asks again.
    void root.api.sessionRecovery(sessionId, { signal: AbortSignal.timeout(RECOVERY_READ_TIMEOUT_MS) }).then((result) => {
      if (disposed) return;
      trackers.getState().endRead(sessionId, result, epoch);
      if (again.delete(sessionId)) refresh(sessionId);
    });
  }

  function refreshAll(): void {
    for (const sessionId of Object.keys(trackers.getState().records)) refresh(sessionId);
  }

  // Leaving by selection or New chat moves the view off the session. A
  // draft becoming a session (`bindDraftSession`) moves it ONTO one, which
  // leaves nothing.
  let previous = chat.getState().activeSessionId;
  const unsubscribe = chat.subscribe((state) => {
    const left = previous;
    previous = state.activeSessionId;
    if (left !== null && left !== state.activeSessionId) leave(left);
  });

  // Leaving the page, or the tab going to the background, leaves the session
  // in view too: a reload must find its tracker, and an unwatched tab sees
  // nothing (D52 §4: seen needs a visible document).
  const leavePage = () => {
    const active = chat.getState().activeSessionId;
    if (active !== null) leave(active);
  };
  const onVisibility = () => { if (document.visibilityState === "hidden") leavePage(); };
  // Another tab of this root stored its trackers: take them in.
  const onStorage = () => { for (const sessionId of trackers.getState().syncFromStorage()) refresh(sessionId); };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  if (typeof window !== "undefined") window.addEventListener("pagehide", leavePage);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

  return {
    /**
     * One frame, after the chat demux has applied it. A frame for a session
     * that is not in view and has no tracker starts one only when it is
     * work: a late result or a replay for a session never left does not.
     */
    frame(msg: ServerMessage): void {
      if (disposed) return;
      const sessionId = (msg as { sessionId?: string }).sessionId;
      if (!sessionId) return;
      const store = trackers.getState();
      if (msg.type === "error" && msg.requestId && !(msg as { turnId?: string }).turnId) {
        // Refused, unless the host had already accepted it: an accepted
        // request that fails before its turn exists ends it, and the
        // envelope then says how.
        if (store.evidence[sessionId]?.latest?.requestId === msg.requestId || store.acceptedRequests.includes(msg.requestId)) refresh(sessionId);
        else store.refused(sessionId, msg.requestId);
        return;
      }
      // A queue report lists requests the host holds: each was accepted.
      if (msg.type === "session_queue") store.accepted([...msg.followUps.map((f) => f.requestId), msg.started?.requestId]);
      const events = trackerEventsForFrame(msg);
      const tracked = store.records[sessionId] !== undefined;
      // In view, in a visible document: a hidden tab watches nothing.
      const watched = chat.getState().activeSessionId === sessionId
        && (typeof document === "undefined" || document.visibilityState === "visible");
      if (!tracked && !watched) {
        if (!isWork(events)) return;
        store.track(sessionId);
      }
      store.live(sessionId, events);
      // The end of a turn is when the host has times and an outcome to give.
      // A turn-scoped `error` may be the only frame a failed start sends,
      // with no result after it: it changes no state here, but the host's
      // envelope then says how the turn ended.
      const ended = events.some((e) => e.kind === "terminal")
        || (msg.type === "status" && msg.status === "idle")
        || msg.type === "error"
        // A queue report that dropped a request (an expired or revoked
        // sender's) ends it without a turn frame.
        || (msg.type === "session_queue" && (msg.dropped?.length ?? 0) > 0);
      if (!tracked && !watched) refresh(sessionId);
      else if (ended) refresh(sessionId);
    },

    hello(msg: Extract<ServerMessage, { type: "server_hello" }>): void {
      if (disposed) return;
      const store = trackers.getState();
      store.resume();
      store.setPrincipal(msg.principalKey ?? null);
      store.setRecoverySupported(msg.capabilities?.[SESSION_RECOVERY_CAPABILITY] === true);
      refreshAll();
    },

    /** The host closed the socket for revocation or expiry: the set is deleted (D52 §4). */
    revoked(): void {
      if (!disposed) trackers.getState().revoke();
    },

    dispose(): void {
      disposed = true;
      unsubscribe();
      again.clear();
      if (typeof window !== "undefined") window.removeEventListener("pagehide", leavePage);
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
