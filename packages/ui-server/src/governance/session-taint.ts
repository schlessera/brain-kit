/** A session's untrusted-input state (G6), read from and written to its durable governance record. */
import { canonicalEgressHost } from "@schlessera/brain-ui-sdk/internal";
import { safetyProjection } from "./safety-store.js";
import type { Database } from "bun:sqlite";
import { GOVERNANCE_EVENT_SCHEMAS, type GovernanceEventInput, type GovernanceEventPayload } from "./events.js";

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
 * Hosts the session's turn proxies admitted before, except a connection a
 * scoped tainted Network approval admitted (#3595), whose grant is its own
 * record (`networkGrants`), excluding inference,
 * provider and managed-reference host operations, whose
 * host never becomes one the worker's own traffic may reach once tainted, in
 * any turn (#3246). The proxy charges bytes only after admission, so a charged
 * record is admission evidence whatever its final outcome; an attempt
 * cancelled or refused before admission never counts.
 */
export function contactedHosts(db: Database, sessionId: string | null): string[] {
  if (!sessionId) return [];
  const rows = db.query(`SELECT DISTINCT json_extract(payload, '$.host') AS host FROM governance_events
    WHERE kind='egress_connection' AND session_id=? AND json_extract(payload, '$.bytes') > 0
      AND coalesce(json_extract(payload, '$.dispatched'), 1) = 1
      AND json_extract(payload, '$.inference') IS NULL AND json_extract(payload, '$.provider') IS NULL
      AND json_extract(payload, '$.managedReference') IS NULL
      AND json_extract(payload, '$.networkScope') IS NULL
      AND (json_extract(payload, '$.recipientApproved') = 1 OR
        (json_extract(payload, '$.trustedSource') IS NULL AND json_extract(payload, '$.standingRecipient') IS NULL))`).all(sessionId) as { host: string }[];
  return [...new Set(rows.map(row => canonicalEgressHost(row.host)))];
}

/** The key one origin grant is held under: transport, canonical host and effective port. */
export const networkOriginKey = (origin: { transport: "http" | "connect"; host: string; port: number }) =>
  JSON.stringify([origin.transport, canonicalEgressHost(origin.host), origin.port]);

export type NetworkGrantRecord = GovernanceEventPayload<"network_grant">;
/**
 * One stored `network_grant` row as the reader understands it: an unknown
 * version or a payload that fails its schema is null, never guessed.
 */
export function parseNetworkGrant(row: { schema_version: number; payload: string }): NetworkGrantRecord | null {
  const spec = GOVERNANCE_EVENT_SCHEMAS.network_grant;
  if (row.schema_version !== spec.version) return null;
  let payload: unknown;
  try { payload = JSON.parse(row.payload); } catch { return null; }
  const parsed = spec.payload.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

/**
 * The explicit wider Network grants the session holds (#3595), read from its
 * own durable `network_grant` records. A grant is two rows with the same
 * card, scope and origin: the `proposed` row the writer committed before the
 * card settled, and the `settled` row its settlement submitted. Neither
 * grants anything alone. A connection admitted once, or under one of these
 * grants, is never a contacted host (`contactedHosts`).
 */
export function networkGrants(db: Database, sessionId: string | null): { session: boolean; origins: Set<string> } {
  const grants = { session: false, origins: new Set<string>() };
  if (!sessionId) return grants;
  const rows = db.query("SELECT schema_version, payload FROM governance_events WHERE kind='network_grant' AND session_id=?").all(sessionId) as { schema_version: number; payload: string }[];
  const states = new Map<string, Set<NetworkGrantRecord["state"]>>();
  const identity = (grant: NetworkGrantRecord) => JSON.stringify([grant.toolUseId, grant.scope, grant.transport ?? null, grant.host ?? null, grant.port ?? null]);
  for (const row of rows) {
    const grant = parseNetworkGrant(row);
    if (!grant) continue;
    const key = identity(grant);
    const seen = states.get(key) ?? new Set();
    seen.add(grant.state); states.set(key, seen);
    if (!seen.has("proposed") || !seen.has("settled")) continue;
    if (grant.scope === "session") grants.session = true;
    else if (grant.transport && grant.host && grant.port) grants.origins.add(networkOriginKey({ transport: grant.transport, host: grant.host, port: grant.port }));
  }
  return grants;
}
