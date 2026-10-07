import { SESSION_RECOVERY_CAPABILITY, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { isSettledExchange, pendingApprovals, type ChatState } from "../stores/chat-state.js";
import { applySnapshot, evidenceFromRecord, isWork, trackerEventsForFrame } from "./trackers.js";
import { answeredByResult, closureFromEnvelope, openRestoredCards, type RestoredApprovalClosure } from "./restored-approvals.js";
import { trackerViews } from "../stores/tracker-state.js";
import { createTrackerAnnouncer } from "./tracker-announcer.js";

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
    // A send the host never confirmed leaves the transcript for its review
    // block (#951, D52 §5); the draft store still holds it.
    const held = Object.values(root.stores.drafts.getState().sends)
      .filter((s) => s.state === "unconfirmed" && s.sessionId === sessionId)
      .sort((a, b) => b.sentAt - a.sentAt)[0];
    if (held) return held.requestId;
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
    // Not the session list's run badge: a resume's replay sets it to
    // streaming with no work at all. Host-named turns and evidence only.
    const buffer = state.buffers[sessionId];
    if (buffer) {
      // The composer opens the answer's bubble before the host has accepted
      // anything; only a bubble a host frame has named a turn for is work.
      if (buffer.isStreaming && buffer.messages.some((m) => m.role === "assistant" && m.isStreaming && m.turnId)) return true;
      if (pendingApprovals({ buffers: { [sessionId]: buffer }, draft: null }).length > 0) return true;
      if (buffer.askUser && !isSettledExchange(buffer.askUser)) return true;
    }
    const evidence = trackers.getState().evidence[sessionId];
    if (evidence && (evidence.pending.length > 0 || evidence.latest?.state === "running" || evidence.latest?.state === "queued")) return true;
    // A follow-up the host reports holding; a local entry it has not
    // reported is an unconfirmed send, not accepted work.
    return root.stores.followUp.getState().pending[sessionId]?.some((p) => p.confirmed) ?? false;
  }

  /**
   * An approval decided on this page (Allow or Deny on its card) is no
   * longer waiting on anyone, though its tool may run long before the
   * result arrives: settle it in the evidence as soon as the card records
   * the decision. Only a decision counts: a replayed tool call reads as
   * complete before its pending approval is re-delivered.
   */
  function settleDecidedApprovals(state: ChatState): void {
    const store = trackers.getState();
    for (const [sessionId, evidence] of Object.entries(store.evidence)) {
      const approvals = evidence.pending.filter((p) => p.kind === "approval");
      if (approvals.length === 0) continue;
      const tools = state.buffers[sessionId]?.messages.flatMap((m) => m.toolCalls) ?? [];
      const decided = approvals.filter((p) => tools.some((t) => t.id === p.requestId && (t.status === "approved" || t.status === "denied")));
      if (decided.length > 0) store.live(sessionId, decided.map((p) => ({ kind: "settled" as const, requestId: p.requestId })));
    }
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

  /** The host advertises recovery: restored cards follow its envelope (#1072). */
  const recovering = () => trackers.getState().recoverySupported === true;

  /**
   * Close restored cards, and settle their requests in the session's
   * evidence: a closed card waits on nobody, even when a frame held behind a
   * read listed it again.
   */
  function closeRestored(sessionId: string, closures: Array<{ toolUseId: string; closure: RestoredApprovalClosure }>): void {
    if (closures.length === 0) return;
    chat.getState().closeRestoredApprovals(sessionId, closures);
    settleRequests(sessionId, closures.map((c) => c.toolUseId));
  }

  function settleRequests(sessionId: string, requestIds: string[]): void {
    const store = trackers.getState();
    if (requestIds.length === 0 || (!store.evidence[sessionId] && !store.reading[sessionId])) return;
    store.live(sessionId, requestIds.map((requestId) => ({ kind: "settled" as const, requestId })));
  }

  /**
   * An unauthorized read: no restored card is this principal's to answer.
   * Every one is revoked, and what each session's evidence still lists for
   * them goes too, so no tracker asks for a card that can no longer answer.
   */
  function revokeRestored(): void {
    const byBuffer = Object.entries(chat.getState().buffers).map(([sessionId, buffer]) => ({
      sessionId,
      ids: buffer.messages.flatMap((m) => m.toolCalls.filter((t) => t.restored).map((t) => t.id)),
    }));
    chat.getState().revokeRestoredApprovals();
    for (const { sessionId, ids } of byBuffer) settleRequests(sessionId, ids);
  }

  function refresh(sessionId: string): void {
    if (disposed || trackers.getState().recoverySupported !== true) return;
    if (root.stores.connection.getState().wsStatus !== "connected") return;
    const store = trackers.getState();
    // A tracked session, or one holding a restored card: the card's controls
    // follow this same read (#1072), so there is no second poller.
    if (!store.records[sessionId] && openRestoredCards(chat.getState().buffers[sessionId]).length === 0) return;
    if (!store.beginRead(sessionId)) { again.add(sessionId); return; }
    const epoch = store.epoch;
    // Only cards restored before the read began: a request raised after the
    // host took its snapshot is not in it, and its absence proves nothing.
    const cards = openRestoredCards(chat.getState().buffers[sessionId]);
    // Bounded, so a stalled request cannot hold the session's live frames
    // forever: a timeout reads as host unreachable, and the next end of a
    // turn or hello asks again.
    void root.api.sessionRecovery(sessionId, { signal: AbortSignal.timeout(RECOVERY_READ_TIMEOUT_MS) }).then((result) => {
      if (disposed) return;
      const current = trackers.getState().epoch === epoch;
      // Whether the evidence accepts the envelope itself, judged before the
      // frames held behind it are replayed: live proof clears a rollback
      // mark, but it does not make the rejected snapshot's pending list true.
      const before = trackers.getState().evidence[sessionId] ?? evidenceFromRecord(trackers.getState().records[sessionId]);
      const rejected = result.ok && applySnapshot(before, result.recovery).rolledBack;
      const ambiguous = trackers.getState().endRead(sessionId, result, epoch);
      // After the envelope and the frames held behind it are applied: a
      // closure then settles whatever they listed for the card.
      if (current) {
        // A card decided on this page while the read was out is not the
        // host's to close: its absence is this page's own answer.
        const open = new Set(openRestoredCards(chat.getState().buffers[sessionId]).map((c) => c.toolUseId));
        const still = cards.filter((card) => open.has(card.toolUseId));
        if (result.ok) {
          // A snapshot the evidence rejected (a rollback, or a contradiction
          // at one revision) proves nothing, its pending list included: the
          // cards stop taking a decision, with no reason, until a read the
          // evidence accepts.
          if (rejected) {
            closeRestored(sessionId, still.map((card) => ({ toolUseId: card.toolUseId, closure: "unlisted" as const })));
          } else {
            const closures = still.map((card) => ({ toolUseId: card.toolUseId, closure: closureFromEnvelope(card, result.recovery) }));
            // Listed again by an envelope that counts: live again.
            chat.getState().reopenRestoredApprovals(sessionId, closures.filter((c) => c.closure === null).map((c) => c.toolUseId));
            closeRestored(sessionId, closures.flatMap((c) => (c.closure ? [{ toolUseId: c.toolUseId, closure: c.closure }] : [])));
          }
        } else if (result.reason === "unauthorized") {
          revokeRestored();
        } else if (result.reason === "session_not_found") {
          // The session is gone, and the turn that raised the card with it.
          closeRestored(sessionId, still.map((card) => ({ toolUseId: card.toolUseId, closure: "ended" as const })));
        }
      }
      // A card decided while the read held its approval's frame.
      settleDecidedApprovals(chat.getState());
      if (again.delete(sessionId) || ambiguous) refresh(sessionId);
    });
  }

  function refreshAll(): void {
    const sessions = new Set(Object.keys(trackers.getState().records));
    for (const [sessionId, buffer] of Object.entries(chat.getState().buffers)) {
      if (openRestoredCards(buffer).length > 0) sessions.add(sessionId);
    }
    for (const sessionId of sessions) refresh(sessionId);
  }

  /**
   * Restored cards in buffers that changed (#1072): one a `tool_result`
   * answered while it waited here is closed as answered, and a newly
   * restored one asks the host whether it is still pending.
   */
  function reconcileRestored(state: ChatState, prev: ChatState): void {
    if (!recovering()) return;
    for (const [sessionId, buffer] of Object.entries(state.buffers)) {
      const before = prev.buffers[sessionId];
      if (buffer === before) continue;
      closeRestored(sessionId, answeredByResult(before, buffer).map((toolUseId) => ({ toolUseId, closure: "answered" as const })));
      const known = new Set(openRestoredCards(before).map((c) => c.toolUseId));
      if (openRestoredCards(chat.getState().buffers[sessionId]).some((c) => !known.has(c.toolUseId))) refresh(sessionId);
    }
  }

  // Leaving by selection or New chat moves the view off the session. A
  // draft becoming a session (`bindDraftSession`) moves it ONTO one, which
  // leaves nothing.
  let previous = chat.getState().activeSessionId;
  const unsubscribe = chat.subscribe((state, prev) => {
    settleDecidedApprovals(state);
    reconcileRestored(state, prev);
    const left = previous;
    previous = state.activeSessionId;
    if (left !== null && left !== state.activeSessionId) leave(left);
    // Opening a tracked session is a reason to ask again: a read that failed
    // earlier may succeed now, and the latest turn is what seen needs.
    if (state.activeSessionId !== null && state.activeSessionId !== left) refresh(state.activeSessionId);
  });

  // Leaving the page, or the tab going to the background, leaves the session
  // in view too: a reload must find its tracker, and an unwatched tab sees
  // nothing (D52 §4: seen needs a visible document).
  const leavePage = () => {
    const active = chat.getState().activeSessionId;
    if (active !== null) leave(active);
  };
  const onVisibility = () => { if (document.visibilityState === "hidden") leavePage(); };
  // Trackers taken in from another tab's write, when this tab wrote: read them.
  // And every change is a chance for an announcement (D52 §3): only a
  // settled change into needs you, failed or done is one.
  const announcer = createTrackerAnnouncer();
  const unsubscribeReads = trackers.subscribe((state, prev) => {
    // A revocation: no restored card is this principal's to answer (#1072).
    if (state.suspended && !prev.suspended && state.recoverySupported === true) chat.getState().revokeRestoredApprovals();
    if (state.pendingReads.length > 0) for (const sessionId of trackers.getState().takePendingReads()) refresh(sessionId);
    // Writing an announcement re-enters here with nothing new to say.
    const now = trackers.getState();
    for (const a of announcer.observe(trackerViews(now, chat.getState().queueNotes))) now.announce(a);
  });

  // Another tab of this root stored its trackers: take them in.
  const onStorage = (event: Event) => {
    const changedKey = (event as StorageEvent).key;
    for (const sessionId of trackers.getState().syncFromStorage(changedKey)) refresh(sessionId);
  };
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
      // The turn that raised a restored card ended: the card ended with it.
      const frameTurn = (msg as { turnId?: string }).turnId;
      if (recovering() && frameTurn && (msg.type === "result" || (msg.type === "status" && msg.status === "cancelled"))) {
        closeRestored(sessionId, openRestoredCards(chat.getState().buffers[sessionId])
          .filter((card) => card.turnId === frameTurn)
          .map((card) => ({ toolUseId: card.toolUseId, closure: "ended" as const })));
      }
      const store = trackers.getState();
      if (msg.type === "error" && msg.requestId && !(msg as { turnId?: string }).turnId) {
        // Refused, unless the host had already accepted it: an accepted
        // request that fails before its turn exists ends it, and the
        // envelope then says how.
        if (store.evidence[sessionId]?.latest?.requestId === msg.requestId || store.acceptedRequests.includes(msg.requestId)) {
          refresh(sessionId);
          return;
        }
        store.refused(sessionId, msg.requestId);
        // Not every acceptance is announced with its request (a known
        // session's acceptance says only `thinking`), so the host decides
        // what the session's latest work now is.
        refresh(sessionId);
        return;
      }
      // A queue report lists requests the host holds: each was accepted.
      if (msg.type === "session_queue") store.accepted([...msg.followUps.map((f) => f.requestId), msg.started?.requestId]);
      // A late duplicate of a request whose restored card the host already
      // closed with a reason waits on nobody: it is not pending work.
      const closedHere = (requestId: string) => chat.getState().buffers[sessionId]?.messages.some((m) =>
        m.toolCalls.some((t) => t.id === requestId && t.restored && t.readOnly !== undefined && t.readOnly !== "unlisted")) ?? false;
      const events = trackerEventsForFrame(msg).filter((e) => e.kind !== "pending" || e.entry.kind !== "approval" || !closedHere(e.entry.requestId));
      const tracked = store.records[sessionId] !== undefined;
      // In view, in a visible document: a hidden tab watches nothing.
      const watched = chat.getState().activeSessionId === sessionId
        && (typeof document === "undefined" || document.visibilityState === "visible");
      if (!tracked && !watched) {
        if (!isWork(events)) return;
        announcer.background(sessionId);
        store.track(sessionId);
      }
      // A turn starting while the latest work is unknown: only the host can
      // say whether it is that work, older work or newer.
      const unknownBefore = store.evidence[sessionId]?.latest?.state === "unknown";
      store.live(sessionId, events);
      if (unknownBefore && events.some((e) => e.kind === "running" && e.dispatch) && trackers.getState().evidence[sessionId]?.latest?.state === "unknown") refresh(sessionId);
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
      unsubscribeReads();
      again.clear();
      if (typeof window !== "undefined") window.removeEventListener("pagehide", leavePage);
      if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
