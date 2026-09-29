import { PROTOCOL_REV_CLIENT_ECHO } from "@schlessera/brain-ui-sdk/protocol";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "./clients.js";
import type { AuthorizationContext } from "./turns.js";
import { approvalRequestFrame, locationErrorText, withTurnScope } from "./frames.js";
import { sendSessionHistory } from "./history.js";
import { validateAttachments } from "./attachments.js";
import { handleChatMessage } from "./run-session.js";
import type { WsHost } from "./host.js";

/** Per-connection negotiation state, owned by the socket handler. */
export interface ConnectionState {
  /**
   * The transport is gone. Set by onClose, and separate from `authorization`
   * because a disconnect is not a revocation: work already underway keeps its
   * authority, but nothing may register new per-connection state afterwards.
   */
  closed?: boolean;
  /** Principal resolved once at the WebSocket upgrade boundary. */
  principal: import("../db/principals.js").Principal;
  /** Mutable in-memory decision invalidated synchronously by revocation. */
  authorization: AuthorizationContext;
  /** Revision the client declared via `client_hello`; absent means rev 2. */
  protocolRev?: number;
}

/**
 * Does this reply's echoed turnId identify the turn that raised the request?
 *
 * A wrong id is always refused: a stale echo from before a reconnect or a
 * follow-up would resolve a different turn's pending promise.
 *
 * A MISSING id depends on who is speaking. A client that declared rev 3
 * promised to echo, so silence means the reply cannot be correlated and is
 * refused. A client that declared nothing is rev 2, where the field is
 * optional, and is still tolerated — that tolerance is the deprecation window,
 * and it is what lets this be enforced at all without breaking clients that
 * predate `client_hello`.
 */
export function turnIdMatches(
  pending: { turnId: string },
  echoed: string | undefined,
  requireEcho: boolean
): boolean {
  if (echoed === undefined) return !requireEcho;
  return echoed === pending.turnId;
}

export async function handleClientMessage(
  host: WsHost,
  ws: WSContext,
  msg: ClientMessage,
  connection: ConnectionState
): Promise<void> {
  // The socket callback schedules dispatch on a microtask. Revocation may land
  // after parsing but before this function begins, so repeat the in-memory
  // check at the actual dispatch boundary.
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
  const { coordinator, catalog } = host;
  const requireEcho = (connection.protocolRev ?? 2) >= PROTOCOL_REV_CLIENT_ECHO;
  switch (msg.type) {
    case "client_hello": {
      // Record what this connection speaks. Never rejected on version: a
      // future client declaring rev 9 is simply held to the rules this host
      // knows, and an unknown capability flag is ignored.
      connection.protocolRev = msg.protocolRev;
      return;
    }

    case "chat_message": {
      const attachmentResult = validateAttachments(msg.attachments);
      if (!attachmentResult.ok) {
        host.sendMessage(ws, {
          type: "error",
          code: "ATTACHMENT_REJECTED",
          message: attachmentResult.reason,
          ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
        });
        return;
      }
      await handleChatMessage(host, ws, {
        authorization: connection.authorization,
        text: msg.text,
        sessionId: msg.sessionId,
        attachments: attachmentResult.attachments,
        providerId: msg.providerId,
        client: msg.client,
        source: msg.source,
        draftId: msg.draftId,
        ...(msg.localExchanges?.length ? { localExchanges: msg.localExchanges } : {}),
      });
      break;
    }

    case "local_exchange": {
      // A command the client answered itself (#582). Stored against the
      // session; the next prompt handed to the backend carries its context.
      // Answered either way, so the client can say when it is not kept.
      const saved = catalog.recordLocalExchange?.(msg.sessionId, msg.exchange, false) ?? false;
      host.sendMessage(ws, {
        type: "local_exchange_result",
        sessionId: msg.sessionId,
        exchangeId: msg.exchange.id,
        saved,
        ...(saved
          ? {}
          : {
              reason: catalog.recordLocalExchange
                ? "The server could not store it."
                : "This server does not keep local answers.",
            }),
      });
      return;
    }

    case "ask_user_response": {
      const pending = coordinator.pendingAskUser.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingAskUser.delete(msg.requestId);
        pending.turn.recorder?.recordAskUserResponse(
          connection.authorization.principalId
        );
        pending.resolve({ answers: msg.answers, annotations: msg.annotations });
      }
      break;
    }

    case "ask_user_list_response": {
      const pending = coordinator.pendingAskUserList.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingAskUserList.delete(msg.requestId);
        pending.turn.recorder?.recordAskUserResponse(
          connection.authorization.principalId
        );
        pending.resolve({ answers: msg.answers, ...(msg.notes ? { notes: msg.notes } : {}) });
      }
      break;
    }

    case "ask_user_cancel": {
      // Dismisses either ask kind: the ids share one space.
      const pending =
        coordinator.pendingAskUser.get(msg.requestId) ??
        coordinator.pendingAskUserList.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingAskUser.delete(msg.requestId);
        coordinator.pendingAskUserList.delete(msg.requestId);
        pending.turn.recorder?.recordCancellation(
          connection.authorization.principalId,
          "ask_user"
        );
        pending.reject(new Error(msg.reason || "User cancelled the question"));
      }
      break;
    }

    case "location_response": {
      const pending = coordinator.pendingLocation.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingLocation.delete(msg.requestId);
        pending.resolve({ coords: msg.coords, timestamp: msg.timestamp });
      }
      break;
    }

    case "location_error": {
      const pending = coordinator.pendingLocation.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingLocation.delete(msg.requestId);
        pending.reject(new Error(locationErrorText(msg.code, msg.message)));
      }
      break;
    }

    case "mask_response": {
      const pending = coordinator.pendingMask.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingMask.delete(msg.requestId);
        // Decoded here rather than in the tool: the boundary already validated
        // the base64 and its size, so the backend gets bytes it can trust.
        pending.resolve(Uint8Array.from(Buffer.from(msg.maskPng, "base64")));
      }
      break;
    }

    case "mask_error": {
      const pending = coordinator.pendingMask.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingMask.delete(msg.requestId);
        pending.reject(
          new Error(
            msg.code === "cancelled"
              ? `The user did not mark an area${msg.message ? `: ${msg.message}` : ""}`
              : msg.message || "The mask editor failed"
          )
        );
      }
      break;
    }

    case "tool_approval": {
      const pending = coordinator.pendingApprovals.get(msg.toolUseId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        // Voice may deny; it may never grant (docs/decisions/voice-permission.md).
        // A grant attributed to voice is refused before anything else looks
        // at it: the request stays pending, nothing is recorded or
        // remembered, and the card is still there to answer it. The wire is
        // not trusted to enforce policy — a client offering no spoken grant
        // is not the reason this holds.
        if (msg.channel === "voice") {
          host.log.emit({
            severityText: "WARN",
            body: "voice-attributed grant refused",
            attributes: {
              "tool.name": pending.request.toolName,
              "toolUse.id": pending.request.toolUseId,
            },
          });
          // The sender treated its reply as the end of the exchange — a
          // client drops the request's turn correlation once it answers, and
          // may have cleared the card — so hand it the card again, exactly
          // as a reconnect would. Without this its next answer (the card's,
          // or a spoken denial) arrives uncorrelated and is dropped too.
          host.sendMessage(
            ws,
            withTurnScope(
              approvalRequestFrame(pending.request, host.toolPermissions !== null),
              pending.turn,
              pending.turnId
            )
          );
          break;
        }
        coordinator.pendingApprovals.delete(msg.toolUseId);
        // Remember-on-approve. Kind "command" never persists (the client
        // hides the option, but the wire is not trusted to enforce policy).
        // Neither does an approval given under an enforced allowlist that
        // this tool is outside of: the store is read by every OTHER turn, and
        // a grant made inside a narrower posture must not widen the ones the
        // user was not looking at. The call itself still runs — they approved
        // it — it is only the memory that is refused.
        // The store being absent is one of the reasons, not an exemption from
        // them: optional-chaining the add() away would take the "remembered"
        // branch, write nothing, log nothing, and still stamp the activity
        // record `always_allow` — the exact silent refusal this block exists
        // to rule out. Embedders wire a store (app.ts) so this is the
        // test/embedder path, which is precisely where a silent no-op is
        // hardest to notice.
        const store = host.toolPermissions;
        const remembers =
          store !== null &&
          pending.request.kind !== "command" &&
          !pending.request.outsideEnforcedAllowlist;
        if (msg.always && remembers) {
          store.add(pending.request.toolName);
        } else if (msg.always) {
          // The user asked for something the host will not do. Recorded for
          // the same reason the bridge records a grant it declines to apply:
          // a refusal nobody can see is indistinguishable from a bug, and for
          // kind "command" it also says a client sent an option its own UI
          // does not offer.
          host.log.emit({
            severityText: "INFO",
            body: "always-allow not remembered",
            attributes: {
              "tool.name": pending.request.toolName,
              "toolUse.id": pending.request.toolUseId,
              reason:
                store === null
                  ? "no grant store configured"
                  : pending.request.kind === "command"
                    ? "per-use confirmation"
                    : "outside this turn's enforced allowlist",
            },
          });
        }
        pending.resolve(
          msg.updatedInput
            ? { behavior: "allow", updatedInput: msg.updatedInput }
            : { behavior: "allow" },
          {
            principalId: connection.authorization.principalId,
            ...(msg.always && remembers ? { always: true } : {}),
            ...(msg.channel ? { channel: msg.channel } : {}),
          }
        );
      }
      break;
    }

    case "tool_denial": {
      const pending = coordinator.pendingApprovals.get(msg.toolUseId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingApprovals.delete(msg.toolUseId);
        pending.resolve(
          { behavior: "deny", message: msg.message },
          {
            principalId: connection.authorization.principalId,
            ...(msg.channel ? { channel: msg.channel } : {}),
          }
        );
      }
      break;
    }

    case "cancel": {
      if (msg.sessionId) {
        const turn = coordinator.bySession.get(msg.sessionId);
        if (turn) {
          coordinator.recordCancellation(turn, connection.authorization.principalId);
          coordinator.cancelTurn(turn, "Cancelled by user");
        }
        const starting = coordinator.startingBySession.get(msg.sessionId);
        if (starting) {
          starting.cancelled = true;
          // Releasing here, not in runSession: a start cancelled before it
          // becomes a turn never reaches the loop that would drain its queue.
          for (const entry of starting.queue.splice(0)) entry.releaseAuthorization();
          host.sendToClients({ type: "status", status: "idle", sessionId: msg.sessionId, detail: "Cancelled before starting" });
        }
        return;
      }
      // No sessionId: cancel the sole running session; ambiguous if several run.
      if (coordinator.running.size === 0) return;
      if (coordinator.running.size > 1) {
        host.sendMessage(ws, {
          type: "error",
          code: "CANCEL_AMBIGUOUS",
          message: "Several sessions are running — specify which to cancel.",
        });
        return;
      }
      const turn = [...coordinator.running][0]!;
      coordinator.recordCancellation(turn, connection.authorization.principalId);
      coordinator.cancelTurn(turn, "Cancelled by user");
      break;
    }

    case "activity_subscribe": {
      // View-scoped opt-in: without a subscription this connection never
      // receives an activity frame. No turn correlation — subscriptions are
      // connection state, not turn state.
      //
      // Dispatch starts on a microtask, so this can run after onClose already
      // dropped the connection's subscriptions. Registering here would resurrect
      // a dead socket in the registry and keep the activity poller alive for the
      // life of the process.
      if (connection.closed) break;
      host.activity?.stream.handleSubscribe(ws, msg, connection.authorization.principalId);
      break;
    }

    case "activity_unsubscribe": {
      host.activity?.stream.handleUnsubscribe(ws, msg);
      break;
    }

    case "session_resume": {
      host.sendMessage(ws, {
        type: "session_info",
        sessionId: msg.sessionId,
        isNew: false,
        providerId: catalog.getStoredProviderId(msg.sessionId) ?? undefined,
        backendId: catalog.getStoredBackendId(msg.sessionId) ?? undefined,
      });

      try {
        const backend = await host.registry.getBackendForSession(catalog.getStoredBackendId(msg.sessionId));
        const messages = await backend.getHistory(msg.sessionId);
        if (!connection.authorization.valid) return;
        sendSessionHistory(ws, msg.sessionId, host.prepareHistory(msg.sessionId, messages));
        // A resume of a RUNNING session (reattach) must not report idle: idle
        // would clear the client's running badge and finish its streaming
        // message mid-turn. Mirror the snapshot-on-connect status instead.
        const runningTurn = coordinator.bySession.get(msg.sessionId);
        host.sendMessage(ws, {
          type: "status",
          ...(runningTurn
            ? { status: "thinking" as const, detail: "Session in progress" }
            : { status: "idle" as const, detail: "Session loaded" }),
          sessionId: msg.sessionId,
          ...(runningTurn ? { turnId: runningTurn.turnId } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load session";
        host.reportTurnFailed("SESSION_LOAD_ERROR", { sessionId: msg.sessionId }, message);
        host.sendMessage(ws, {
          type: "error",
          code: "SESSION_LOAD_ERROR",
          message,
          sessionId: msg.sessionId,
        });
      }
      break;
    }
  }
}
