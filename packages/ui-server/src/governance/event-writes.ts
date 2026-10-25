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
import { insertFirstTaint, sessionTaint, type SessionTaint } from "./session-taint.js";

export const url = import.meta.url;

/** Worker side: every procedure is one of the synchronous writers, run on the write connection. */
export function setup(db: Database): WriteProcedures {
  return {
    record: (row: GovernanceEventRow) => insertGovernanceEvent(db, row),
    firstTaint: (row: GovernanceEventRow) => insertFirstTaint(db, row),
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
  /** The session's first taint, checked and stored in one transaction; whether this call stored it. Validates now. */
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
  const pendingTaints = new Set<{ turnId: string | null; sessionId: string | null; source: SessionTaint["source"] }>();
  return {
    record: input => call<{ id: number; recorded: boolean }>("record", governanceEventRow(input)),
    firstTaint: input => {
      const row = governanceEventRow(input);
      const pending = { turnId: row.turnId, sessionId: row.sessionId, source: input.payload.source };
      pendingTaints.add(pending);
      const stored = call<boolean>("firstTaint", row);
      void stored.finally(() => pendingTaints.delete(pending)).catch(() => {});
      return stored;
    },
    taint(turnId, sessionId) {
      const committed = sessionTaint(db, turnId, sessionId);
      if (committed) return committed;
      for (const pending of pendingTaints) {
        if ((turnId !== null && pending.turnId === turnId) || (sessionId !== null && pending.sessionId === sessionId)) return { eventId: 0, source: pending.source };
      }
      return null;
    },
    bind: (turnId, sessionId) => call<number>("bind", turnId, sessionId),
    roadblocks: (attribution, trace) => call<number>("roadblocks", attribution, trace),
    replaySteering: () => call<number>("replaySteering"),
  };
}
