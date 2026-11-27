/** Provider-exposure rows and their synchronous writers (#2695, #2726), shared by the host and its write procedures (#4818). */
import type { Database } from "bun:sqlite";
import { maskedInBoth } from "./governance-policy.js";
import type { ProviderExposure } from "./governance-policy.js";

export const folders = (raw: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) return parsed;
  } catch { /* refused below */ }
  throw new Error("A recorded provider exposure is unreadable; refusing rather than guessing what it showed");
};

/** The synchronous writers, run on whichever connection commits them. */
export function exposureWriters(db: Database) {
  return {
    record(turnId: string, sessionId: string | null, exposure: ProviderExposure, at: number) {
      db.query(`INSERT INTO session_provider_exposure (turn_id, session_id, recipient, visible, hidden, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(turnId, sessionId, exposure.recipient, JSON.stringify(exposure.visible), JSON.stringify(exposure.hidden), at);
    },
    bind(turnId: string, sessionId: string) {
      db.transaction(() => {
        db.query("UPDATE session_provider_exposure SET session_id = ? WHERE turn_id = ? AND session_id IS NULL").run(sessionId, turnId);
        db.query("UPDATE session_masked_lineage SET session_id = ? WHERE turn_id = ? AND session_id IS NULL").run(sessionId, turnId);
      })();
    },
    startMasked(turnId: string, masked: readonly string[], at: number) {
      db.query("INSERT INTO session_masked_lineage (turn_id, session_id, masked, recorded_at) VALUES (?, NULL, ?, ?)")
        .run(turnId, JSON.stringify([...masked]), at);
    },
    narrowMasked(turnId: string, sessionId: string, masked: readonly string[], at: number) {
      // One row per session, narrowed in place: it never widens, and a lost
      // row is no lineage rather than an older, wider one.
      db.transaction(() => {
        const row = db.query("SELECT masked FROM session_masked_lineage WHERE session_id = ?").get(sessionId) as { masked: string } | null;
        if (!row) return;
        db.query("UPDATE session_masked_lineage SET turn_id = ?, masked = ?, recorded_at = ? WHERE session_id = ?")
          .run(turnId, JSON.stringify(maskedInBoth(folders(row.masked), masked)), at, sessionId);
      })();
    },
  };
}
