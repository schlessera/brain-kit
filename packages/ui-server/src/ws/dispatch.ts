import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "./clients.js";
import { locationErrorText } from "./frames.js";
import { sendSessionHistory } from "./history.js";
import { validateAttachments } from "./attachments.js";
import { handleChatMessage } from "./run-session.js";
import type { WsHost } from "./host.js";

/**
 * A client MAY echo the request's turnId (rev 2). When it does, it must match
 * the turn that raised the request — a stale echo from before a reconnect or
 * a follow-up would otherwise resolve the wrong turn's pending promise.
 * Absent turnId stays valid: the field is optional on the wire.
 */
function turnIdMatches(pending: { turnId: string }, echoed: string | undefined): boolean {
  return echoed === undefined || echoed === pending.turnId;
}

export async function handleClientMessage(
  host: WsHost,
  ws: WSContext,
  msg: ClientMessage
): Promise<void> {
  const { coordinator, catalog } = host;
  switch (msg.type) {
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
        text: msg.text,
        sessionId: msg.sessionId,
        attachments: attachmentResult.attachments,
        providerId: msg.providerId,
        client: msg.client,
      });
      break;
    }

    case "ask_user_response": {
      const pending = coordinator.pendingAskUser.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId)) {
        coordinator.pendingAskUser.delete(msg.requestId);
        pending.resolve({ answers: msg.answers, annotations: msg.annotations });
      }
      break;
    }

    case "ask_user_cancel": {
      const pending = coordinator.pendingAskUser.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId)) {
        coordinator.pendingAskUser.delete(msg.requestId);
        pending.reject(new Error(msg.reason || "User cancelled the question"));
      }
      break;
    }

    case "location_response": {
      const pending = coordinator.pendingLocation.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId)) {
        coordinator.pendingLocation.delete(msg.requestId);
        pending.resolve({ coords: msg.coords, timestamp: msg.timestamp });
      }
      break;
    }

    case "location_error": {
      const pending = coordinator.pendingLocation.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId)) {
        coordinator.pendingLocation.delete(msg.requestId);
        pending.reject(new Error(locationErrorText(msg.code, msg.message)));
      }
      break;
    }

    case "mask_response": {
      const pending = coordinator.pendingMask.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId)) {
        coordinator.pendingMask.delete(msg.requestId);
        // Decoded here rather than in the tool: the boundary already validated
        // the base64 and its size, so the backend gets bytes it can trust.
        pending.resolve(Uint8Array.from(Buffer.from(msg.maskPng, "base64")));
      }
      break;
    }

    case "mask_error": {
      const pending = coordinator.pendingMask.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId)) {
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
      if (pending && turnIdMatches(pending, msg.turnId)) {
        coordinator.pendingApprovals.delete(msg.toolUseId);
        pending.resolve(
          msg.updatedInput
            ? { behavior: "allow", updatedInput: msg.updatedInput }
            : { behavior: "allow" }
        );
      }
      break;
    }

    case "tool_denial": {
      const pending = coordinator.pendingApprovals.get(msg.toolUseId);
      if (pending && turnIdMatches(pending, msg.turnId)) {
        coordinator.pendingApprovals.delete(msg.toolUseId);
        pending.resolve({ behavior: "deny", message: msg.message });
      }
      break;
    }

    case "cancel": {
      if (msg.sessionId) {
        const turn = coordinator.bySession.get(msg.sessionId);
        if (turn) coordinator.cancelTurn(turn, "Cancelled by user");
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
      coordinator.cancelTurn([...coordinator.running][0], "Cancelled by user");
      break;
    }

    case "session_resume": {
      host.sendMessage(ws, {
        type: "session_info",
        sessionId: msg.sessionId,
        isNew: false,
        providerId: catalog.getStoredProviderId(msg.sessionId) ?? undefined,
      });

      try {
        const backend = await host.registry.getBackendForSession(catalog.getStoredBackendId(msg.sessionId));
        const messages = await backend.getHistory(msg.sessionId);
        sendSessionHistory(ws, msg.sessionId, messages);
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
        host.sendMessage(ws, {
          type: "error",
          code: "SESSION_LOAD_ERROR",
          message: err instanceof Error ? err.message : "Failed to load session",
          sessionId: msg.sessionId,
        });
      }
      break;
    }
  }
}
