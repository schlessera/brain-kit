import { attachTranscriptTimeline } from "./lib/transcript-timeline.js";
import { createConversationClient } from "./voice/conversation-client.js";
import { takeComposerTextAsAnswer } from "./lib/ask-user-typed.js";
import type { ConnectionStatus } from "@schlessera/brain-ui-sdk/client";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "./root.js";
import { createAccountServices, handleSocketClose, registerAuthLifecycle } from "./ws-client/account.js";
import { createDeltaBuffer } from "./ws-client/delta-buffer.js";
import { createFollowUpPlacement } from "./ws-client/follow-ups.js";
import { createInbound } from "./ws-client/inbound.js";
import { answerLocationRequest } from "./ws-client/location.js";
import { createOutbound } from "./ws-client/outbound.js";
import { createReconnectHealing } from "./ws-client/reconnect.js";
import { createRestorationDriver } from "./ws-client/restoration.js";
import { createSocketLease } from "./ws-client/socket-lease.js";
import { createTurnRetries } from "./ws-client/turn-retry.js";

export { dropConnectionContext, restoreConnectionContext } from "./ws-client/account.js";
export { RESTORE_DEADLINE_MS } from "./ws-client/restoration.js";

/**
 * Every callback and mutable queue belongs to the root supplied here.
 *
 * This composes the connection's parts (`./ws-client/`): one shared socket
 * lease, the account-scoped clients beside it, the gated outbound path, the
 * inbound routing into the typed handler map, and what a page does when its
 * socket drops and opens again.
 */
export function createWebSocketClient(root: BrainUiServices) {
  let disposed = false;
  const isActive = () => root.authLock.state.getState().phase === "active";

  const lease = createSocketLease({
    url: () => root.wsUrl(),
    disposed: () => disposed,
    active: isActive,
    noteSocketOpen: () => root.stores.connection.getState().noteSocketOpen(),
    onMessage: (message) => inbound.handleServerMessage(message),
    onStatusChange: (status) => handleStatusChange(status),
    onClose: (close) => handleSocketClose(root, close, services.trackers),
    onProtocolError: (err) => {
      root.stores.connection.getState().reportError(
        "PROTOCOL_ERROR",
        err.frameType ? `Dropped a ${err.frameType} frame: ${err.detail}` : `Dropped an unreadable frame: ${err.detail}`,
      );
    },
  });

  /** The one gated path every client frame takes. */
  function send(message: ClientMessage): boolean {
    return outbound(message);
  }

  const restoration = createRestorationDriver(root, { send, disposed: () => disposed });
  const outbound = createOutbound(root, {
    socket: lease.client,
    historyOwnerFor: (sessionId) => conversation.historyOwnerFor(sessionId),
    loadDialogue: (sessionId) => conversation.loadDialogue(sessionId),
    restoration,
  });
  const services = createAccountServices(root, { send, socket: lease.client });
  const conversation = createConversationClient(root, send, (sessionId, text) =>
    takeComposerTextAsAnswer(root.stores.chat.getState(), sessionId, text, (answer) => {
      void services.answers.submit(answer).then((result) => {
        if (result === "refused") {
          const drafts = root.stores.drafts.getState();
          const id = drafts.idFor(sessionId);
          const previous = drafts.drafts[id]?.text ?? "";
          drafts.edit(id, sessionId, { text: [previous, text].filter(Boolean).join("\n\n") });
        }
      });
    }));
  const timeline = attachTranscriptTimeline(root.stores.chat, conversation.state);

  const deltas = createDeltaBuffer(root.stores.chat);
  const healing = createReconnectHealing(root, send);
  const retries = createTurnRetries(root.stores.chat, send);
  const followUps = createFollowUpPlacement(root, { drafts: () => services.drafts, healing });
  const inbound = createInbound(root, {
    disposed: () => disposed,
    conversation,
    deltas,
    healing,
    restoration,
    retries,
    followUps,
    services,
    // Read at call time: inbox subscriptions and resume revalidation take the
    // client's public `send`, the one a card's decision frame takes.
    send: (message) => client.send(message),
    socketSend: (message) => { lease.client()?.send(message); },
    requestBrowserLocation: (msg) => {
      const opened = root.stores.connection.getState().socketOpens;
      answerLocationRequest(msg, lease.pinned(() => opened === root.stores.connection.getState().socketOpens));
    },
  });

  function handleStatusChange(status: ConnectionStatus): void {
    root.stores.connection.getState().setWsStatus(status);
    if (status !== "connected") services.socketDown();
    if (status === "connected") {
      inbound.resetTurns();
      root.stores.connection.getState().noteSocketOpen();
      retries.connected();
    }
    // A status change can be followed by a history replay that rewrites the
    // buffer, so land whatever is still buffered before anything reads it. In a
    // hidden tab requestAnimationFrame does not run at all, which is exactly the
    // case where deltas could otherwise sit unapplied across a reconnect.
    deltas.flush();
    if (status === "disconnected") {
      // Nothing sent can be confirmed until the next snapshot (#684).
      root.stores.inbox.getState().connectionLost();
      retries.disconnected();
      healing.disconnected();
    } else if (status === "connected") {
      healing.connected();
    }
  }

  /** Acquire a connection lease. Several consumers may share one root safely. */
  function connect(): () => void {
    return lease.acquire(disconnect);
  }

  function disconnect(): void {
    restoration.socketClosed();
    lease.close();
    handleStatusChange("disconnected");
    root.stores.activity.getState().setSupported(false);
    root.stores.activity.getState().resetSubscriptions();
    root.stores.inbox.getState().setSupported(false);
  }

  const client = {
    /** @internal Concrete live voice controller; the ordinary chat path stays independent. */
    conversation,
    connect,
    send,
    retryTurn: retries.retryTurn,
    checkRetryDelivery: retries.checkDelivery,
    /** Retry this root's socket, skipping any remaining backoff. */
    reconnectNow: (): void => { lease.client()?.reconnectNow(); },
    /** Send again and Check again for a send the host never confirmed (D52 §5, #951). */
    drafts: {
      /** Send the held snapshot once more, under a new request id; false when it could not leave. */
      resend: (requestId: string) => services.drafts.resend(requestId),
      /** Ask the host whether it accepted the held send. Reads only. */
      check: (requestId: string) => services.drafts.check(requestId),
      /** Put the held send's text and images back into its own draft. */
      edit: (requestId: string) => services.drafts.edit(requestId),
      /** Send again for an outgoing snapshot's send (#3155): a new request replaces it. */
      resendSnapshot: (requestId: string) => services.drafts.resendSnapshot(requestId),
      /** Send a held snapshot restored after reload (#3155), only on this explicit call. */
      sendPaused: (draftId: string, snapshotId: string) => services.drafts.sendPaused(draftId, snapshotId),
    },
    handleServerMessage: inbound.handleServerMessage,
    answers: services.answers,
    /**
     * Apply every buffered delta now. Production never needs to: every path
     * that reads the transcript flushes first. Tests force the frame with it.
     */
    flushChatDeltas: deltas.flush,
    dispose() {
      inbound.resetTurns();
      if (disposed) return;
      disposed = true;
      timeline.dispose();
      conversation.dispose();
      retries.clearTimers();
      disconnect();
      services.dispose();
      healing.dispose();
      restoration.dispose();
      stopRestoration();
    },
  };
  const stopRestoration = restoration.start();
  registerAuthLifecycle(root, {
    drop() {
      disconnect();
      services.dispose();
      retries.clearTimers();
      healing.drop();
    },
    restore() {
      services.restore();
      client.answers = services.answers;
      // An embedder can own a lease outside the protected gate. Remounting
      // ChatPage is then optional, so restore that surviving owner too.
      queueMicrotask(() => {
        if (!disposed && lease.owners() > 0 && !lease.client() && isActive()) {
          const release = connect(); release();
        }
      });
    },
  });
  return client;
}
