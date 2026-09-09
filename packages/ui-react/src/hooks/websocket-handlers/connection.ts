import { useActivityStore } from "../../stores/activity-store.js";
import { useConnectionStore } from "../../stores/connection-store.js";
import type { ServerMessageHandlerMap } from "./types.js";

type ConnectionFrame = "server_hello" | "location_request" | "error";

export const connectionFrameHandlers = {
  server_hello: (msg, context) => {
    useActivityStore.getState().setSupported(msg.capabilities?.activity === true);
    // A new hello means a new connection: server-side subscriptions are gone.
    useActivityStore.getState().resetSubscriptions();
    // …and view-owned subscriptions (the Activity index) must re-send too.
    useActivityStore.getState().bumpConnectionEpoch();
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
    useConnectionStore.getState().reportError(msg.code, msg.message);
    if (context.buffer()?.isStreaming) {
      context.state.appendText(context.key, `\n\n**Error:** ${msg.message}`);
      context.state.finishAssistantMessage(context.key);
    }
  },
} satisfies ServerMessageHandlerMap<ConnectionFrame>;
