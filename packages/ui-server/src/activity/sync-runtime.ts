/**
 * What `/api/status` says about the runtime `brain sync` ran (#290), beside
 * chat's `runtime.lastObserved`. Read from the activity store, where both
 * scheduling paths record a sync run's root span — the in-process scheduler
 * and the container cron wrapper, which is another process — with the
 * attributes `syncActivityAttrs` writes.
 *
 * Two answers, kept apart so an old observation never reads as the latest
 * run's: `latest` is the most recent sync run and only what that run itself
 * recorded; `lastObserved` is the most recent run that recorded a runtime
 * version, with its own run id and times, and `latestRun` says whether it is
 * the same run.
 */
import type { Database } from "bun:sqlite";

import type { SpanOutcome } from "./store.js";

/** How the latest sync run stands on invoking an agent. */
export type SyncAgentState =
  /** The run has not ended; nothing is recorded yet. */
  | "pending"
  | "not-invoked"
  | "invoked"
  /** The run ended without a readable result: nothing is known. */
  | "unknown";

export interface SyncRunRuntime {
  runId: string;
  startedAt: string;
  endedAt: string | null;
  /** Null while the run is open. */
  outcome: SpanOutcome | null;
  agent: SyncAgentState;
  /** This run's own observation; null when it recorded none. */
  runtime: { name: string; version: string | null } | null;
}

export interface SyncRuntimeStatus {
  latest: SyncRunRuntime | null;
  lastObserved:
    | {
        runId: string;
        startedAt: string;
        endedAt: string | null;
        runtime: { name: string; version: string };
        /** Whether this is the latest sync run's own observation. */
        latestRun: boolean;
      }
    | null;
}

interface SpanRecord {
  run_id: string;
  started_at: number;
  ended_at: number | null;
  outcome: SpanOutcome | null;
  attrs: string | null;
}

const SYNC_ROOTS = `SELECT run_id, started_at, ended_at, outcome, attrs FROM activity_spans
  WHERE job_name = 'sync' AND kind = 'cron' AND parent_span_id IS NULL`;

function parseAttrs(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

function agentState(row: SpanRecord, attrs: Record<string, unknown>): SyncAgentState {
  const recorded = attrs["brain.sync.agent"];
  if (recorded === "not-invoked" || recorded === "invoked" || recorded === "unknown") return recorded;
  return row.outcome === null ? "pending" : "unknown";
}

/** The sync runtime status, from the activity store behind `db`. */
export function readSyncRuntime(db: Database): SyncRuntimeStatus {
  const latestRow = db.query(`${SYNC_ROOTS} ORDER BY started_at DESC LIMIT 1`).get() as SpanRecord | null;
  const observedRow = db
    .query(
      `${SYNC_ROOTS} AND json_extract(attrs, '$."brain.runtime.version"') IS NOT NULL
       AND json_extract(attrs, '$."brain.runtime.name"') IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`
    )
    .get() as SpanRecord | null;

  let latest: SyncRunRuntime | null = null;
  if (latestRow) {
    const attrs = parseAttrs(latestRow.attrs);
    const name = text(attrs["brain.runtime.name"]);
    latest = {
      runId: latestRow.run_id,
      startedAt: iso(latestRow.started_at)!,
      endedAt: iso(latestRow.ended_at),
      outcome: latestRow.outcome,
      agent: agentState(latestRow, attrs),
      runtime: name ? { name, version: text(attrs["brain.runtime.version"]) } : null,
    };
  }

  let lastObserved: SyncRuntimeStatus["lastObserved"] = null;
  if (observedRow) {
    const attrs = parseAttrs(observedRow.attrs);
    const name = text(attrs["brain.runtime.name"]);
    const version = text(attrs["brain.runtime.version"]);
    if (name && version) {
      lastObserved = {
        runId: observedRow.run_id,
        startedAt: iso(observedRow.started_at)!,
        endedAt: iso(observedRow.ended_at),
        runtime: { name, version },
        latestRun: observedRow.run_id === latestRow?.run_id,
      };
    }
  }
  return { latest, lastObserved };
}
