import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { shrinkForReplication } from "./shrink.js";

/** Minimal structural view of a live socket — all we need to write to it. */
export type WSContext = { send: (data: string) => void };

/**
 * Every currently-attached client socket. The active agent turn is a
 * process-global singleton (server/src/ws/handler.ts), so all sockets observe
 * the same conversation; streamed output fans out to all of them.
 * Previously the server held a single `activeWs`, so a second connection
 * silently orphaned the first (it stayed open but never received output).
 */
const clients = new Set<WSContext>();

export function addClient(ws: WSContext): void {
  clients.add(ws);
}

export function removeClient(ws: WSContext): void {
  clients.delete(ws);
}

export function clientCount(): number {
  return clients.size;
}

export function hasClients(): boolean {
  return clients.size > 0;
}

/** Test-only: drop all registered sockets. */
export function resetClientsForTests(): void {
  clients.clear();
}

/** Serialize + size-bound a frame, then send it to one specific socket. */
export function sendTo(ws: WSContext, msg: ServerMessage): void {
  ws.send(JSON.stringify(shrinkForReplication(msg)));
}

/**
 * Broadcast a frame to every attached client. Serializes once. A failing
 * socket is skipped (its `onClose` will prune it) so one dead peer can't
 * block delivery to the others.
 */
export function broadcast(msg: ServerMessage): void {
  if (clients.size === 0) return;
  const payload = JSON.stringify(shrinkForReplication(msg));
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      // Drop; the socket's onClose handler removes it from the set.
    }
  }
}
