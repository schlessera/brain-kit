/** A session's untrusted-input state (G6), read from and written to its durable governance record. */
import { safetyProjection } from "./safety-store.js";
import type { Database } from "bun:sqlite";
import type { GovernanceEventInput, GovernanceEventPayload } from "./events.js";

export type TaintSource = GovernanceEventPayload<"taint">["source"];
export interface SessionTaint { eventId: number; source: TaintSource }

/** Admission reads the complete durable aggregate, including coverage and failure. */
export function sessionTaint(db: Database, turnId: string | null, sessionId: string | null): SessionTaint | null {
  const projection=safetyProjection(db,turnId,sessionId);
  if(projection.restriction==="normal")return null;
  const row=projection.earliestUnresolvedId?db.query(`SELECT g.id,r.source FROM safety_records r
    LEFT JOIN safety_legacy_events m ON m.record_id=r.id LEFT JOIN governance_events g ON g.id=m.event_id WHERE r.id=?`)
    .get(projection.earliestUnresolvedId) as {id:number|null;source:TaintSource}|null:null;
  return {eventId:row?.id??0,source:row?.source??"legacy_unknown"};
}

/** Records one occurrence. Historical name retained for internal callers during rollout.
 * Deduplication belongs to the host occurrence key, never to a session/source. */
export function recordFirstTaint(db: Database, event: GovernanceEventInput<"taint">,
  record: (event: GovernanceEventInput<"taint">) => unknown): void {
  db.transaction(() => { record(event); })();
}

/**
 * Hosts the session's turn proxies admitted before, excluding both host
 * relays: the inference relay and a validated provider-relay operation, whose
 * host never becomes one the worker's own traffic may reach once tainted, in
 * any turn (#3246). The proxy charges bytes only after admission, so a charged
 * record is admission evidence whatever its final outcome; an attempt
 * cancelled or refused before admission never counts.
 */
export function contactedHosts(db: Database, sessionId: string | null): string[] {
  if (!sessionId) return [];
  const rows = db.query(`SELECT DISTINCT json_extract(payload, '$.host') AS host FROM governance_events
    WHERE kind='egress_connection' AND session_id=? AND json_extract(payload, '$.bytes') > 0
      AND json_extract(payload, '$.inference') IS NULL AND json_extract(payload, '$.provider') IS NULL`).all(sessionId) as { host: string }[];
  return rows.map(row => row.host);
}
