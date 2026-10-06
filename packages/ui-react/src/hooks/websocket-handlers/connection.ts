import type { ServerMessageHandlerMap } from "./types.js";

type ConnectionFrame =
  | "server_hello" | "location_request" | "error" | "inbox_snapshot" | "inbox_delta"
  | "tool_resolution" | "conversation_opened" | "conversation_closed"
  | "conversation_event" | "conversation_work" | "conversation_output" | "conversation_permission";

export const connectionFrameHandlers = {
  server_hello: (msg, context) => {
    context.stores.connection.getState().setChatRequestAck(msg.capabilities?.chatRequestAck === true);
    context.stores.activity.getState().setSupported(msg.capabilities?.activity === true);
    // A new hello means a new connection: server-side subscriptions are gone.
    context.stores.activity.getState().resetSubscriptions();
    // …and view-owned subscriptions (the Activity index) must re-send too.
    context.stores.activity.getState().bumpConnectionEpoch();
    context.ensureActivitySubscription(context.state.activeSessionId);
    // Durable Queue/Actions (#684): opt in only when advertised. Both views
    // are connection-wide, because the badge counts decisions everywhere.
    const inbox = msg.capabilities?.inbox === true;
    context.stores.inbox.getState().setSupported(inbox);
    if (inbox) {
      context.subscribeInbox("actions");
      context.subscribeInbox("queue");
    }
  },
  inbox_snapshot: (msg, context) => {
    context.stores.inbox.getState().applySnapshot(msg);
  },
  inbox_delta: (msg, context) => {
    context.stores.inbox.getState().applyDelta(msg);
  },
  // Live conversation (#957) is negotiated: a host sends these only to a
  // connection that started a conversation or declared toolResolution, and
  // this client does neither yet (capture/playback is #960).
  tool_resolution: () => {},
  conversation_opened: () => {},
  conversation_closed: () => {},
  conversation_event: () => {},
  conversation_work: () => {},
  conversation_output: () => {},
  conversation_permission: () => {},
  location_request: (msg, context) => {
    context.requestBrowserLocation(msg);
  },
  error: (msg, context) => {
    // ALWAYS recorded. Appending to the transcript only works while a
    // message is streaming, and this used to be the whole handler — so an
    // error arriving between turns (a rejected frame, a failed resume) was
    // dropped as silently on the client as it was on the server.
    context.stores.connection.getState().reportError(msg.code, msg.message);
    // A refused durable decision names no item, so every decision in flight
    // unlocks and a fresh snapshot tells each card its outcome (ruling R2).
    // It is never a chat failure: a turn streaming meanwhile is unaffected.
    if (msg.code === "INBOX_DECISION_REFUSED" || msg.code === "INBOX_UNAVAILABLE") {
      const unavailable = msg.code === "INBOX_UNAVAILABLE";
      if (context.stores.inbox.getState().decisionRefused(unavailable)) context.subscribeInbox("actions");
      return;
    }
    if (msg.code.startsWith("INBOX_")) return;
    // The socket's frame budget refuses by frame, not by item: a decision in
    // flight may be the one refused. Ask for a snapshot once the budget has
    // had a moment to refill, rather than leave the card recording forever.
    if (msg.code === "RATE_LIMITED" && context.stores.inbox.getState().decisionRefused()) {
      setTimeout(() => context.subscribeInbox("actions"), 1000);
    }
    // These socket-boundary refusals reject a frame, not the running turn.
    // Keep the connection/recovery signal without inventing a failed reply.
    if (
      !context.frameTurnId && !msg.failure &&
      (msg.code === "RATE_LIMITED" || msg.code === "PARSE_ERROR")
    ) return;
    // The turn's failure, drawn on its message (#575). A bare `error` that
    // ends a turn before its session exists carries the provider failure;
    // any other is shown as its message says.
    // A refused next-message request must not fail the reply already running.
    if (msg.requestId && !context.frameTurnId) {
      const pending = context.buffer()?.messages.find((message) =>
        message.role === "assistant" && message.requestId === msg.requestId && !message.turnId && message.isStreaming
      );
      if (!pending) return;
    }
    if (context.buffer()?.isStreaming || msg.failure) {
      context.state.failAssistantMessage(
        context.key,
        msg.failure ?? { errorClass: "unknown", message: msg.message },
        context.frameTurnId,
        msg.failure !== undefined
      );
    }
  },
} satisfies ServerMessageHandlerMap<ConnectionFrame>;
