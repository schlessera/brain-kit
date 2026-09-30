import { BrainUiClient, type WebSocketClose } from "@schlessera/brain-ui-sdk/client";
import type { ServerMessage, ClientMessage, ServerLocationRequest } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "./root.js";
import { activeChat, localExchangesForDraft, type ChatState, type ChatKey } from "./stores/chat-state.js";
import { dispatchServerMessage } from "./hooks/websocket-handlers/index.js";
import { runStateForFrame } from "./hooks/websocket-handlers/chat.js";
import { REFUSAL_ATTEMPTS } from "./components/connectivity/connection-state.js";

/** Every callback and mutable queue belongs to the root supplied here. */
export function createWebSocketClient(root: BrainUiServices) {
  let disposed = false;
  let generation = 0;
  let owners = 0;
  let removeListeners: (() => void) | undefined;

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
      chat.addUserMessage(sessionId, msg.text, msg.source, undefined, { requestId: msg.requestId, thinkingLevel: msg.thinkingLevel });
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

  function handleServerMessage(msg: ServerMessage) {
    if (disposed) return;
    // Every frame that is not itself a delta must see the transcript fully
    // applied: the demux below reads buffer state, and the store records parts in
    // arrival order, so a tool call landing ahead of buffered text would reorder
    // the message.
    if (msg.type !== "text_delta" && msg.type !== "thinking_delta") flushDeltas();

    if (msg.type === "retry_receipt") { handleRetryReceipt(msg); return; }
    const state = root.stores.chat.getState();
    if ((msg.type === "session_info" || (msg.type === "status" && msg.status === "queued")) && msg.requestId) {
      state.setChatReceipt(msg.requestId, "accepted", msg.sessionId);
    } else if (msg.type === "error" && msg.requestId) {
      state.setChatReceipt(msg.requestId, "refused", msg.sessionId);
    }

    // Activity stream frames feed their own store and never touch chat state.
    // So do local exchange results (#582): one names its message by exchange
    // id, wherever that message is, and it says nothing about run state.
    if (
      msg.type === "server_hello" ||
      msg.type === "activity_snapshot" ||
      msg.type === "activity_delta" ||
      msg.type === "local_exchange_result"
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
      requestBrowserLocation,
      resyncIfNeeded,
      coldResumeIfNeeded,
      markHistoryReplaced,
    });
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

  function handleSocketClose(close: WebSocketClose): void {
    const connection = root.stores.connection.getState();
    connection.recordWsClose(close.opened, close.code);
    if (
      !close.opened &&
      root.stores.connection.getState().handshakeFailures >= REFUSAL_ATTEMPTS
    ) {
      root.recheckVpn?.();
    }
  }

  function resyncIfNeeded(sessionId: string | null) {
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

  function markHistoryReplaced(key: ChatKey): void {
    if (key !== null && key === resyncSessionId) resyncSessionId = null;
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
      const chat = root.stores.chat.getState();
      for (const [sessionId, pending] of Object.entries(chat.turnRetries)) {
        if (pending.state === "waiting") chat.setTurnRetry(sessionId, { ...pending, state: "unknown" });
      }
      wasDisconnected = true;
      // Allow a fresh cold-resume attempt after we reconnect.
      coldResumedSessionId = null;
    } else if (status === "connected" && wasDisconnected) {
      wasDisconnected = false;
      const chat = root.stores.chat.getState();
      const active = activeChat(chat);
      if (chat.activeSessionId && active.messages.length > 0) {
        resyncSessionId = chat.activeSessionId;
        // Not mid-stream: replay right away. Mid-stream: the flag holds until
        // the running turn finishes (result or idle status).
        if (!active.isStreaming) {
          resyncIfNeeded(chat.activeSessionId);
        }
      }
    }
  }

  let wsClient: BrainUiClient | null = null;

  function sendClientMessage(msg: ClientMessage): boolean {
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
        handlers: { onAny: (message) => { if (current()) handleServerMessage(message); } },
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
      const reconnectNow = () => { if (current()) client.reconnectNow(); };
      const onVisible = () => { if (document.visibilityState === "visible") reconnectNow(); };
      if (typeof window !== "undefined") window.addEventListener("online", reconnectNow);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
      removeListeners = () => {
        if (typeof window !== "undefined") window.removeEventListener("online", reconnectNow);
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
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
    generation++;
    removeListeners?.();
    removeListeners = undefined;
    const client = wsClient;
    wsClient = null;
    client?.close();
    handleStatusChange("disconnected");
    root.stores.activity.getState().setSupported(false);
    root.stores.activity.getState().resetSubscriptions();
  }

  return {
    connect,
    send: sendClientMessage,
    retryTurn,
    checkRetryDelivery,
    reconnectNow: reconnectWebSocketNow,
    handleServerMessage,
    flushChatDeltas,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
      disconnect();
      resyncSessionId = null;
      coldResumedSessionId = null;
    },
  };
}
