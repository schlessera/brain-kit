/** Harness-only attribution from committed sequence deltas on each real record step. */
import type { Database } from "bun:sqlite";
import type { ObservationTrace, TraceStep } from "./observation-phases.js";
export interface RecordedWindow { turnId: string; before: number; after: number; changedPaths: number; startedAt: number; endedAt: number }
export function recordingCursors(db: Database): { turnId: string; sequence: number }[] {
  return db.query(`SELECT turn_id AS turnId,coalesce((SELECT max(sequence) FROM turn_journal_changes c WHERE c.turn_id=t.turn_id),0) AS sequence
    FROM turn_journal_turns t WHERE ended_at IS NULL`).all() as { turnId: string; sequence: number }[];
}
export function recordedWindows(db: Database, before: ReturnType<typeof recordingCursors>, startedAt: number, endedAt: number): RecordedWindow[] {
  return before.map(row => {
    const { after, changedPaths } = db.query(`SELECT coalesce(max(sequence),?) AS after,count(DISTINCT path) AS changedPaths
      FROM turn_journal_changes WHERE turn_id=? AND sequence>?`).get(row.sequence, row.turnId, row.sequence) as { after: number; changedPaths: number };
    return { turnId: row.turnId, before: row.sequence, after, changedPaths, startedAt, endedAt };
  });
}
export type RecordedTrace = ObservationTrace & { observations?: RecordedWindow[] };
/** Select the observations that actually committed this physical window's paths. */
export function observationWindowTrace(traces: RecordedTrace[], turnId: string, sample: { changedPaths: number; startedAt?: number; endedAt?: number }): ObservationTrace {
  if (sample.startedAt === undefined || sample.endedAt === undefined) throw new Error("PATH_MATRIX_PHYSICAL_WINDOW_MISSING");
  const start = sample.startedAt, end = sample.endedAt;
  const matching = traces.filter(trace => trace.observations?.some(row => row.turnId === turnId && row.startedAt >= start && row.endedAt <= end && (sample.changedPaths === 0 || row.changedPaths > 0)));
  if (!matching.length) throw new Error("PATH_MATRIX_RECORDING_TRACE_MISSING");
  const steps: TraceStep[] = [{ name: "hold", startedAt: start, endedAt: end }];
  for (const trace of matching) for (const step of trace.steps) if (step.name !== "hold" && step.name !== "hold_wait" && step.startedAt >= start && step.endedAt !== null && step.endedAt <= end) steps.push(step);
  return { kind: "physical_recording_window", turnId, steps };
}
