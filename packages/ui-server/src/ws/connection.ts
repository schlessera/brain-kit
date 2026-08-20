import { upgradeWebSocket, websocket } from "hono/bun";
import { PROTOCOL_REV } from "@schlessera/brain-ui-sdk/protocol";
import { parseClientMessage } from "@schlessera/brain-ui-sdk/schemas";
import { withTurnScope } from "./frames.js";
import { sendSessionHistory } from "./history.js";
import { handleClientMessage } from "./dispatch.js";
import type { WsHost } from "./host.js";
import type { WSContext } from "./clients.js";

export { websocket };

/**
 * The socket lifecycle handlers for one host, separate from the Hono upgrade
 * that wraps them.
 *
 * Split out so the real frame path is reachable from a test without standing
 * up an HTTP server: `createWsHandlers(host).onMessage(...)` runs exactly what
 * production runs, which is what makes an assertion about a dropped frame an
 * assertion about the shipped code rather than about a re-implementation.
 */
export function createWsHandlers(host: WsHost) {
  return {
    async onOpen(_evt: Event, ws: WSContext) {
      console.log("[ws] Client connected");
      const { coordinator, catalog } = host;

      // Handshake first (rev 2, additive): protocol revision + coarse
      // capabilities, so the client can gate behavior instead of sniffing.
      host.sendMessage(ws, {
        type: "server_hello",
        protocolRev: PROTOCOL_REV,
        capabilities: { multiSession: true, askUser: true, location: true },
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
            },
            turn
          )
        );
        try {
          const backend = await host.registry.getBackendForSession(
            catalog.getStoredBackendId(sid) ?? turn.backend.id
          );
          const history = await backend.getHistory(sid);
          if (history.length > 0) sendSessionHistory(ws, sid, history);
        } catch (err) {
          console.error("[ws] snapshot-on-connect failed:", err);
        } finally {
          host.clients.add(ws);
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
        }
        return;
      }

      host.clients.add(ws);
      host.sendMessage(ws, {
        type: "status",
        status: "idle",
        detail: `Connected to ${host.appName}`,
      });
    },

    onMessage(evt: MessageEvent, ws: WSContext) {
      // Boundary validation (rev 2): byte cap + JSON decode + schema, in one
      // place. No more casting client JSON to ClientMessage.
      //
      // Text frames only: hono's Bun adapter hands binary frames over as the
      // underlying POOLED ArrayBuffer (byteOffset/byteLength discarded), so a
      // binary frame cannot be decoded correctly here. The protocol is JSON
      // text; reject anything else rather than parse a slab.
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
      // handleClientMessage is async — a rejection must not escape as an
      // unhandled rejection with no frame sent.
      void Promise.resolve()
        .then(() => handleClientMessage(host, ws, parsed.message))
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
        });
    },

    onClose(_evt: CloseEvent, ws: WSContext) {
      console.log("[ws] Client disconnected");
      host.clients.remove(ws);
      // Turns keep running in the background. Only reject pending interactive
      // requests once the LAST client leaves — while another client remains it
      // can still answer them.
      if (host.clients.hasClients()) return;
      for (const turn of host.coordinator.running) {
        host.coordinator.drainPendingForTurn(turn, "Client disconnected");
      }
    },
  };
}

/** Build the Hono WebSocket upgrade handler bound to one host. */
export function createWsUpgrade(host: WsHost) {
  return upgradeWebSocket(() => createWsHandlers(host));
}
