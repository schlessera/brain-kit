import type { ClientMessageHandler } from "./context.js";

export const handleInboxDecision: ClientMessageHandler<"inbox_resolve" | "inbox_snooze"> = ({ host, ws, connection }, msg) => {
  if (connection.closed) return;
  if (!host.inbox?.handleDecision) {
    host.sendMessage(ws, { type: "error", code: "INBOX_UNAVAILABLE", message: "Inbox decisions are unavailable on this host." });
    return;
  }
  host.inbox.handleDecision(ws, msg, connection.authorization);
};

export const handleInboxSubscribe: ClientMessageHandler<"inbox_subscribe"> = ({ host, ws, connection }, msg) => {
  if (connection.closed) return;
  if (!host.inbox) {
    host.sendMessage(ws, { type: "error", code: "INBOX_UNAVAILABLE", message: "Inbox subscriptions are unavailable on this host." });
    return;
  }
  host.inbox.handleSubscribe(ws, msg, connection.authorization);
};

export const handleInboxUnsubscribe: ClientMessageHandler<"inbox_unsubscribe"> = ({ host, ws, connection }, msg) => {
  if (connection.closed) return;
  if (!host.inbox) {
    host.sendMessage(ws, { type: "error", code: "INBOX_UNAVAILABLE", message: "Inbox subscriptions are unavailable on this host." });
    return;
  }
  host.inbox.handleUnsubscribe(ws, msg);
};
