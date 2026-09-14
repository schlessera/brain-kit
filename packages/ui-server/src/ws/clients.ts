import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { shrinkForReplication } from "./shrink.js";

/**
 * Minimal structural view of a live socket — all we need to write to it.
 * `raw` is the underlying Bun ServerWebSocket when hono's Bun adapter built
 * the context; its `send` RETURNS a status instead of throwing.
 */
export type WSContext = {
  send: (data: string) => void;
  close?: (code?: number, reason?: string) => void;
  raw?: unknown;
};

interface AttachedClient {
  ws: WSContext;
  principalId: string;
  onRemove?: () => void;
}

function canSendRaw(raw: unknown): raw is { send: (data: string) => unknown } {
  return (
    typeof raw === "object" && raw !== null && "send" in raw && typeof raw.send === "function"
  );
}

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
  // Hono creates a new WSContext for every Bun open/message/close callback.
  // The raw socket remains stable across those wrappers, so it is the identity
  // that admission and removal must share.
  private readonly clients = new Map<unknown, AttachedClient>();

  constructor(
    readonly maxConnections = 32,
    private readonly invalidateAuthorizations: (
      principalIds: ReadonlySet<string>
    ) => void = () => {}
  ) {}

  add(ws: WSContext, principalId: string, options?: { onRemove?: () => void }): boolean {
    const identity = ws.raw ?? ws;
    if (!this.clients.has(identity) && this.clients.size >= this.maxConnections) return false;
    this.clients.set(identity, { ws, principalId, ...options });
    return true;
  }

  remove(ws: WSContext): void {
    const identity = ws.raw ?? ws;
    const client = this.clients.get(identity);
    this.clients.delete(identity);
    client?.onRemove?.();
  }

  count(): number {
    return this.clients.size;
  }

  /** Whether another distinct socket can be admitted without exceeding the cap. */
  hasCapacity(): boolean {
    return this.clients.size < this.maxConnections;
  }

  hasClients(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Close and forget only sockets admitted for one principal.
   */
  closeFor(principalId: string, code: number, reason: string): void {
    const closing: AttachedClient[] = [];
    // Same boundary as closeAll: invalidate through the coordinator FIRST,
    // while the socket-owned references still make every pending dispatch
    // discoverable. Releasing them first would let a frame parsed before this
    // call start a turn after it — measured as 0 starts before this became a
    // registry, 1 after.
    this.invalidateAuthorizations(new Set([principalId]));
    for (const [identity, client] of this.clients) {
      if (client.principalId !== principalId) continue;
      this.clients.delete(identity);
      client.onRemove?.();
      closing.push(client);
    }
    for (const { ws } of closing) {
      try {
        ws.close?.(code, reason);
      } catch {
        // Best effort per socket; revocation of sibling sockets must continue.
      }
    }
  }

  /**
   * Close and forget every attached socket. The set is cleared before close
   * callbacks can run, and one broken socket cannot prevent the others from
   * being invalidated.
   */
  closeAll(code: number, reason: string): void {
    const clients = [...this.clients.values()];
    // Forced closure is also an authorization boundary. Invalidate through
    // the coordinator while socket-owned references still keep every pending
    // dispatch discoverable; the loop below remains transport cleanup only.
    this.invalidateAuthorizations(new Set(clients.map((client) => client.principalId)));
    this.clients.clear();
    for (const client of clients) client.onRemove?.();
    for (const { ws } of clients) {
      try {
        ws.close?.(code, reason);
      } catch {
        // Best effort per socket; revocation of the remaining clients must
        // continue even when one adapter throws during close.
      }
    }
  }

  /**
   * Broadcast a frame to every attached client. Serializes once. A failing
   * socket is skipped (its `onClose` will prune it) so one dead peer can't
   * block delivery to the others; `onSendError` lets the owner count the skip.
   */
  broadcast(msg: ServerMessage, onSendError?: (err: unknown) => void): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(shrinkForReplication(msg));
    for (const { ws } of this.clients.values()) {
      try {
        // Bun's ServerWebSocket reports a dropped write by RETURNING 0 (closed
        // connection) rather than throwing, and hono's WSContext.send discards
        // that status — so write through the raw socket where one exists. -1
        // is backpressure: the frame is queued, not lost.
        if (canSendRaw(ws.raw)) {
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
