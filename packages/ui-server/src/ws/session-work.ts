import type { Database } from "bun:sqlite";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { updatePrefix } from "./turn-failures.js";

/**
 * Accepted-work ordering and turn boundaries for session recovery (#964,
 * D52 §6). Host-owned metadata in the UI's operational database: the latest
 * request the host accepted for a session, the revision that orders
 * acceptance, and where each finished turn's last answer sits in the backend
 * transcript. No prompt text, payload or credential is stored.
 */

/** The latest accepted request of one session, as persisted. */
export interface AcceptedWork {
  revision: number;
  requestId: string | null;
  /** Null until the request's turn is dispatched; stays null if it never runs. */
  turnId: string | null;
  backendId: string | null;
  acceptedAt: number;
  startedAt: number | null;
}

/**
 * Record that the host accepted a request for `sessionId` and return its
 * revision: one more than the last. The read and the write are one
 * statement, so two acceptances can never share a revision.
 */
export function acceptWork(
  db: Database,
  sessionId: string,
  input: { requestId: string | null; backendId: string | null; at: number }
): number {
  const row = db
    .query(
      `INSERT INTO session_work (session_id, revision, request_id, turn_id, backend_id, accepted_at, started_at)
       VALUES (?, 1, ?, NULL, ?, ?, NULL)
       ON CONFLICT(session_id) DO UPDATE SET
         revision = revision + 1,
         request_id = excluded.request_id,
         turn_id = NULL,
         backend_id = COALESCE(excluded.backend_id, backend_id),
         accepted_at = excluded.accepted_at,
         started_at = NULL
       RETURNING revision`
    )
    .get(sessionId, input.requestId, input.backendId, input.at) as { revision: number };
  return row.revision;
}

/**
 * Record the turn that runs the request accepted at `revision`. Only that
 * revision is updated: once a newer request has been accepted, an older
 * request's dispatch changes nothing.
 */
export function dispatchWork(
  db: Database,
  sessionId: string,
  input: { revision: number; turnId: string; backendId: string; startedAt: number }
): boolean {
  const result = db
    .prepare(
      `UPDATE session_work SET turn_id = ?, started_at = ?, backend_id = COALESCE(backend_id, ?)
       WHERE session_id = ? AND revision = ? AND turn_id IS NULL`
    )
    .run(input.turnId, input.startedAt, input.backendId, sessionId, input.revision);
  return result.changes === 1;
}

export function latestWork(db: Database, sessionId: string): AcceptedWork | null {
  const row = db
    .query(
      `SELECT revision, request_id, turn_id, backend_id, accepted_at, started_at
       FROM session_work WHERE session_id = ?`
    )
    .get(sessionId) as
    | { revision: number; request_id: string | null; turn_id: string | null; backend_id: string | null; accepted_at: number; started_at: number | null }
    | null;
  if (!row) return null;
  return {
    revision: row.revision,
    requestId: row.request_id,
    turnId: row.turn_id,
    backendId: row.backend_id,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
  };
}

/** One observed turn boundary: its last answer's assistant position and transcript digest. */
export interface TurnBoundary {
  turnId: string;
  assistantOrdinal: number;
  prefixDigest: string;
}

export function saveTurnBoundary(db: Database, sessionId: string, backendId: string, boundary: TurnBoundary): void {
  db.prepare(
    `INSERT INTO turn_boundaries (session_id, backend_id, assistant_ordinal, prefix_digest, turn_id)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, backend_id, assistant_ordinal, prefix_digest) DO NOTHING`
  ).run(sessionId, backendId, boundary.assistantOrdinal, boundary.prefixDigest, boundary.turnId);
}

/**
 * Put each observed turn's id on the assistant message that ended it. A
 * message matches only at the same assistant position AND with the same
 * transcript before and including it, which is the turn-failure replay's
 * guard (`attachTurnFailures`): content alone never links a turn.
 */
export function attachTurnBoundaries(
  db: Database,
  sessionId: string,
  backendId: string,
  messages: SessionHistoryMessage[]
): SessionHistoryMessage[] {
  const rows = db
    .query("SELECT assistant_ordinal, prefix_digest, turn_id FROM turn_boundaries WHERE session_id = ? AND backend_id = ?")
    .all(sessionId, backendId) as Array<{ assistant_ordinal: number; prefix_digest: string; turn_id: string }>;
  if (rows.length === 0) return messages;
  const stored = new Map(rows.map((row) => [`${row.assistant_ordinal}:${row.prefix_digest}`, row.turn_id]));
  let ordinal = 0;
  const hash = new Bun.CryptoHasher("sha256");
  return messages.map((message) => {
    updatePrefix(hash, message);
    if (message.role !== "assistant") return message;
    const turnId = stored.get(`${ordinal++}:${hash.copy().digest("hex")}`);
    return turnId ? { ...message, turnId } : message;
  });
}
