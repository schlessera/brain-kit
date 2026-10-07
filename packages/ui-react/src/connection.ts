import { BrainUiClient, type WebSocketClose } from "@schlessera/brain-ui-sdk/client";
import type { ServerMessage, ClientMessage, ServerLocationRequest, InboxView } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "./root.js";
import { activeChat, localExchangesForDraft, type ChatState, type ChatKey } from "./stores/chat-state.js";
import type { StartedFollowUp } from "./stores/follow-up-state.js";
import { dispatchServerMessage } from "./hooks/websocket-handlers/index.js";
import { runStateForFrame } from "./hooks/websocket-handlers/chat.js";
import { REFUSAL_ATTEMPTS } from "./components/connectivity/connection-state.js";
import { createAnswerDelivery } from "./lib/answer-delivery/manager.js";
import { createTrackerClient } from "./lib/tracker-client.js";
import { createDraftClient } from "./lib/draft-client.js";

const authLifecycles = new WeakMap<object, { drop(): void; restore(): void }>();
/** @internal Called only after the gate removes protected views. */
export function dropConnectionContext(root: BrainUiServices): void { authLifecycles.get(root.stores)?.drop(); }
/** @internal Called after confirmed same-account work restore. */
export function restoreConnectionContext(root: BrainUiServices): void { authLifecycles.get(root.stores)?.restore(); }

/** Every callback and mutable queue belongs to the root supplied here. */
export function createWebSocketClient(root: BrainUiServices) {
  let disposed = false;
  let generation = 0;
  let owners = 0;
  let removeListeners: (() => void) | undefined;
  /**
   * The current connection's hello is known (received, or absent because the
   * host predates it), so the answer queue can tell what this host supports.
   */
  let answersReady = false;

  const makeAnswers = () => createAnswerDelivery({
    chat: root.stores.chat,
    storage: root.answerStorage,
    tabs: root.answerTabs,
    transport: {
      send: (message) => sendClientMessage(message),
      ready: () => answersReady && root.stores.connection.getState().wsStatus === "connected",
      supportsReceipts: () => wsClient?.supportsAskReceipts ?? false,
      principalKey: () => wsClient?.principalKey ?? null,
      checkLiveness: () => wsClient?.checkLiveness(),
    },
    onCorruptRecord: () =>
      root.stores.connection
        .getState()
        .reportError("ANSWER_QUEUE_CORRUPT", "A saved answer on this device could not be read and was discarded."),
  });
  let answers = makeAnswers();
  void answers.start();

  /** Work left running, tracked until seen (D52 §4, #948). Reads only. */
  let trackers = createTrackerClient(root);

  /** Every session's own composer draft, kept on the host when it can (D52 §5, #951). */
  let drafts = createDraftClient(root, { send: (message) => sendClientMessage(message) });

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
  function isOurDraftAnnouncement(
    state: ChatState,
    msg: ServerMessage
  ): boolean {
    // A terminal result has no draft correlation. Another client's turn may
    // finish before our session_info arrives, so it can never claim our draft.
    if (msg.type !== "session_info") return false;
    const pending = state.pendingDraftId;
    if (msg.draftId) return msg.draftId === pending;
    // No echo to compare against.
    return true;
  }

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
    wsClient?.send({ type: "activity_subscribe", view: "session", sessionId });
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
    client.send({ type: "inbox_subscribe", view });
  }

  /**
   * Text and thinking deltas waiting to be applied, per buffer.
   *
   * A model streams tokens far faster than the display refreshes, and each socket
   * frame arrives in its own macrotask, so React cannot batch them: one token was
   * one store write, one render and one markdown re-parse of the growing message.
   * Coalescing a frame's worth of tokens into a single write costs nothing
   * visually — the screen could not have shown the intermediate states anyway.
   *
   * Consecutive same-kind chunks merge, so a burst of text becomes ONE appendText
   * rather than one per token. Kind changes start a new chunk, which is what keeps
   * interleaved thinking and text in their true chronological order.
   */
  type PendingDelta = { kind: "text" | "thinking"; text: string };
  const pendingDeltas = new Map<ChatKey, PendingDelta[]>();
  let flushScheduled = false;
  let frameId: number | undefined;

  /**
   * Apply every buffered delta, in arrival order, and clear the buffer.
   *
   * Exported so tests can force the frame rather than wait for one; production
   * code never needs to call it, because every path that reads the transcript
   * flushes first.
   */
  function flushChatDeltas(): void {
    flushDeltas();
  }

  function flushDeltas(): void {
    if (frameId !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameId);
    frameId = undefined;
    flushScheduled = false;
    if (pendingDeltas.size === 0) return;
    const batches = [...pendingDeltas.entries()];
    pendingDeltas.clear();
    const state = root.stores.chat.getState();
    for (const [key, chunks] of batches) {
      for (const chunk of chunks) {
        if (chunk.kind === "text") state.appendText(key, chunk.text);
        else state.appendThinking(key, chunk.text);
      }
    }
  }

  function enqueueDelta(key: ChatKey, kind: PendingDelta["kind"], text: string): void {
    const chunks = pendingDeltas.get(key);
    if (!chunks) {
      pendingDeltas.set(key, [{ kind, text }]);
    } else {
      const last = chunks[chunks.length - 1];
      if (last.kind === kind) last.text += text;
      else chunks.push({ kind, text });
    }
    // Outside a browser (unit tests, SSR) there is no frame to wait for, so apply
    // straight away and keep the handler's behaviour synchronous.
    if (typeof requestAnimationFrame !== "function") {
      flushDeltas();
      return;
    }
    if (!flushScheduled) {
      flushScheduled = true;
      frameId = requestAnimationFrame(flushDeltas);
    }
  }

  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function retryTurn(failedTurnId: string): "sent" | "pending" | "refused" {
    const chat = root.stores.chat.getState();
    const sessionId = chat.activeSessionId;
    if (!sessionId) return "refused";
    const pending = chat.turnRetries[sessionId];
    if (pending?.failedTurnId === failedTurnId && pending.state !== "refused") return "pending";
    const buffer = chat.buffers[sessionId];
    const last = buffer?.messages.at(-1);
    if (last?.failure?.resetsAt !== undefined && last.failure.resetsAt > Date.now()) return "refused";
    if (buffer?.isStreaming || chat.runStates[sessionId] === "streaming" || last?.retryOfTurnId !== failedTurnId || !last.failure) return "refused";
    const retry = { requestId: crypto.randomUUID(), failedTurnId, state: "waiting" as const };
    chat.setTurnRetry(sessionId, retry);
    if (!sendClientMessage({ type: "retry_turn", sessionId, failedTurnId, requestId: retry.requestId })) {
      chat.setTurnRetry(sessionId, { ...retry, state: "refused", message: "Couldn't send. Check the connection and try again." });
      return "refused";
    }
    retryTimers.set(sessionId, setTimeout(() => {
      const state = root.stores.chat.getState();
      const current = state.turnRetries[sessionId];
      if (current?.requestId === retry.requestId && current.state === "waiting") state.setTurnRetry(sessionId, { ...current, state: "unknown" });
      retryTimers.delete(sessionId);
    }, 5000));
    return "sent";
  }

  function checkRetryDelivery(sessionId: string): boolean {
    const pending = root.stores.chat.getState().turnRetries[sessionId];
    return Boolean(pending && sendClientMessage({ type: "retry_status", sessionId, requestId: pending.requestId }));
  }

  function handleRetryReceipt(msg: Extract<ServerMessage, { type: "retry_receipt" }>): void {
    const sessionId = msg.sessionId;
    if (!sessionId) return;
    const chat = root.stores.chat.getState();
    const pending = chat.turnRetries[sessionId];
    if (!pending || pending.requestId !== msg.requestId) return;
    clearTimeout(retryTimers.get(sessionId)); retryTimers.delete(sessionId);
    if (msg.state === "unknown") { chat.setTurnRetry(sessionId, { ...pending, state: "unknown" }); return; }
    if (msg.state === "refused") { chat.setTurnRetry(sessionId, { ...pending, state: "refused", message: msg.message ?? "The server refused this retry." }); return; }
    chat.setTurnRetry(sessionId, null);
    const buffer = chat.buffers[sessionId];
    if (msg.text !== undefined && pending.state === "waiting" && buffer?.messages.at(-1)?.retryOfTurnId === pending.failedTurnId) {
      chat.addUserMessage(sessionId, msg.text, msg.source, undefined, { requestId: msg.requestId, thinkingLevel: msg.thinkingLevel }, msg.files);
      if (msg.attachmentCount) {
        const current = root.stores.chat.getState().buffers[sessionId];
        const messages = [...current.messages];
        messages[messages.length - 1] = { ...messages.at(-1)!, attachmentCount: msg.attachmentCount };
        root.stores.chat.setState({ buffers: { ...root.stores.chat.getState().buffers, [sessionId]: { ...current, messages } } });
      }
      chat.startAssistantMessage(sessionId, undefined, msg.requestId);
    } else {
      // A receipt recovered after a lost acknowledgement heals from history;
      // it never sends the original request a second time.
      sendClientMessage({ type: "session_resume", sessionId });
    }
  }

  /**
   * A follow-up the agent has just received enters the transcript once, as
   * the user message of its turn, where it entered the conversation (#1002).
   * A session this client holds no buffer for heals from history when opened;
   * a message already drawn (by a history replay) is not drawn again.
   */
  function placeStartedFollowUp(started: StartedFollowUp): void {
    const chat = root.stores.chat.getState();
    const buffer = chat.buffers[started.sessionId];
    if (!buffer) return;
    if (started.requestId && buffer.messages.some((message) => message.role === "user" && message.requestId === started.requestId)) return;
    if (buffer.isStreaming) chat.finishAssistantMessage(started.sessionId);
    chat.addUserMessage(
      started.sessionId,
      started.text,
      started.source,
      started.attachments,
      started.requestId ? { requestId: started.requestId, ...(started.thinkingLevel !== undefined ? { thinkingLevel: started.thinkingLevel } : {}) } : undefined,
      started.files
    );
    if (!started.attachments?.length && started.attachmentCount) {
      const current = root.stores.chat.getState().buffers[started.sessionId]!;
      const messages = [...current.messages];
      messages[messages.length - 1] = { ...messages.at(-1)!, attachmentCount: started.attachmentCount };
      root.stores.chat.setState({ buffers: { ...root.stores.chat.getState().buffers, [started.sessionId]: { ...current, messages } } });
    }
    chat.startAssistantMessage(started.sessionId, started.turnId, started.requestId);
    // Another client's message: the report counts its files but cannot carry
    // what they are, and may carry only the head of a long text. History has
    // both, so this session's is read again once this turn ends.
    if ((started.fileCount && !started.files?.length) || started.textTruncated) followUpRefresh.add(started.sessionId);
  }

  /**
   * A message this client drew in the chat as an ordinary send, but that the
   * host queued instead (#1002): it went out between a turn's `result` and
   * the host handing over its next queued turn, while the transcript had
   * stopped streaming. The host's report is the proof it is waiting, so it
   * leaves the transcript, with the empty reply opened for it, and becomes a
   * pending follow-up that enters the chat when its turn starts.
   */
  function adoptQueuedMessages(report: Extract<ServerMessage, { type: "session_queue" }>): void {
    const chat = root.stores.chat.getState();
    const buffer = chat.buffers[report.sessionId];
    const queued = new Set(report.followUps.map((entry) => entry.requestId).filter((id): id is string => Boolean(id)));
    if (!buffer || queued.size === 0) return;
    const drawn = buffer.messages.filter((m) => m.role === "user" && m.requestId && queued.has(m.requestId));
    if (drawn.length === 0) return;
    const opened = (m: (typeof buffer.messages)[number]) =>
      m.role === "assistant" && !m.turnId && !m.content && !m.thinking && m.toolCalls.length === 0 && Boolean(m.requestId && queued.has(m.requestId));
    const messages = buffer.messages.filter((m) => !drawn.includes(m) && !opened(m));
    root.stores.chat.setState({
      buffers: {
        ...chat.buffers,
        [report.sessionId]: { ...buffer, messages, isStreaming: buffer.isStreaming && messages.some((m) => m.role === "assistant" && m.isStreaming) },
      },
    });
    for (const m of drawn) {
      root.stores.followUp.getState().addLocal(report.sessionId, {
        requestId: m.requestId!,
        text: m.content,
        source: m.source ?? "typed",
        ...(m.attachments?.length ? { attachments: m.attachments } : {}),
        ...(m.files?.length ? { files: m.files } : {}),
        ...(m.thinkingLevel !== undefined ? { thinkingLevel: m.thinkingLevel } : {}),
        queuedAt: m.timestamp,
      });
    }
  }

  function handleServerMessage(msg: ServerMessage) {
    if (disposed || root.authLock.state.getState().phase !== "active") return;
    handleFrame(msg);
    // After the demux, so a draft that just became this session is already
    // the session in view and is not mistaken for unwatched work.
    if (msg.type === "server_hello") { trackers.hello(msg); drafts.hello(msg); }
    else trackers.frame(msg);
    // The first frame of a connection settles what its host supports: a hello,
    // or anything else from a host too old to send one. Only then can queued
    // answers be revalidated and replayed.
    if (!answersReady && wsClient && wsClient.hello !== "pending") {
      // A host too old to send a hello has no recovery to offer.
      if (wsClient.hello === "absent") {
        root.stores.trackers.getState().setRecoverySupported(false);
        // Nor any drafts: the line says so rather than `not saved yet` forever.
        root.stores.drafts.getState().setSupport(false);
      }
      answersReady = true;
      answers.connected();
    }
  }

  function handleFrame(msg: ServerMessage) {
    // Every frame that is not itself a delta must see the transcript fully
    // applied: the demux below reads buffer state, and the store records parts in
    // arrival order, so a tool call landing ahead of buffered text would reorder
    // the message.
    if (msg.type !== "text_delta" && msg.type !== "thinking_delta") flushDeltas();

    if (msg.type === "retry_receipt") { handleRetryReceipt(msg); return; }
    if (msg.type === "ask_answer_receipt") { answers.receipt(msg); return; }
    if (msg.type === "session_queue") {
      // Requests the host holds were accepted, a held send among them (#951).
      drafts.queued(msg);
      adoptQueuedMessages(msg);
      const started = root.stores.followUp.getState().applyReport(msg);
      if (started) placeStartedFollowUp(started);
      // The queue emptied with no turn running, as when its last entry is
      // dropped: a history refresh deferred until now has no turn end to wait for.
      else if (msg.followUps.length === 0 && !root.stores.chat.getState().buffers[msg.sessionId]?.isStreaming) refreshFollowUpHistory(msg.sessionId);
      return;
    }
    const state = root.stores.chat.getState();
    if ((msg.type === "session_info" || (msg.type === "status" && msg.status === "queued")) && msg.requestId) {
      state.setChatReceipt(msg.requestId, "accepted", msg.sessionId);
      // Before the demux below: a new conversation's draft must already be
      // its session's when the view follows the session there.
      if (drafts.receipt(msg.requestId, "accepted", msg.sessionId)) state.clearChatReceipt(msg.requestId);
      // A follow-up sent as the session went idle runs at once, never queued:
      // its turn is starting now, so it is the agent's (#1002).
      if (msg.type === "session_info") {
        const started = root.stores.followUp.getState().takeLocal(msg.requestId);
        const turnId = (msg as { turnId?: string }).turnId;
        if (started) placeStartedFollowUp({ ...started, sessionId: msg.sessionId, ...(turnId ? { turnId } : {}) });
      }
    } else if (msg.type === "error" && !msg.requestId) {
      drafts.error(msg);
    }
    if (msg.type === "error" && msg.requestId) {
      state.setChatReceipt(msg.requestId, "refused", msg.sessionId);
      // A turn-scoped error in a session means the request ran there: it was
      // accepted, then failed. One with no session left nothing to return to,
      // so its words come back to the draft, as a refusal's do.
      if (drafts.receipt(msg.requestId, msg.turnId && msg.sessionId ? "accepted" : "refused", msg.sessionId)) state.clearChatReceipt(msg.requestId);
      root.stores.handoff.getState().noteRefusal(msg.requestId, msg.message);
      // A refused follow-up was never pending; the composer keeps its draft.
      // A turn-scoped error is not a refusal: the follow-up's turn started
      // and failed before it named itself, so the message is the agent's and
      // belongs above that failure.
      const ran = msg.turnId && msg.sessionId ? root.stores.followUp.getState().takeLocal(msg.requestId) : null;
      if (ran) placeStartedFollowUp({ ...ran, sessionId: msg.sessionId!, turnId: msg.turnId! });
      else root.stores.followUp.getState().dropLocal(msg.requestId);
    }

    // Activity stream frames feed their own store and never touch chat state.
    // So do local exchange results (#582): one names its message by exchange
    // id, wherever that message is, and it says nothing about run state.
    if (
      msg.type === "server_hello" ||
      msg.type === "activity_snapshot" ||
      msg.type === "activity_delta" ||
      msg.type === "inbox_snapshot" ||
      msg.type === "inbox_delta" ||
      msg.type === "local_exchange_result" ||
      // Handoff answers (#61) name the review that asked, not a transcript.
      msg.type === "handoff_draft" ||
      msg.type === "handoff_receipt"
    ) {
      const key = state.activeSessionId;
      dispatchServerMessage(msg, {
        stores: root.stores,
        state,
        frameSessionId: undefined,
        frameTurnId: undefined,
        key,
        buffer: () => (key === null ? state.draft : state.buffers[key]),
        enqueueDelta,
        ensureActivitySubscription,
        subscribeInbox,
        requestBrowserLocation,
        resyncIfNeeded,
        coldResumeIfNeeded,
        markHistoryReplaced,
      });
      return;
    }

    // Parallel-session demux (per-session buffers). Every frame is scoped by
    // sessionId; a scoped frame lands in ITS session's buffer, so a background
    // session's transcript keeps accumulating while another one is in view.
    // Frames without a sessionId (legacy single-session servers, or a new
    // session's pre-binding frames) apply to the buffer in view.
    const frameSessionId = (msg as { sessionId?: string }).sessionId;
    // A resume the host could not serve answers with an error and no status:
    // nothing will say whether the turn still runs (#1013).
    const failedReattach = msg.type === "error" && msg.code === "SESSION_LOAD_ERROR" && !msg.requestId
      && reattachSessionId !== null && frameSessionId === reattachSessionId;
    if (failedReattach) reattachSessionId = null;
    if (msg.type === "status" && reattachSessionId !== null) {
      // The host's own answer for the session being reattached settles it.
      if (frameSessionId === reattachSessionId) {
        reattachSessionId = null;
        // Running, but another turn than the answer kept live (it ended
        // while the page was away and a queued follow-up started): that
        // answer is finished, and the new turn's text starts its own.
        const live = state.buffers[frameSessionId]?.messages.at(-1);
        const turnId = (msg as { turnId?: string }).turnId;
        if (msg.status !== "idle" && msg.status !== "cancelled" && turnId && live?.isStreaming && reattachTurnId && reattachTurnId !== turnId) {
          state.finishAssistantMessage(frameSessionId);
        }
      }
      // The host greets every connection with an unscoped idle, also while
      // this session's turn is still running beside others. That greeting is
      // not about the session in view; the reattach's answer is (#1013).
      else if (!frameSessionId && state.activeSessionId === reattachSessionId) return;
    }
    if (frameSessionId) {
      // `detail` on a queued status is the host's queue-pressure note; it rides
      // along so the session's badge can show WHY it is queued deep.
      const queueNote =
        msg.type === "status" && msg.status === "queued" ? msg.detail : undefined;
      // `message_blocks` arrives AFTER the turn's result (D42); it must not
      // reopen a finished session, and it must not touch a queued follow-up
      // that may already be running, so it takes no part in run state.
      if (msg.type !== "message_blocks" && !(msg.type === "error" && msg.requestId && !msg.turnId)) {
        state.setRunState(frameSessionId, runStateForFrame(msg), queueNote);
      }
    }

    // Resolve the target buffer key for this frame.
    let key: ChatKey;
    if (!frameSessionId) {
      key = state.activeSessionId; // null = the draft view
    } else if (state.buffers[frameSessionId]) {
      key = frameSessionId;
    } else if (msg.type === "session_info" && msg.draftId && root.stores.handoff.getState().pendingSend?.draftId === msg.draftId) {
      // A handoff destination (#61) just got its identity. It has no draft
      // buffer to adopt, so open one holding the reviewed text the host was
      // sent, and let the turn's frames stream into it like any session.
      const handoff = root.stores.handoff.getState();
      const sent = handoff.pendingSend!;
      state.setMessages(frameSessionId, []);
      state.addUserMessage(frameSessionId, sent.text, "handoff", undefined, { requestId: sent.requestId });
      state.startAssistantMessage(frameSessionId, undefined, sent.requestId);
      handoff.noteCreated(sent.handoffId, frameSessionId, true);
      key = frameSessionId;
    } else if (msg.type === "session_info" && msg.draftId && state.detachedDrafts[msg.draftId]) {
      // A new conversation the reader left before it was answered (#951):
      // its transcript becomes that session's, and the view stays put.
      state.bindDetachedDraft(msg.draftId, frameSessionId);
      key = frameSessionId;
    } else if (state.draft && isOurDraftAnnouncement(state, msg)) {
      // A draft run just got its server identity: adopt the draft buffer.
      state.bindDraftSession(frameSessionId);
      key = frameSessionId;
    } else if (msg.type === "session_info" && frameSessionId === state.activeSessionId) {
      // The ACTIVE session announced itself but has no buffer yet — the cold
      // reattach case (PWA relaunch mid-turn; the server may skip the history
      // frame when a first turn has no history yet). Materialize the buffer so
      // this session_info and every following delta land instead of vanishing.
      state.setActiveSession(frameSessionId);
      key = frameSessionId;
    } else if (msg.type === "session_history") {
      // History replay may create a buffer (cold resume / reattach).
      key = frameSessionId;
    } else {
      // Scoped frame for a session with no buffer (never opened, or evicted):
      // the badge above is all we track. The transcript heals via
      // session_resume when the user opens it.
      return;
    }

    const buffer = () => {
      const s = root.stores.chat.getState();
      return key === null ? s.draft : s.buffers[key];
    };
    if ((msg.type === "session_info" || msg.type === "status") && msg.requestId && msg.thinkingLevel !== undefined) {
      root.stores.chat.getState().setMessageEffort(key, msg.requestId, msg.thinkingLevel, msg.effectiveThinkingLevel);
    }

    dispatchServerMessage(msg, {
      stores: root.stores,
      state,
      frameSessionId,
      frameTurnId: (msg as { turnId?: string }).turnId,
      key,
      buffer,
      enqueueDelta,
      ensureActivitySubscription,
      subscribeInbox,
      requestBrowserLocation,
      resyncIfNeeded,
      coldResumeIfNeeded,
      markHistoryReplaced,
    });
    // After the error has been drawn as it would be anyway: a stream still
    // open has no answer coming, so it ends here rather than never.
    if (failedReattach && root.stores.chat.getState().buffers[frameSessionId!]?.isStreaming) {
      root.stores.chat.getState().finishAssistantMessage(frameSessionId!);
    }
  }

  /**
   * The server asked the browser for its location (the agent called
   * `get_current_location`). Read `navigator.geolocation` and reply over the same
   * requestId. The browser shows its own permission prompt on first use; a denial,
   * timeout, or unavailable position comes back as a `location_error` that the
   * server turns into a tool error for the agent.
   */
  function requestBrowserLocation(msg: ServerLocationRequest) {
    const client = wsClient;
    const requestedGeneration = generation;
    const requestedSocket = root.stores.connection.getState().socketOpens;
    const reply = (message: ClientMessage) => {
      if (!disposed && requestedGeneration === generation && requestedSocket === root.stores.connection.getState().socketOpens && client === wsClient) client?.send(message);
    };
    const { requestId } = msg;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reply({
        type: "location_error",
        requestId,
        code: 0,
        message: "Geolocation is not available in this browser.",
      });
      return;
    }
    const opts = msg.options ?? {};
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        reply({
          type: "location_response",
          requestId,
          coords: {
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            altitude: pos.coords.altitude,
            altitudeAccuracy: pos.coords.altitudeAccuracy,
            heading: pos.coords.heading,
            speed: pos.coords.speed,
          },
          timestamp: pos.timestamp,
        });
      },
      (err) => {
        reply({
          type: "location_error",
          requestId,
          code: err.code,
          message: err.message || "Failed to retrieve location.",
        });
      },
      {
        enableHighAccuracy: opts.enableHighAccuracy ?? false,
        timeout: opts.timeoutMs ?? 15000,
        maximumAge: opts.maximumAgeMs ?? 60000,
      }
    );
  }

  // Reconnection bookkeeping: after a WS drop, the rendered transcript may have
  // gaps (deltas streamed while offline are lost). We heal by replaying the
  // authoritative session history — immediately if nothing is streaming, or
  // once the in-flight turn settles (result / idle status). The pending resync
  // is keyed to the session that needs healing (the one that was active at the
  // reconnect), so a background session settling first cannot consume it.
  let wasDisconnected = false;
  let resyncSessionId: string | null = null;
  /** Sessions whose started follow-up needs history to be whole (#1002). */
  const followUpRefresh = new Set<string>();

  function handleSocketClose(close: WebSocketClose): void {
    const connection = root.stores.connection.getState();
    connection.recordWsClose(close.opened, close.code);
    // 1008 is the host closing a revoked or expired principal's sockets.
    if (close.opened && close.code === 1008) {
      trackers.revoked();
      void root.authLock.expire(close.reason);
    }
    if (
      !close.opened &&
      root.stores.connection.getState().handshakeFailures >= REFUSAL_ATTEMPTS
    ) {
      root.recheckVpn?.();
    }
  }

  /**
   * Read a session's history again for a started follow-up that arrived
   * incomplete (#1002), but only once nothing else is waiting in it: a replay
   * that lands after the next queued turn has started would replace its live
   * frames, so the last turn's end takes the refresh instead.
   */
  function refreshFollowUpHistory(sessionId: string | null): boolean {
    if (!sessionId || (root.stores.followUp.getState().pending[sessionId]?.length ?? 0) > 0) return false;
    if (!followUpRefresh.delete(sessionId)) return false;
    if (resyncSessionId === sessionId) resyncSessionId = null;
    wsClient?.send({ type: "session_resume", sessionId });
    return true;
  }

  function resyncIfNeeded(sessionId: string | null) {
    if (refreshFollowUpHistory(sessionId)) return;
    if (!resyncSessionId || !sessionId || sessionId !== resyncSessionId) return;
    resyncSessionId = null;
    wsClient?.send({ type: "session_resume", sessionId });
  }

  // A cold page / PWA relaunch restores only the stored session id, not the
  // transcript. The server pushes a snapshot on connect only while a session is
  // actively running; when it's idle (the common "agent finished while the phone
  // slept" case) nothing arrives, so the client must fetch the finished
  // session's history itself. Guarded to fire at most once per session id per
  // connection — an empty session would otherwise re-trigger on every idle
  // status and loop.
  let coldResumedSessionId: string | null = null;
  /** The running session in view that a reconnect reattached, until the host answers for it. */
  let reattachSessionId: string | null = null;
  /** The turn the reattached answer belonged to when the connection went, if the page knew it. */
  let reattachTurnId: string | undefined;

  function markHistoryReplaced(key: ChatKey): void {
    // A replay of a transcript that was streaming is not the whole answer
    // yet (a backend may keep it only once it ends, and a first chunk may
    // stop before it): the turn's end replays again.
    const replayed = key === null ? undefined : root.stores.chat.getState().buffers[key];
    if (key !== null && key === resyncSessionId && !replayed?.isStreaming && !replayed?.replay?.base.isStreaming) resyncSessionId = null;
    coldResumedSessionId = key;
  }

  function coldResumeIfNeeded(sessionId: string | null, messageCount: number) {
    if (!sessionId || messageCount > 0) return;
    if (coldResumedSessionId === sessionId) return;
    coldResumedSessionId = sessionId;
    wsClient?.send({ type: "session_resume", sessionId });
  }

  function handleStatusChange(status: "connecting" | "connected" | "disconnected") {
    root.stores.connection.getState().setWsStatus(status);
    if (status !== "connected" && answersReady) {
      answersReady = false;
      answers.disconnected();
    }

    if (status === "connected") {
      root.stores.connection.getState().noteSocketOpen();
      for (const sessionId of Object.keys(root.stores.chat.getState().turnRetries)) checkRetryDelivery(sessionId);
    }

    // A status change can be followed by a history replay that rewrites the
    // buffer, so land whatever is still buffered before anything reads it. In a
    // hidden tab requestAnimationFrame does not run at all, which is exactly the
    // case where deltas could otherwise sit unapplied across a reconnect.
    flushDeltas();

    if (status === "disconnected") {
      // Nothing sent can be confirmed until the next snapshot (#684).
      root.stores.inbox.getState().connectionLost();
      const chat = root.stores.chat.getState();
      for (const [sessionId, pending] of Object.entries(chat.turnRetries)) {
        if (pending.state === "waiting") chat.setTurnRetry(sessionId, { ...pending, state: "unknown" });
      }
      wasDisconnected = true;
      reattachSessionId = null;
      // Allow a fresh cold-resume attempt after we reconnect.
      coldResumedSessionId = null;
    } else if (status === "connected" && wasDisconnected) {
      wasDisconnected = false;
      const chat = root.stores.chat.getState();
      const active = activeChat(chat);
      if (chat.activeSessionId && active.messages.length > 0) {
        resyncSessionId = chat.activeSessionId;
        if (!active.isStreaming) {
          // Not mid-stream: replay right away.
          resyncIfNeeded(chat.activeSessionId);
        } else {
          // Mid-stream: reattach. Only the host knows whether the turn is
          // still running or ended while this page was away, and its answer
          // to a resume says which (a scoped `thinking` or `idle`) after a
          // history that keeps the messages already drawn (#1013). The
          // resync flag stays: the turn's end replays the finished answer.
          reattachSessionId = chat.activeSessionId;
          reattachTurnId = active.messages.at(-1)?.turnId;
          wsClient?.send({ type: "session_resume", sessionId: chat.activeSessionId });
        }
      }
    }
  }

  let wsClient: BrainUiClient | null = null;

  function sendClientMessage(msg: ClientMessage): boolean {
    if (root.authLock.state.getState().phase !== "active") return false;
    if (!wsClient) return false;
    if (root.stores.connection.getState().wsStatus !== "connected") return false;
    // A message that starts a conversation takes the draft's local exchanges
    // with it (#582), whichever surface sent it, so /stats run before the
    // first message becomes part of the session that message creates.
    if (msg.type === "chat_message" && !msg.sessionId) {
      const chat = root.stores.chat.getState();
      const exchanges = localExchangesForDraft(chat);
      if (exchanges.length > 0) {
        const sent = wsClient.send({ ...msg, localExchanges: exchanges });
        if (sent) for (const exchange of exchanges) chat.markLocalExchange(exchange.id, "pending");
        return sent;
      }
    }
    return wsClient.send(msg);
  }

  /** Retry this root's socket, skipping any remaining backoff. */
  function reconnectWebSocketNow(): void {
    wsClient?.reconnectNow();
  }


  /** Acquire a connection lease. Several consumers may share one root safely. */
  function connect(): () => void {
    if (disposed) throw new Error("Cannot connect a disposed UI root");
    owners++;
    if (!wsClient) {
      const connectedGeneration = ++generation;
      const current = () => !disposed && connectedGeneration === generation;
      root.stores.connection.getState().noteSocketOpen();
      const client = new BrainUiClient({
        url: root.wsUrl(),
        handlers: { onAny: (message) => { if (current() && root.authLock.state.getState().phase === "active") handleServerMessage(message); } },
        onStatusChange: (status) => { if (current()) handleStatusChange(status); },
        onClose: (close) => { if (current()) handleSocketClose(close); },
        onProtocolError: (err) => {
          if (!current()) return;
          root.stores.connection.getState().reportError(
            "PROTOCOL_ERROR",
            err.frameType ? `Dropped a ${err.frameType} frame: ${err.detail}` : `Dropped an unreadable frame: ${err.detail}`,
          );
        },
      });
      wsClient = client;
      client.connect();
      // Liveness B (#910): back in view, resumed, shown again or online means
      // check now. A socket that reads OPEN after the page was hidden or
      // frozen may be half-open; checkLiveness probes it, and reconnects one
      // that is plainly gone. Periodic probes run only in the foreground.
      const check = () => { if (current()) client.checkLiveness(); };
      const foreground = () => typeof document === "undefined" || document.visibilityState === "visible";
      const onVisibility = () => {
        if (!current()) return;
        client.setForeground(foreground());
        if (foreground()) client.checkLiveness();
      };
      const onFreeze = () => { if (current()) client.setForeground(false); };
      client.setForeground(foreground());
      if (typeof window !== "undefined") {
        window.addEventListener("online", check);
        window.addEventListener("pageshow", check);
      }
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibility);
        document.addEventListener("resume", onVisibility);
        document.addEventListener("freeze", onFreeze);
      }
      removeListeners = () => {
        if (typeof window !== "undefined") {
          window.removeEventListener("online", check);
          window.removeEventListener("pageshow", check);
        }
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", onVisibility);
          document.removeEventListener("resume", onVisibility);
          document.removeEventListener("freeze", onFreeze);
        }
      };
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--owners === 0) disconnect();
    };
  }

  function disconnect() {
    coldResumedSessionId = null;
    generation++;
    removeListeners?.();
    removeListeners = undefined;
    const client = wsClient;
    wsClient = null;
    client?.close();
    handleStatusChange("disconnected");
    root.stores.activity.getState().setSupported(false);
    root.stores.activity.getState().resetSubscriptions();
    root.stores.inbox.getState().setSupported(false);
  }

  const client = {
    connect,
    send: sendClientMessage,
    retryTurn,
    checkRetryDelivery,
    reconnectNow: reconnectWebSocketNow,
    /** Send again and Check again for a send the host never confirmed (D52 §5, #951). */
    drafts: {
      /** Send the held snapshot once more, under a new request id; false when it could not leave. */
      resend: (requestId: string) => drafts.resend(requestId),
      /** Ask the host whether it accepted the held send. Reads only. */
      check: (requestId: string) => drafts.check(requestId),
      /** Put the held send's text and images back into its own draft. */
      edit: (requestId: string) => drafts.edit(requestId),
    },
    handleServerMessage,
    answers,
    flushChatDeltas,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      disconnect();
      answers.dispose();
      trackers.dispose();
      drafts.dispose();
      resyncSessionId = null;
      coldResumedSessionId = null;
    },
  };
  authLifecycles.set(root.stores, {
    drop() {
      disconnect();
      answers.dispose(); trackers.dispose(); drafts.dispose();
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear(); followUpRefresh.clear(); resyncSessionId = null;
    },
    restore() {
      answers = makeAnswers(); client.answers = answers; void answers.start();
      trackers = createTrackerClient(root);
      drafts = createDraftClient(root, { send: (message) => sendClientMessage(message) });
      // An embedder can own a lease outside the protected gate. Remounting
      // ChatPage is then optional, so restore that surviving owner too.
      queueMicrotask(() => {
        if (!disposed && owners > 0 && !wsClient && root.authLock.state.getState().phase === "active") {
          const release = connect(); release();
        }
      });
    },
  });
  return client;
}
