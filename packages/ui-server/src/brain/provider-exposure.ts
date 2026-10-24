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
import { maskedInBoth } from "./governance-policy.js";
import type { ProviderExposure } from "./governance-policy.js";

export interface ProviderExposures {
  /** Record what an admitted turn's recipient sees; `sessionId` is null until a new session is named. */
  record(turnId: string, sessionId: string | null, exposure: ProviderExposure): void;
  /** A new session was named: its turn's rows belong to it from now on. */
  bind(turnId: string, sessionId: string): void;
  /** Every exposure recorded for these sessions. */
  forSessions(sessionIds: readonly string[]): ProviderExposure[];
  /**
   * Start a lineage: a new conversation born masking `masked`, or a handoff
   * from one. Its row binds to the session once it is named.
   */
  startMasked(turnId: string, masked: readonly string[]): void;
  /** Narrow an existing session's lineage to what this turn masks as well; no lineage, no row. */
  narrowMasked(turnId: string, sessionId: string, masked: readonly string[]): void;
  /** The folders masked from every turn of this session; undefined when it has no lineage. */
  maskedThroughout(sessionId: string): string[] | undefined;
}

const folders = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) return parsed;
  } catch { /* refused below */ }
  throw new Error("A recorded provider exposure is unreadable; refusing rather than guessing what it showed");
};

export function createProviderExposures(db: Database): ProviderExposures {
  return {
    record(turnId, sessionId, exposure) {
      db.query(`INSERT INTO session_provider_exposure (turn_id, session_id, recipient, visible, hidden, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(turnId, sessionId, exposure.recipient, JSON.stringify(exposure.visible), JSON.stringify(exposure.hidden), Date.now());
    },
    bind(turnId, sessionId) {
      db.transaction(() => {
        db.query("UPDATE session_provider_exposure SET session_id = ? WHERE turn_id = ? AND session_id IS NULL").run(sessionId, turnId);
        db.query("UPDATE session_masked_lineage SET session_id = ? WHERE turn_id = ? AND session_id IS NULL").run(sessionId, turnId);
      })();
    },
    forSessions(sessionIds) {
      const ids = [...new Set(sessionIds)];
      if (!ids.length) return [];
      const rows = db.query(`SELECT recipient, visible, hidden FROM session_provider_exposure WHERE session_id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`)
        .all(...ids) as { recipient: string; visible: string; hidden: string }[];
      return rows.map(row => ({ recipient: row.recipient, visible: folders(row.visible), hidden: folders(row.hidden) }));
    },
    startMasked(turnId, masked) {
      db.query("INSERT INTO session_masked_lineage (turn_id, session_id, masked, recorded_at) VALUES (?, NULL, ?, ?)")
        .run(turnId, JSON.stringify([...masked]), Date.now());
    },
    narrowMasked(turnId, sessionId, masked) {
      // One row per session, narrowed in place: it never widens, and a lost
      // row is no lineage rather than an older, wider one.
      db.transaction(() => {
        const row = db.query("SELECT masked FROM session_masked_lineage WHERE session_id = ?").get(sessionId) as { masked: string } | null;
        if (!row) return;
        db.query("UPDATE session_masked_lineage SET turn_id = ?, masked = ?, recorded_at = ? WHERE session_id = ?")
          .run(turnId, JSON.stringify(maskedInBoth(folders(row.masked), masked)), Date.now(), sessionId);
      })();
    },
    maskedThroughout(sessionId) {
      const row = db.query("SELECT masked FROM session_masked_lineage WHERE session_id = ?").get(sessionId) as { masked: string } | null;
      return row ? folders(row.masked) : undefined;
    },
  };
}
