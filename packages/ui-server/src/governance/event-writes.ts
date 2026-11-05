/**
 * Governance event writes off the event loop (#2850). The hosted server's
 * app connection never commits a governance event itself: each one is
 * validated where it is raised, then committed on the `ui.db` write worker at
 * `synchronous=FULL`, in submission order with the journal's and Activity's
 * writes. An event the journal records inside its own transaction stays
 * there (`brain/journal-store.ts`).
 */
import type { Database } from "bun:sqlite";

import { procedureCaller, type SqliteWriter, type WriteProcedures } from "../db/write-worker.js";
import { replaySteeringEvents } from "../brain/journal-governance.js";
import { bindTurnEvents, governanceEventRow, insertGovernanceEvent, type GovernanceEventInput, type GovernanceEventRow } from "./events.js";
import { recordTurnRoadblocks, type RoadblockAttribution, type TurnTrace } from "./roadblocks.js";
import { sessionTaint, type SessionTaint } from "./session-taint.js";

export const url = import.meta.url;

/** Worker side: every procedure is one of the synchronous writers, run on the write connection. */
export function setup(db: Database): WriteProcedures {
  return {
    record: (row: GovernanceEventRow) => insertGovernanceEvent(db, row),
    bind: (turnId: string, sessionId: string) => bindTurnEvents(db, turnId, sessionId),
    // Classification reads the turn's earlier events on the same connection,
    // after every event submitted before it has committed.
    roadblocks: (attribution: RoadblockAttribution, trace: TurnTrace) => recordTurnRoadblocks(db, attribution, trace),
    replaySteering: () => replaySteeringEvents(db),
  };
}

export interface GovernanceWrites {
  /**
   * Validates now, throwing `GovernanceEventError` as the synchronous writer
   * did; the returned promise settles once the row commits, or with the
   * database failure.
   */
  record(input: GovernanceEventInput): Promise<{ id: number; recorded: boolean }>;
  /** Stores every distinct occurrence; only the exact host key deduplicates. Historical internal method name. */
  firstTaint(input: GovernanceEventInput<"taint">): Promise<boolean>;
  /**
   * The session's first taint (G6) as admission must see it: the committed
   * one, else one submitted and not yet committed. A pending taint has no row
   * id yet (`eventId` 0). Taint is sticky, so a taint that later fails to
   * commit stops its turn rather than loosening anything.
   */
  taint(turnId: string | null, sessionId: string | null): SessionTaint | null;
  /** Attaches a turn's session-less events to its session once its catalog row exists. */
  bind(turnId: string, sessionId: string): Promise<number>;
  /** Classifies a finished turn against its committed events and stores its roadblocks. */
  roadblocks(attribution: RoadblockAttribution, trace: TurnTrace): Promise<number>;
  /** Records any `steering_change` event a journal steering change lacks (#2789). */
  replaySteering(): Promise<number>;
}

/** The app side: every write commits on `writer` when there is one, else on `db` at once. */
export function createGovernanceWrites(db: Database, writer?: SqliteWriter): GovernanceWrites {
  const call = procedureCaller(db, { url, setup }, undefined, writer);
  const pendingTaints = new Set<{ turnId: string | null; sessionId: string | null; source: SessionTaint["source"]; bytes: number }>();
  // Failed writes remain restrictive for this writer's lifetime. Durable
  // restart recovery is a separate coverage obligation, never inferred here.
  let pendingBytes = 0;
  let failedClosed = false;
  const record = (input: GovernanceEventInput): Promise<{ id: number; recorded: boolean }> => {
    const row = governanceEventRow(input);
    if (input.kind !== "taint") return call("record", row);
    if (failedClosed) throw new Error("Safety occurrence writer requires recovery");
    const bytes = Buffer.byteLength(JSON.stringify(row));
    const session = [...pendingTaints].filter(p => row.sessionId !== null ? p.sessionId === row.sessionId : p.turnId === row.turnId);
    if (pendingTaints.size >= 4096 || pendingBytes + bytes > 16777216 || session.length >= 256
      || session.reduce((sum, p) => sum + p.bytes, 0) + bytes > 1048576) {
      failedClosed = true;
      throw new Error("Safety occurrence write capacity exceeded; ingestion must stop");
    }
    const pending = { turnId: row.turnId, sessionId: row.sessionId, source: (input as GovernanceEventInput<"taint">).payload.source, bytes };
    pendingTaints.add(pending); pendingBytes += bytes;
    const stored = call<{ id: number; recorded: boolean }>("record", row);
    void stored.then(() => {}, () => { failedClosed = true; })
      .finally(() => { pendingTaints.delete(pending); pendingBytes -= bytes; });
    return stored;
  };
  return {
    record,
    firstTaint: input => record(input).then(result => result.recorded),
    taint(turnId, sessionId) {
      if (failedClosed) return { eventId: 0, source: "legacy_unknown" };
      const committed = sessionTaint(db, turnId, sessionId);
      if (committed) return committed;
      for (const pending of pendingTaints) {
        if ((turnId !== null && pending.turnId === turnId) || (sessionId !== null && pending.sessionId === sessionId)) return { eventId: 0, source: pending.source };
      }
      return null;
    },
    bind: async (turnId, sessionId) => {
      const bound = await call<number>("bind", turnId, sessionId);
      for (const pending of pendingTaints) if (pending.turnId === turnId) pending.sessionId = sessionId;
      return bound;
    },
    roadblocks: (attribution, trace) => call<number>("roadblocks", attribution, trace),
    replaySteering: () => call<number>("replaySteering"),
  };
}
