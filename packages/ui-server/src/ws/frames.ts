import type { ServerMessage, ServerToolApprovalRequest } from "@schlessera/brain-ui-sdk/protocol";
import type { PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import type { RunningTurn } from "./turns.js";

/**
 * Stamp a session-scoped frame with a sessionId for client demux. Every
 * ServerMessage is session-scoped (or carries its own sessionId), so this only
 * fills in a missing id and never overwrites one the backend already set.
 */
export function withSessionId(msg: ServerMessage, sessionId: string | null): ServerMessage {
  if (!sessionId) return msg;
  if ((msg as { sessionId?: string }).sessionId) return msg;
  return { ...msg, sessionId } as ServerMessage;
}

/**
 * Stamp a frame with the turn's session AND turn identity (rev 2). turnId lets
 * the client correlate interactive round-trips (approvals / ask-user /
 * location) with the exact turn that raised them, even across a reconnect.
 */
export function withTurnScope(
  msg: ServerMessage,
  turn: RunningTurn,
  turnId: string = turn.turnId
): ServerMessage {
  const scoped = withSessionId(msg, turn.sessionId);
  if ((scoped as { turnId?: string }).turnId) return scoped;
  return { ...scoped, turnId } as ServerMessage;
}

/**
 * The approval card for a permission request, before turn scoping. One
 * builder for the first emission (bridge.ts) and the re-delivery on reconnect
 * (connection.ts), so a card that survives a screen lock says exactly what it
 * said the first time. `rememberable: false` mirrors the refusals dispatch.ts
 * applies to an "always allow" — outside the enforced allowlist, or with no
 * grant store to write to; that guard still decides, this only stops the
 * client offering what it will refuse. Kind "command" is left to `kind`,
 * which clients already read as never rememberable.
 */
export function approvalRequestFrame(
  req: PermissionRequest,
  hasGrantStore: boolean
): ServerToolApprovalRequest {
  return {
    type: "tool_approval_request",
    toolUseId: req.toolUseId,
    toolName: req.toolName,
    input: req.input,
    description: req.description,
    ...(req.kind ? { kind: req.kind } : {}),
    ...(req.outsideEnforcedAllowlist || !hasGrantStore ? { rememberable: false } : {}),
  };
}

/** Human-readable reason for a GeolocationPositionError code. */
export function locationErrorText(code: number, fallback: string): string {
  switch (code) {
    case 1:
      return "The user denied permission to share their location.";
    case 2:
      return "The user's location is currently unavailable.";
    case 3:
      return "Timed out while retrieving the user's location.";
    default:
      return fallback || "Failed to retrieve the user's location.";
  }
}
