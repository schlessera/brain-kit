/** A retained browser ID is not proof that this host still owns the chat. */
import type { WSContext } from "./clients.js";
import type { ConnectionState } from "./dispatch.js";
import type { WsHost } from "./host.js";
import { readSessionRecovery } from "./recovery.js";

export async function requireKnownSession(host: WsHost, ws: WSContext, connection: ConnectionState, sessionId: string, allowImportedHistory = false, requestId?: string, onLoadError?: (error: unknown) => void): Promise<boolean> {
  try {
    // A newly emitted session_info may still have a catalog stub in flight.
    await host.catalog.settled?.();
    if (connection.authorization.expiresAt <= Date.now()) host.expireAuthorizationContexts();
    if (host.closing || connection.closed || !connection.authorization.valid) return false;
    // Older catalogs may expose ownership without the optional existence read.
    const exists = host.catalog.hasSession?.(sessionId)
      ?? (host.catalog.getStoredBackendId(sessionId) !== null ? true : undefined);
    if (exists === true) return true;
    if (exists === false) {
      const recovery = await readSessionRecovery(host, sessionId, connection.principal);
      if (connection.authorization.expiresAt <= Date.now()) host.expireAuthorizationContexts();
      if (host.closing || connection.closed || !connection.authorization.valid || recovery.kind === "unauthorized") return false;
      if (recovery.kind === "ok") {
        if (allowImportedHistory) return true;
        // Imported history is real, but a read cannot invent a catalog/profile binding.
        host.sendMessage(ws, { type: "error", code: "CONVERSATION_STORAGE", sessionId, ...(requestId ? { requestId } : {}),
          message: "This chat has imported history but is not registered for live work. Start a New conversation; your draft is kept.",
        });
        return false;
      }
    }
    host.sendMessage(ws, { type: "error", sessionId, ...(requestId ? { requestId } : {}),
      code: exists === false ? "SESSION_NOT_FOUND" : "SESSION_LOAD_ERROR",
      message: exists === false
        ? "This conversation is not available on this host. Start a New conversation; your draft is kept."
        : "The host cannot verify this conversation. No work was started; your draft is kept.",
    });
  } catch (error) {
    if (connection.authorization.expiresAt <= Date.now()) host.expireAuthorizationContexts();
    if (!host.closing && !connection.closed && connection.authorization.valid) {
      // Resume owns its outcome and metric; retain the cause without putting it on the wire.
      onLoadError?.(error);
      host.sendMessage(ws, { type: "error", sessionId, ...(requestId ? { requestId } : {}),
        code: "SESSION_LOAD_ERROR", message: "The host could not verify this conversation. No work was started; your draft is kept.",
      });
    }
  }
  return false;
}
