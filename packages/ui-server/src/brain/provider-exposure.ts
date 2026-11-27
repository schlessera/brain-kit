/**
 * The durable record of which proven recipient each conversation showed which
 * provider folders to (#2695, ruling 2 of 2026-10-23). A conversation's
 * provider history keeps what its turns read and is never redacted, so the
 * record outlives the turn: admission refuses a later turn of the same
 * conversation, or the first turn of a handoff from it, whose recipient the
 * policy does not allow those folders.
 *
 * It also keeps a born-masked conversation's lineage (#2726): the folders every
 * one of its turns masked, narrowed in place by each. A conversation without
 * one has no proof its history lacks a provider folder, so a turn masking any
 * folder refuses to continue it.
 */
import type { Database } from "bun:sqlite";
import type { ProviderExposure } from "./governance-policy.js";
import { procedureCaller, trackedCaller, type SqliteWriter } from "../db/write-worker.js";
import { url as GOVERNED_TURN_WRITES, setup as governedTurnWriteSetup } from "./governed-turn-writes.js";
import { folders } from "./exposure-writers.js";

export interface ProviderExposures {
  /** Record what an admitted turn's recipient sees; `sessionId` is null until a new session is named. */
  record(turnId: string, sessionId: string | null, exposure: ProviderExposure): Promise<void>;
  /** A new session was named: its turn's rows belong to it from now on. */
  bind(turnId: string, sessionId: string): Promise<void>;
  /** Every exposure recorded for these sessions. */
  forSessions(sessionIds: readonly string[]): ProviderExposure[];
  /**
   * Start a lineage: a new conversation born masking `masked`, or a handoff
   * from one. Its row binds to the session once it is named.
   */
  startMasked(turnId: string, masked: readonly string[]): Promise<void>;
  /** Narrow an existing session's lineage to what this turn masks as well; no lineage, no row. */
  narrowMasked(turnId: string, sessionId: string, masked: readonly string[]): Promise<void>;
  /** The folders masked from every turn of this session; undefined when it has no lineage. */
  maskedThroughout(sessionId: string): string[] | undefined;
  /**
   * Settles once every write submitted before it has settled (#2850): a read
   * that must see this session's latest exposures awaits it.
   */
  settled(): Promise<void>;
}

/**
 * Exposures read on `db`; every write commits on `writer` when there is one
 * (#2850), else on `db` at once. Each write settles once committed, and
 * `settled()` once every write submitted before it has.
 */
export function createProviderExposures(db: Database, writer?: SqliteWriter): ProviderExposures {
  const writes = trackedCaller(procedureCaller(db, { url: GOVERNED_TURN_WRITES, setup: governedTurnWriteSetup }, undefined, writer));
  const submit = (name: string, ...args: unknown[]): Promise<void> => writes.call<void>(name, ...args);
  return {
    record: (turnId, sessionId, exposure) => submit("exposureRecord", turnId, sessionId, exposure, Date.now()),
    bind: (turnId, sessionId) => submit("exposureBind", turnId, sessionId),
    forSessions(sessionIds) {
      const ids = [...new Set(sessionIds)];
      if (!ids.length) return [];
      const rows = db.query(`SELECT recipient, visible, hidden FROM session_provider_exposure WHERE session_id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`)
        .all(...ids) as { recipient: string; visible: string; hidden: string }[];
      return rows.map(row => ({ recipient: row.recipient, visible: folders(row.visible), hidden: folders(row.hidden) }));
    },
    startMasked: (turnId, masked) => submit("exposureStartMasked", turnId, [...masked], Date.now()),
    narrowMasked: (turnId, sessionId, masked) => submit("exposureNarrowMasked", turnId, sessionId, [...masked], Date.now()),
    maskedThroughout(sessionId) {
      const row = db.query("SELECT masked FROM session_masked_lineage WHERE session_id = ?").get(sessionId) as { masked: string } | null;
      return row ? folders(row.masked) : undefined;
    },
    settled: writes.settled,
  };
}
