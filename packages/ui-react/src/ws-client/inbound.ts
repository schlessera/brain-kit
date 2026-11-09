import type { ClientMessage, InboxView, ServerMessage, ServerLocationRequest } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { restorationOf, type ChatState, type ChatKey } from "../stores/chat-state.js";
import type { SessionChat } from "../stores/chat-store.js";
import { dispatchServerMessage } from "../hooks/websocket-handlers/index.js";
import { runStateForFrame } from "../hooks/websocket-handlers/chat.js";
import type { DispatchContext } from "../hooks/websocket-handlers/types.js";
import type { DeltaBuffer } from "./delta-buffer.js";
import type { ReconnectHealing } from "./reconnect.js";
import type { RestorationDriver } from "./restoration.js";
import type { TurnRetries } from "./turn-retry.js";
import type { FollowUpPlacement } from "./follow-ups.js";
import type { AccountServices } from "./account.js";
import type { createConversationClient } from "../voice/conversation-client.js";

type InboundConversation = Pick<ReturnType<typeof createConversationClient>, "frame" | "historyOwnerFor" | "state">;

interface InboundDeps {
  disposed: () => boolean;
  conversation: InboundConversation;
  deltas: DeltaBuffer;
  healing: ReconnectHealing;
  restoration: Pick<RestorationDriver, "restoreIfNeeded">;
  retries: Pick<TurnRetries, "receipt">;
  followUps: FollowUpPlacement;
  services: AccountServices;
  /** The gated outbound path. */
  send: (message: ClientMessage) => boolean;
  /** The raw socket, for the activity subscription the host expects unconditionally. */
  socketSend: (message: ClientMessage) => void;
  requestBrowserLocation: (msg: ServerLocationRequest) => void;
}

/**
 * Frames that feed their own store and never touch chat state, routed
 * before the per-session demux. Activity stream frames, local exchange
 * results (#582: one names its message by exchange id, wherever that message
 * is) and handoff answers (#61: they name the review that asked) — and the
 * connection's own frames: retry and answer receipts and a session's queue
 * report (#1002), which say nothing about run state either.
 */
const CONNECTION_WIDE = new Set<ServerMessage["type"]>([
  "retry_receipt",
  "ask_answer_receipt",
  "session_queue",
  "scope_decision_receipt",
  "server_hello",
  "activity_snapshot",
  "activity_delta",
  "inbox_snapshot",
  "inbox_delta",
  "local_exchange_result",
  "handoff_draft",
  "handoff_receipt",
]);

/**
 * Every inbound frame, in order: the voice conversation's routing, the
 * restoration and turn-boundary prefilter, request receipts, then the typed
 * handler map — once for connection-wide frames, or after the demux has
 * found the frame's session buffer. The map is the single routing table.
 */
export function createInbound(root: BrainUiServices, deps: InboundDeps) {
  // A connect snapshot may answer after its captured turn ended on this socket.
  const endedTurns = new Map<string, Set<string>>();

  /**
   * Lazily open a session-scoped activity subscription (live subagent rows,
   * server-stamped tool timing). Idempotent per connection; the subscribed set
   * resets when a new socket's server_hello arrives.
   */
  function ensureActivitySubscription(sessionId: string | null | undefined): void {
    if (!sessionId) return;
    const activity = root.stores.activity.getState();
    if (!activity.supported || activity.subscribed[sessionId]) return;
    activity.markSubscribed(sessionId);
    deps.socketSend({ type: "activity_subscribe", view: "session", sessionId });
    // The subscription snapshot carries OPEN runs; finished runs (history
    // timing, past fan-outs) come from the REST side.
    void root.stores.activity.loadSessionActivityHistory(sessionId);
  }

  /**
   * Durable Queue/Actions (#684). Repeating a subscribe re-snapshots it. It
   * goes through the client's public `send`, the same path a card's decision
   * frame takes, so both share one transport and one connected check.
   */
  function subscribeInbox(view: InboxView): void {
    if (!root.stores.inbox.getState().supported) return;
    deps.send({ type: "inbox_subscribe", view });
  }

  function context(state: ChatState, key: ChatKey, frameSessionId: string | undefined, frameTurnId: string | undefined, buffer: () => SessionChat | null | undefined): DispatchContext {
    return {
      stores: root.stores,
      state,
      frameSessionId,
      frameTurnId,
      key,
      buffer,
      enqueueDelta: deps.deltas.enqueue,
      ensureActivitySubscription,
      subscribeInbox,
      requestBrowserLocation: deps.requestBrowserLocation,
      resyncIfNeeded: deps.healing.resyncIfNeeded,
      restoreIfNeeded: deps.restoration.restoreIfNeeded,
      markHistoryReplaced: deps.healing.markHistoryReplaced,
      retryReceipt: deps.retries.receipt,
      answerReceipt: (msg) => deps.services.answers.receipt(msg),
      queueReport: deps.followUps.queueReport,
    };
  }

  /**
   * Does this frame announce the identity of the conversation THIS client just
   * started?
   *
   * The old test was `session_info || result` for any unknown session, which
   * adopted whichever arrived first — an older background turn finishing, or
   * another client's new session, would capture the user's draft and bind it to
   * a transcript they never wrote. `draftId` is minted per draft turn and echoed
   * on `session_info`, so a match is proof.
   *
   * A server too old to echo it sends no `draftId`, and the pre-existing
   * behaviour applies rather than the draft never binding at all: correctness
   * where the information exists, compatibility where it does not.
   */
  function isOurDraftAnnouncement(state: ChatState, msg: ServerMessage): boolean {
    // A terminal result has no draft correlation. Another client's turn may
    // finish before our session_info arrives, so it can never claim our draft.
    if (msg.type !== "session_info") return false;
    const pending = state.pendingDraftId;
    if (msg.draftId) return msg.draftId === pending;
    // A resumed session (a late answer to opening or restoring one, #1328)
    // is never the conversation a draft is starting.
    if (msg.isNew === false) return false;
    // Known contextual work stays excluded after leave; only active voice may
    // exclude unknown requests by capability. A retained profile is historical.
    const voice = deps.conversation.state.getState();
    if (msg.requestId && voice.work[msg.requestId]?.provenance === "contextual") return false;
    if (voice.active && voice.profile?.capabilities.contextualTasks === "supported") return false;
    // No echo to compare against.
    return true;
  }

  /**
   * Restoration failures and turn boundaries, before the frame is routed.
   * Returns false when the frame is fully handled here.
   */
  function prefilter(msg: ServerMessage): boolean {
    const { sessionId, turnId } = msg as { sessionId?: string; turnId?: string };
    if (msg.type === "error" && msg.code === "SESSION_NOT_FOUND" && sessionId
      && !msg.requestId && !turnId && !msg.failure) {
      deps.deltas.flush();
      if (sessionId === deps.healing.reattaching()) deps.healing.endReattach();
      root.stores.chat.getState().failRestore(sessionId, { reason: "missing", message: msg.message });
      return false;
    }
    // A history read failing does not cancel a turn or disprove drawn content.
    if (msg.type === "error" && msg.code === "SESSION_LOAD_ERROR" && sessionId
      && !msg.requestId && !turnId && !msg.failure) {
      deps.deltas.flush();
      root.stores.connection.getState().reportError(msg.code, msg.message);
      if (sessionId === deps.healing.reattaching()) deps.healing.endReattach();
      // The selected session stays selected, and sending into it stays
      // blocked: the view says it could not be restored instead (#1328).
      if (restorationOf(root.stores.chat.getState())?.sessionId === sessionId) {
        root.stores.chat.getState().failRestore(sessionId, { reason: "error", message: msg.message });
      }
      return false;
    }
    if (msg.type === "status") {
      deps.deltas.flush();
      const live = sessionId ? root.stores.chat.getState().buffers[sessionId]?.messages.at(-1) : undefined;
      const currentTurn = live?.streamTurnId ?? live?.turnId;
      if (live?.isStreaming && currentTurn && sessionId && turnId
        && turnId !== currentTurn && endedTurns.get(sessionId)?.has(turnId)) return false;
    }
    if (sessionId && turnId && (msg.type === "result"
      || (msg.type === "status" && (msg.status === "idle" || msg.status === "cancelled")))) {
      const ended = endedTurns.get(sessionId) ?? new Set<string>();
      ended.add(turnId); endedTurns.set(sessionId, ended);
    }
    return true;
  }

  function handleServerMessage(msg: ServerMessage): void {
    if (deps.disposed() || root.authLock.state.getState().phase !== "active") return;
    // Voice frames bypass handleFrame; flush earlier backend text before observing them.
    if (msg.type.startsWith("conversation_")) deps.deltas.flush();
    const routed = deps.conversation.frame(msg);
    if (!routed) return;
    msg = routed;
    if (deps.services.safety.frame(msg)) return;
    if (!prefilter(msg)) return;
    handleFrame(msg);
    // After the demux, so a draft that just became this session is already
    // the session in view and is not mistaken for unwatched work.
    if (msg.type === "server_hello") {
      deps.services.trackers.hello(msg); deps.services.drafts.hello(msg); deps.services.attachmentReads.hello(msg);
      // Resume reports even an empty queue. Revalidate retained background
      // pills too; the selected session already reattaches on connection.
      for (const sessionId of Object.keys(root.stores.followUp.getState().pending)) {
        if (sessionId !== root.stores.chat.getState().activeSessionId) deps.send({ type: "session_resume", sessionId });
      }
    }
    else { deps.services.trackers.frame(msg); deps.services.attachmentReads.frame(msg); }
    deps.services.frameSeen();
  }

  /** Request receipts: a send accepted, refused or failed after it ran. */
  function trackRequest(msg: ServerMessage, state: ChatState): void {
    if ((msg.type === "session_info" || (msg.type === "status" && msg.status === "queued")) && msg.requestId) {
      state.setChatReceipt(msg.requestId, "accepted", msg.sessionId);
      if (msg.type === "status") root.stores.followUp.getState().markAccepted(msg.requestId);
      // Before the demux below: a new conversation's draft must already be
      // its session's when the view follows the session there.
      if (msg.type === "session_info") {
        const pending = root.stores.drafts.getState().sends[msg.requestId];
        if (pending?.sessionId && deps.conversation.historyOwnerFor(pending.sessionId))
          root.stores.drafts.getState().associateVoice(pending.draftId,msg.sessionId,msg.requestId,pending.sessionId);
      }
      if (deps.services.drafts.receipt(msg.requestId, "accepted", msg.sessionId)) state.clearChatReceipt(msg.requestId);
      // A follow-up sent as the session went idle runs at once, never queued:
      // its turn is starting now, so it is the agent's (#1002).
      if (msg.type === "session_info") {
        const started = root.stores.followUp.getState().takeLocal(msg.requestId);
        const turnId = (msg as { turnId?: string }).turnId;
        if (started) deps.followUps.place({ ...started, sessionId: msg.sessionId, ...(turnId ? { turnId } : {}) });
      }
    } else if (msg.type === "error" && !msg.requestId) {
      deps.services.drafts.error(msg);
    }
    if (msg.type === "error" && msg.requestId) {
      state.setChatReceipt(msg.requestId, "refused", msg.sessionId);
      // A turn-scoped error in a session means the request ran there: it was
      // accepted, then failed. One with no session left nothing to return to,
      // so its words come back to the draft, as a refusal's do.
      if (deps.services.drafts.receipt(msg.requestId, msg.turnId && msg.sessionId ? "accepted" : "refused", msg.sessionId)) state.clearChatReceipt(msg.requestId);
      root.stores.handoff.getState().noteRefusal(msg.requestId, msg.message);
      // A refused follow-up was never pending; the composer keeps its draft.
      // A turn-scoped error is not a refusal: the follow-up's turn started
      // and failed before it named itself, so the message is the agent's and
      // belongs above that failure.
      const ran = msg.turnId && msg.sessionId ? root.stores.followUp.getState().takeLocal(msg.requestId) : null;
      if (ran) deps.followUps.place({ ...ran, sessionId: msg.sessionId!, turnId: msg.turnId! });
      else root.stores.followUp.getState().dropLocal(msg.requestId);
    }
  }

  /** The run state and reattach bookkeeping of a scoped frame. Returns false to drop the frame. */
  function noteRunState(msg: ServerMessage, state: ChatState, frameSessionId: string | undefined): boolean {
    if (msg.type === "status" && frameSessionId && msg.status !== "queued" && msg.status !== "idle" && msg.status !== "cancelled") {
      // Any resumed buffer may have missed an old turn ending, including a
      // background session reopened after reconnect. New turns get new answers.
      const live = state.buffers[frameSessionId]?.messages.at(-1);
      const oldTurn = live?.streamTurnId ?? live?.turnId;
      if (msg.turnId && live?.isStreaming && oldTurn && oldTurn !== msg.turnId) state.finishAssistantMessage(frameSessionId);
    }
    const reattachSessionId = deps.healing.reattaching();
    if (msg.type === "status" && reattachSessionId !== null) {
      // The host's own answer for the session being reattached settles it.
      // A queued status (another request waiting) names no running turn:
      // the reattach waits for one that does, or that ends it.
      if (frameSessionId === reattachSessionId && msg.status !== "queued") {
        deps.healing.endReattach();
      }
      // The host greets every connection with an unscoped idle, also while
      // this session's turn is still running beside others. That greeting is
      // not about the session in view; the reattach's answer is (#1013).
      else if (!frameSessionId && state.activeSessionId === reattachSessionId) return false;
    }
    if (frameSessionId) {
      // `detail` on a queued status is the host's queue-pressure note; it rides
      // along so the session's badge can show WHY it is queued deep.
      const queueNote =
        msg.type === "status" && msg.status === "queued" ? msg.detail : undefined;
      // `message_blocks` arrives AFTER the turn's result (D42), and
      // `message_links` may (#1698); neither may reopen a finished session
      // or touch a queued follow-up that may already be running, so they
      // take no part in run state.
      if (msg.type !== "message_blocks" && msg.type !== "message_links" && msg.type !== "turn_journal" && msg.type !== "usage" && !(msg.type === "error" && msg.requestId && !msg.turnId)) {
        state.setRunState(frameSessionId, runStateForFrame(msg), queueNote);
      }
    }
    return true;
  }

  /** The buffer a scoped frame lands in, or undefined when it has none. */
  function bufferKeyFor(msg: ServerMessage, state: ChatState, frameSessionId: string | undefined): ChatKey | undefined {
    if (!frameSessionId) return state.activeSessionId; // null = the draft view
    if (state.buffers[frameSessionId]) return frameSessionId;
    if (msg.type === "session_info" && msg.draftId && root.stores.handoff.getState().pendingSend?.draftId === msg.draftId) {
      // A handoff destination (#61) just got its identity. It has no draft
      // buffer to adopt, so open one holding the reviewed text the host was
      // sent, and let the turn's frames stream into it like any session.
      const handoff = root.stores.handoff.getState();
      const sent = handoff.pendingSend!;
      state.setMessages(frameSessionId, []);
      state.addUserMessage(frameSessionId, sent.text, "handoff", undefined, { requestId: sent.requestId });
      state.startAssistantMessage(frameSessionId, undefined, sent.requestId);
      handoff.noteCreated(sent.handoffId, frameSessionId, true);
      return frameSessionId;
    }
    if (msg.type === "session_info" && msg.draftId && state.detachedDrafts[msg.draftId]) {
      // A new conversation the reader left before it was answered (#951):
      // its transcript becomes that session's, and the view stays put.
      state.bindDetachedDraft(msg.draftId, frameSessionId);
      return frameSessionId;
    }
    if (state.draft && isOurDraftAnnouncement(state, msg)) {
      // A draft run just got its server identity: adopt the draft buffer.
      state.bindDraftSession(frameSessionId);
      return frameSessionId;
    }
    if (msg.type === "session_info" && frameSessionId === state.activeSessionId) {
      // The ACTIVE session announced itself but has no buffer yet — the cold
      // reattach case (PWA relaunch mid-turn; the server may skip the history
      // frame when a first turn has no history yet). Materialize the buffer so
      // this session_info and every following delta land instead of vanishing.
      state.setActiveSession(frameSessionId);
      return frameSessionId;
    }
    // History replay may create a buffer (cold resume / reattach).
    if (msg.type === "session_history") return frameSessionId;
    // Scoped frame for a session with no buffer (never opened, or evicted):
    // the badge above is all we track. The transcript heals via
    // session_resume when the user opens it.
    return undefined;
  }

  function handleFrame(msg: ServerMessage): void {
    // Every frame that is not itself a delta must see the transcript fully
    // applied: the demux below reads buffer state, and the store records parts in
    // arrival order, so a tool call landing ahead of buffered text would reorder
    // the message.
    if (msg.type !== "text_delta" && msg.type !== "thinking_delta") deps.deltas.flush();
    const state = root.stores.chat.getState();
    if (CONNECTION_WIDE.has(msg.type)) {
      const key = state.activeSessionId;
      dispatchServerMessage(msg, context(state, key, undefined, undefined, () => (key === null ? state.draft : state.buffers[key])));
      return;
    }
    trackRequest(msg, state);

    // Parallel-session demux (per-session buffers). Every frame is scoped by
    // sessionId; a scoped frame lands in ITS session's buffer, so a background
    // session's transcript keeps accumulating while another one is in view.
    // Frames without a sessionId (legacy single-session servers, or a new
    // session's pre-binding frames) apply to the buffer in view.
    const frameSessionId = (msg as { sessionId?: string }).sessionId;
    if (!noteRunState(msg, state, frameSessionId)) return;
    const key = bufferKeyFor(msg, state, frameSessionId);
    if (key === undefined) return;
    if ((msg.type === "session_info" || msg.type === "status") && msg.requestId && msg.thinkingLevel !== undefined) {
      root.stores.chat.getState().setMessageEffort(key, msg.requestId, msg.thinkingLevel, msg.effectiveThinkingLevel);
    }
    dispatchServerMessage(msg, context(state, key, frameSessionId, (msg as { turnId?: string }).turnId, () => {
      const s = root.stores.chat.getState();
      return key === null ? s.draft : s.buffers[key];
    }));
  }

  return {
    handleServerMessage,
    /** A new socket: turns ended on the previous one no longer filter its frames. */
    resetTurns(): void { endedTurns.clear(); },
  };
}
