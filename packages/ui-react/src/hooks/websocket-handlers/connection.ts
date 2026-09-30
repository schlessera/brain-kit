import type { ServerMessageHandlerMap } from "./types.js";

type ConnectionFrame = "server_hello" | "location_request" | "error";

export const connectionFrameHandlers = {
  server_hello: (msg, context) => {
    context.stores.connection.getState().setChatRequestAck(msg.capabilities?.chatRequestAck === true);
    context.stores.activity.getState().setSupported(msg.capabilities?.activity === true);
    // A new hello means a new connection: server-side subscriptions are gone.
    context.stores.activity.getState().resetSubscriptions();
    // …and view-owned subscriptions (the Activity index) must re-send too.
    context.stores.activity.getState().bumpConnectionEpoch();
    context.ensureActivitySubscription(context.state.activeSessionId);
  },
  location_request: (msg, context) => {
    context.requestBrowserLocation(msg);
  },
  error: (msg, context) => {
    // ALWAYS recorded. Appending to the transcript only works while a
    // message is streaming, and this used to be the whole handler — so an
    // error arriving between turns (a rejected frame, a failed resume) was
    // dropped as silently on the client as it was on the server.
    context.stores.connection.getState().reportError(msg.code, msg.message);
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
