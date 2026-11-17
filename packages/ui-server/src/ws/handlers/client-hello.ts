import { FOLLOW_UP_QUEUE_CAPABILITY } from "@schlessera/brain-ui-sdk/protocol";
import type { ClientMessageHandler } from "./context.js";

export const handleClientHello: ClientMessageHandler<"client_hello"> = ({ host, ws, connection }, msg) => {
  // Record what this connection speaks. Never rejected on version: a
  // future client declaring rev 9 is simply held to the rules this host
  // knows, and an unknown capability flag is ignored.
  connection.protocolRev = msg.protocolRev;
  connection.capabilities = { ...(msg.capabilities ?? {}) };
  host.clients.setCapabilities(ws, msg.capabilities);
  // A client that reloaded or reconnected rebuilds every session's
  // pending follow-ups from these (#1002). An empty queue sends nothing:
  // the client clears its own on each new server_hello.
  if (connection.capabilities[FOLLOW_UP_QUEUE_CAPABILITY] === true) {
    for (const sessionId of host.coordinator.sessionsWithFollowUps()) {
      host.sendMessage(ws, host.followUpQueueFrame(sessionId));
    }
  }
};
