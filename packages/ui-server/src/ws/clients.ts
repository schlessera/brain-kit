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

/** Mutable admission decision shared by every asynchronous path from one socket. */
export interface AuthorizationContext {
  readonly principalId: string;
  readonly expiresAt: number;
  valid: boolean;
}

interface AttachedClient {
  ws: WSContext;
  principalId: string;
  authorization: AuthorizationContext;
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

  constructor(readonly maxConnections = 32) {}

  add(
    ws: WSContext,
    principalId: string,
    authorization: AuthorizationContext = {
      principalId,
      expiresAt: Number.MAX_SAFE_INTEGER,
      valid: true,
    }
  ): boolean {
    const identity = ws.raw ?? ws;
    if (!this.clients.has(identity) && this.clients.size >= this.maxConnections) return false;
    this.clients.set(identity, { ws, principalId, authorization });
    return true;
  }

  remove(ws: WSContext): void {
    this.clients.delete(ws.raw ?? ws);
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
   * Invalidate, close, and forget only sockets admitted for one principal.
   * Contexts are invalidated before close callbacks can run, so a frame already
   * queued by the adapter cannot cross the revocation boundary.
   */
  closeFor(principalId: string, code: number, reason: string): void {
    const closing: AttachedClient[] = [];
    for (const [identity, client] of this.clients) {
      if (client.principalId !== principalId) continue;
      client.authorization.valid = false;
      this.clients.delete(identity);
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

  /** Add principals whose admitted socket authorization has expired. */
  collectExpiredPrincipalIds(now: number, ids: Set<string>): void {
    for (const { authorization } of this.clients.values()) {
      if (authorization.valid && authorization.expiresAt <= now) {
        ids.add(authorization.principalId);
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
    this.clients.clear();
    for (const client of clients) client.authorization.valid = false;
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
