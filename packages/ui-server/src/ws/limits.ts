/**
 * Host queue limits and turn log attributes. A leaf module (#2515): the
 * session runner reads these values without importing the host that runs it,
 * so `host → conversation → run-session` never leads back to `host.ts`.
 */

/**
 * Budget for the host-side follow-up queue of ONE session (backends without a
 * native `followUp`; with one, messages go into the running turn and none of
 * this applies).
 *
 * Bytes rather than a message count, because that is what the cost actually
 * tracks: a queued entry is retained in this process until its turn runs, and
 * an entry carrying four images outweighs a hundred carrying text. Counting
 * messages made a text-only queue and a 50 MB image queue look identical.
 *
 * Past the warn mark the message is still accepted — the sender is told the
 * queue is getting heavy, in `detail` on the `queued` status and in the server
 * log. Past the hard cap it is refused with SESSION_QUEUE_FULL, which is an
 * explicit error frame, never a silent drop.
 */
export const QUEUE_WARN_BYTES = 20 * 1024 * 1024;
export const QUEUE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Backstop on depth. Bytes do not bound COUNT, and every queued entry becomes
 * its own turn: without this, ~500k one-line messages fit inside the byte cap
 * and would run the session for days. Not the limit anyone should hit.
 */
export const MAX_SESSION_QUEUE = 50;

/** Identity of one turn, as it appears on a log record. */
export interface TurnLogContext {
  sessionId?: string | null;
  turnId?: string | null;
  providerId?: string | null;
}

/**
 * Log attributes for one turn. Null fields are omitted rather than stringified
 * — a new session has no sessionId until `session_info` names it.
 */
export function turnLogAttributes(turn: TurnLogContext): Record<string, string> {
  return {
    ...(turn.sessionId ? { "session.id": turn.sessionId } : {}),
    ...(turn.turnId ? { "turn.id": turn.turnId } : {}),
    ...(turn.providerId ? { profile: turn.providerId } : {}),
  };
}
