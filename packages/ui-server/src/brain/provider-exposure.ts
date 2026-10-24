/**
 * The durable record of which proven recipient each conversation showed which
 * provider folders to (#2695, ruling 2 of 2026-10-23). A conversation's
 * provider history keeps what its turns read and is never redacted, so the
 * record outlives the turn: admission refuses a later turn of the same
 * conversation, or the first turn of a handoff from it, whose recipient the
 * policy does not allow those folders.
 */
import type { Database } from "bun:sqlite";
import type { ProviderExposure } from "./governance-policy.js";

export interface ProviderExposures {
  /** Record what an admitted turn's recipient sees; `sessionId` is null until a new session is named. */
  record(turnId: string, sessionId: string | null, exposure: ProviderExposure): void;
  /** A new session was named: its turn's rows belong to it from now on. */
  bind(turnId: string, sessionId: string): void;
  /** Every exposure recorded for these sessions. */
  forSessions(sessionIds: readonly string[]): ProviderExposure[];
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
      db.query("UPDATE session_provider_exposure SET session_id = ? WHERE turn_id = ? AND session_id IS NULL").run(sessionId, turnId);
    },
    forSessions(sessionIds) {
      const ids = [...new Set(sessionIds)];
      if (!ids.length) return [];
      const rows = db.query(`SELECT recipient, visible, hidden FROM session_provider_exposure WHERE session_id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`)
        .all(...ids) as { recipient: string; visible: string; hidden: string }[];
      return rows.map(row => ({ recipient: row.recipient, visible: folders(row.visible), hidden: folders(row.hidden) }));
    },
  };
}
