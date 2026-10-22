/** A session's untrusted-input state (G6), read from and written to its durable governance record. */
import type { Database } from "bun:sqlite";
import type { GovernanceEventInput, GovernanceEventPayload } from "./events.js";

export type TaintSource = GovernanceEventPayload<"taint">["source"];
export interface SessionTaint { eventId: number; source: TaintSource }

const FIRST_TAINT = "SELECT id, payload FROM governance_events WHERE kind='taint' AND (turn_id=? OR (? IS NOT NULL AND session_id=?)) ORDER BY id LIMIT 1";

/** The first taint recorded for this turn or its session; taint is sticky for the session. */
export function sessionTaint(db: Database, turnId: string | null, sessionId: string | null): SessionTaint | null {
  const row = db.query(FIRST_TAINT).get(turnId, sessionId, sessionId) as { id: number; payload: string } | null;
  return row ? { eventId: row.id, source: (JSON.parse(row.payload) as { source: TaintSource }).source } : null;
}

/** Same SQLite transaction owns the first-source check and durable write. */
export function recordFirstTaint(db: Database, event: GovernanceEventInput<"taint">,
  record: (event: GovernanceEventInput<"taint">) => void): void {
  db.transaction(() => {
    if (!db.query(FIRST_TAINT).get(event.turnId ?? null, event.sessionId ?? null, event.sessionId ?? null)) record(event);
  })();
}

/** Hosts the session's turn proxies admitted before, excluding the inference relay. */
export function contactedHosts(db: Database, sessionId: string | null): string[] {
  if (!sessionId) return [];
  const rows = db.query(`SELECT DISTINCT json_extract(payload, '$.host') AS host FROM governance_events
    WHERE kind='egress_connection' AND session_id=? AND json_extract(payload, '$.outcome') <> 'denied'
      AND json_extract(payload, '$.inference') IS NULL`).all(sessionId) as { host: string }[];
  return rows.map(row => row.host);
}
