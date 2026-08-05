import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
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
