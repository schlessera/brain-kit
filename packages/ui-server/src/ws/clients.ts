import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { shrinkForReplication } from "./shrink.js";

/**
 * Minimal structural view of a live socket — all we need to write to it.
 * `raw` is the underlying Bun ServerWebSocket when hono's Bun adapter built
 * the context; its `send` RETURNS a status instead of throwing.
 */
export type WSContext = {
  send: (data: string) => void;
  raw?: { send?: (data: string) => number } | undefined;
};

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
   * block delivery to the others; `onSendError` lets the owner count the skip.
   */
  broadcast(msg: ServerMessage, onSendError?: (err: unknown) => void): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(shrinkForReplication(msg));
    for (const ws of this.clients) {
      try {
        // Bun's ServerWebSocket reports a dropped write by RETURNING 0 (closed
        // connection) rather than throwing, and hono's WSContext.send discards
        // that status — so write through the raw socket where one exists. -1
        // is backpressure: the frame is queued, not lost.
        if (typeof ws.raw?.send === "function") {
          if (ws.raw.send(payload) === 0) {
            onSendError?.(new Error("send dropped: connection closed"));
          }
        } else {
          ws.send(payload);
        }
      } catch (err) {
        // Drop; the socket's onClose handler removes it from the set.
        onSendError?.(err);
      }
    }
  }
}
