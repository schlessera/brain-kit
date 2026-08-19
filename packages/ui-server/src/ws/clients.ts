import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { shrinkForReplication } from "./shrink.js";

/** Minimal structural view of a live socket — all we need to write to it. */
export type WSContext = { send: (data: string) => void };

/** Serialize + size-bound a frame, then send it to one specific socket. */
export function sendTo(ws: WSContext, msg: ServerMessage): void {
  ws.send(JSON.stringify(shrinkForReplication(msg)));
}

/**
 * The set of currently-attached client sockets belonging to ONE WsHost. All
 * sockets of a host observe the same conversations; streamed output fans out
 * to all of them. (Previously the server held a single `activeWs`, so a second
 * connection silently orphaned the first — and later a module-global set,
 * which would have cross-wired two coexisting app instances.)
 */
export class ClientSet {
  private readonly clients = new Set<WSContext>();

  add(ws: WSContext): void {
    this.clients.add(ws);
  }

  remove(ws: WSContext): void {
    this.clients.delete(ws);
  }

  count(): number {
    return this.clients.size;
  }

  hasClients(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Broadcast a frame to every attached client. Serializes once. A failing
   * socket is skipped (its `onClose` will prune it) so one dead peer can't
   * block delivery to the others.
   */
  broadcast(msg: ServerMessage): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(shrinkForReplication(msg));
    for (const ws of this.clients) {
      try {
        ws.send(payload);
      } catch {
        // Drop; the socket's onClose handler removes it from the set.
      }
    }
  }
}
