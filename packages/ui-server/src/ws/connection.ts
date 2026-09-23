import { upgradeWebSocket, websocket } from "hono/bun";
import type { MiddlewareHandler } from "hono";
import { PROTOCOL_REV } from "@schlessera/brain-ui-sdk/protocol";
import { parseClientMessage } from "@schlessera/brain-ui-sdk/schemas";
import { approvalRequestFrame, withTurnScope } from "./frames.js";
import type { WSContext as WSContextType } from "./clients.js";
import type { Principal } from "../db/principals.js";
import type { AppEnv } from "../app-env.js";

/**
 * Re-send every pending approval and ask-user card to a client that just
 * connected. These survive disconnects (see drainClientBoundForTurn) precisely
 * so this re-delivery can happen: a phone that dropped its socket at screen
 * lock reconnects and finds the card waiting instead of a dead turn. The
 * frames carry their original turn scope, so answering them resolves the
 * correct turn's promise through the normal dispatch path.
 */
function resendPendingInteractive(host: WsHost, ws: WSContextType): void {
  const { coordinator } = host;
  for (const p of coordinator.pendingApprovals.values()) {
    host.sendMessage(
      ws,
      withTurnScope(
        approvalRequestFrame(p.request, host.toolPermissions !== null),
        p.turn,
        p.turnId
      )
    );
  }
  for (const p of coordinator.pendingAskUser.values()) {
    host.sendMessage(
      ws,
      withTurnScope(
        { type: "ask_user_request", requestId: p.requestId, questions: p.questions },
        p.turn,
        p.turnId
      )
    );
  }
}
import { sendSessionHistory } from "./history.js";
import { handleClientMessage, type ConnectionState } from "./dispatch.js";
import type { WsHost } from "./host.js";
import type { WSContext } from "./clients.js";

export { websocket };

const CONNECTION_LIMIT_CLOSE_CODE = 4008;
const CONNECTION_LIMIT_CLOSE_REASON = "Connection limit reached";
const REVOKED_BEFORE_ADMISSION_CLOSE_CODE = 1008;
const REVOKED_BEFORE_ADMISSION_CLOSE_REASON = "Sessions invalidated";

/**
 * The socket lifecycle handlers for one host, separate from the Hono upgrade
 * that wraps them.
 *
 * Split out so the real frame path is reachable from a test without standing
 * up an HTTP server: `createWsHandlers(host).onMessage(...)` runs exactly what
 * production runs, which is what makes an assertion about a dropped frame an
 * assertion about the shipped code rather than about a re-implementation.
 */
export function createWsHandlers(host: WsHost, principal: Principal) {
  // One bucket per connection, created here so it lives and dies with the
  // socket rather than in a map keyed by something a peer controls.
  const limiter = host.newRateLimiter();
  // Authentication can await before it reaches this handler. Re-read durable
  // validity as the coordinator constructs and synchronously registers the
  // context, so there is no unregistered authorization state to lose.
  const authorization = host.coordinator.openAuthorization({
    principalId: principal.id,
    expiresAt: principal.expiresAt,
    valid: host.isPrincipalValid(principal),
  });
  // Per-connection negotiation state: what revision this client declared.
  // Lives with the socket, like the limiter.
  const connection: ConnectionState = {
    principal,
    authorization,
  };
  return {
    async onOpen(_evt: Event, ws: WSContext) {
      if (!connection.authorization.valid) {
        connection.authorization.release();
        ws.close!(REVOKED_BEFORE_ADMISSION_CLOSE_CODE, REVOKED_BEFORE_ADMISSION_CLOSE_REASON);
        return;
      }
      if (
        !host.clients.add(ws, principal.id, { onRemove: connection.authorization.release })
      ) {
        connection.authorization.release();
        host.reportRefusedConnection();
        // Hono's WSContext always exposes close(); the local structural socket
        // type keeps it optional because send-only test/dispatch fakes never
        // exercise connection admission.
        ws.close!(CONNECTION_LIMIT_CLOSE_CODE, CONNECTION_LIMIT_CLOSE_REASON);
        return;
      }
      host.log.emit({ severityText: "INFO", body: "client connected" });
      const { coordinator, catalog } = host;

      // Handshake first (rev 2, additive): protocol revision + coarse
      // capabilities, so the client can gate behavior instead of sniffing.
      host.sendMessage(ws, {
        type: "server_hello",
        protocolRev: PROTOCOL_REV,
        capabilities: {
          multiSession: true,
          askUser: true,
          location: true,
          // Advertised only when this host records activity — a client on an
          // activity-less host knows subscribing would be pointless.
          ...(host.activity ? { activity: true } : {}),
        },
      });

      // Snapshot-on-connect only for the single-running-session case (backward
      // compatible). With zero or several running sessions the client rehydrates
      // itself per-session via session_resume, and live frames (sessionId-scoped)
      // fan out to it once it joins the broadcast set.
      const runningTurns = [...coordinator.running].filter((t) => t.sessionId);
      if (runningTurns.length === 1) {
        const turn = runningTurns[0];
        const sid = turn.sessionId!;
        host.sendMessage(
          ws,
          // Stamp the live turn identity: a reconnecting client must learn the
          // current turnId, or the correlation guarantee dies at the reconnect
          // it exists for.
          withTurnScope(
            {
              type: "session_info",
              sessionId: sid,
              isNew: false,
              providerId: turn.providerId ?? catalog.getStoredProviderId(sid) ?? undefined,
              backendId: catalog.getStoredBackendId(sid) ?? turn.backend.id,
            },
            turn
          )
        );
        // Snapshot-on-connect owns a lease separate from the socket: a close
        // while history loads must not make this work invisible to revocation.
        const releaseAuthorization = connection.authorization.retain();
        try {
          const backend = await host.registry.getBackendForSession(
            catalog.getStoredBackendId(sid) ?? turn.backend.id
          );
          const history = await backend.getHistory(sid);
          if (connection.authorization.valid && history.length > 0) {
            sendSessionHistory(ws, sid, host.attachMessageBlocks(sid, history));
          }
        } catch (err) {
          host.log.emit({
            severityText: "ERROR",
            body: "snapshot-on-connect failed",
            attributes: { error: err instanceof Error ? err.message : String(err) },
          });
        } finally {
          releaseAuthorization();
          if (connection.authorization.valid) {
            host.sendMessage(
              ws,
              withTurnScope(
                {
                  type: "status",
                  status: "thinking",
                  detail: "Session in progress",
                  sessionId: sid,
                },
                turn
              )
            );
            resendPendingInteractive(host, ws);
          }
        }
        return;
      }

      host.sendMessage(ws, {
        type: "status",
        status: "idle",
        detail: `Connected to ${host.appName}`,
      });
      resendPendingInteractive(host, ws);
    },

    onMessage(evt: MessageEvent, ws: WSContext) {
      if (
        connection.authorization.valid &&
        connection.authorization.expiresAt <= Date.now()
      ) {
        host.expireAuthorizationContexts();
      }
      if (!connection.authorization.valid) {
        host.reportDroppedFrame("revoked_principal");
        return;
      }
      // Boundary validation (rev 2): byte cap + JSON decode + schema, in one
      // place. No more casting client JSON to ClientMessage.
      //
      // Text frames only: hono's Bun adapter hands binary frames over as the
      // underlying POOLED ArrayBuffer (byteOffset/byteLength discarded), so a
      // binary frame cannot be decoded correctly here. The protocol is JSON
      // text; reject anything else rather than parse a slab.
      // Metered BEFORE parsing: the point is to bound work an unmetered peer
      // can make this process do, and parsing is most of that work.
      if (limiter && !limiter.take().allowed) {
        host.reportDroppedFrame("rate_limited");
        host.sendMessage(ws, {
          type: "error",
          code: "RATE_LIMITED",
          message: "Too many frames; slow down.",
        });
        return;
      }

      const raw = evt.data;
      if (typeof raw !== "string") {
        host.reportDroppedFrame("binary_frame");
        host.sendMessage(ws, {
          type: "error",
          code: "PARSE_ERROR",
          message: "Binary frames are not supported; send JSON text",
        });
        return;
      }
      const parsed = parseClientMessage(raw);
      if (!parsed.ok) {
        // The reason is the parser's own bounded message, never the frame:
        // the payload is caller-supplied and capped at 12 MB.
        host.reportDroppedFrame("parse_error", parsed.error);
        host.sendMessage(ws, { type: "error", code: "PARSE_ERROR", message: parsed.error });
        return;
      }
      // Parsing is synchronous, but dispatch deliberately starts on a
      // microtask. Keep this shared authority discoverable across that gap —
      // including after an ordinary disconnect removes the admitted client.
      // runSession adds its own reference before this one is released, so a
      // chat startup remains continuously revocable through routing/billing.
      const releaseAuthorization = connection.authorization.retain();
      // handleClientMessage is async — a rejection must not escape as an
      // unhandled rejection with no frame sent.
      void Promise.resolve()
        .then(() => handleClientMessage(host, ws, parsed.message, connection))
        .catch((err) => {
          // This used to swallow the cause entirely: the client got a generic
          // frame and the server kept no record of what threw.
          host.log.emit({
            severityText: "ERROR",
            body: "client message handler failed",
            attributes: {
              "frame.type": parsed.message.type,
              error: err instanceof Error ? err.message : String(err),
            },
          });
          host.sendMessage(ws, {
            type: "error",
            code: "INTERNAL_ERROR",
            message: "Failed to handle message",
          });
        })
        .finally(() => {
          releaseAuthorization();
        });
    },

    onClose(evt: CloseEvent, ws: WSContext) {
      // Closure is not authorization: a frame parsed before this callback can
      // still be mid-dispatch, and an activity_subscribe landing after the
      // cleanup below would re-register the dead socket and keep the activity
      // poller awake. Authorization stays whatever it is; this says the
      // transport is gone.
      connection.closed = true;
      host.log.emit({ severityText: "INFO", body: "client disconnected" });
      // No onError here on purpose: hono's Bun adapter never dispatches it
      // (only open/message/close reach these handlers), so a transport failure
      // is only visible as an abnormal close code. 1000/1001 are the two
      // clean endings (normal closure, going away); anything else — before it
      // was recorded — looked exactly like a clean disconnect.
      const code = (evt as { code?: unknown }).code;
      if (typeof code === "number" && code !== 1000 && code !== 1001) {
        host.reportAbnormalClose(code);
      }
      host.clients.remove(ws);
      connection.authorization.release();
      host.activity?.stream.dropConnection(ws);
      // Turns keep running in the background. Once the LAST client leaves,
      // reject only the requests that need a live client RIGHT NOW (location,
      // mask). Approvals and ask-user cards survive the disconnect and are
      // re-delivered on reconnect — a phone drops its socket at every screen
      // lock, and denying pending approvals on that signal killed real work.
      // The turn timeout remains their upper bound.
      if (host.clients.hasClients()) return;
      for (const turn of host.coordinator.running) {
        host.coordinator.drainClientBoundForTurn(turn, "Client disconnected");
      }
    },

    /** The HTTP upgrade failed, so no socket lifecycle callback will clean up. */
    onUpgradeFailed() {
      connection.authorization.release();
    },
  };
}

/** Build the Hono WebSocket upgrade handler bound to one host. */
export function createWsUpgrade(host: WsHost): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = c.get("principal");
    if (!principal) {
      return c.json({ error: "Authentication required" }, 401);
    }
    const handlers = createWsHandlers(host, principal);
    const upgrade = upgradeWebSocket(() => handlers);
    try {
      return await upgrade(c, async () => {
        handlers.onUpgradeFailed();
        await next();
      });
    } catch (err) {
      handlers.onUpgradeFailed();
      throw err;
    }
  };
}
