import type { ClientMessageHandler } from "./context.js";

export const handleActivitySubscribe: ClientMessageHandler<"activity_subscribe"> = ({ host, ws, connection }, msg) => {
  // View-scoped opt-in: without a subscription this connection never
  // receives an activity frame. No turn correlation — subscriptions are
  // connection state, not turn state.
  //
  // Dispatch starts on a microtask, so this can run after onClose already
  // dropped the connection's subscriptions. Registering here would resurrect
  // a dead socket in the registry and keep the activity poller alive for the
  // life of the process.
  if (connection.closed) return;
  host.activity?.stream.handleSubscribe(ws, msg, connection.authorization.principalId);
};

export const handleActivityUnsubscribe: ClientMessageHandler<"activity_unsubscribe"> = ({ host, ws }, msg) => {
  host.activity?.stream.handleUnsubscribe(ws, msg);
};
