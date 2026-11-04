import type { ClientMessageHandler } from "./context.js";

export const handlePing: ClientMessageHandler<"ping"> = ({ host, ws }, msg) => {
  // Liveness (rev 5): answered at once, to this socket only. Anything the
  // client receives proves the path is open; the pong correlates it.
  host.sendMessage(ws, { type: "pong", probeId: msg.probeId });
};
