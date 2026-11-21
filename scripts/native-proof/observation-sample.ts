import type { Database } from "bun:sqlite";
export function observationCursor(db: Database, turnId: string): number {
  return (db.query("SELECT coalesce(max(sequence),0) AS n FROM turn_journal_changes WHERE turn_id=?").get(turnId) as { n: number }).n;
}
/** Count the recorded window, including repeated versions only once per path. */
export function observationSample(db: Database, turnId: string, before: number, requestedPaths: number,
  sample: number, toolUseId: string, physical: { frozenMs: number; sharedHold: boolean }) {
  const changedPaths = (db.query("SELECT count(DISTINCT path) AS n FROM turn_journal_changes WHERE turn_id=? AND sequence>?").get(turnId, before) as { n: number }).n;
  return { changedPaths, requestedPaths, sample, toolUseId, ...physical };
}

/** Periodic overlap does not invalidate a confirmed physical hold's measured paths. */
export const observationSampleAccepted = (sample: { changedPaths: number; requestedPaths: number }) => sample.changedPaths === sample.requestedPaths;
