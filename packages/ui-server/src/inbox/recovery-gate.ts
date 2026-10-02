import type { Database } from "bun:sqlite";

/** Concrete dispatch guard, including a process restarted during restoration. */
export function assertInboxRecoveryReady(db: Database): void {
  if (db.query("SELECT 1 FROM inbox_recovery_state WHERE status = 'pending'").get())
    throw new Error("inbox_restore_pending");
}
