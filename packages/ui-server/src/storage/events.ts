/**
 * Bounded storage events timeline (#4541). Each fact is written once, at its
 * source, in the same transaction that changes the state it describes. A kind
 * that reaches its limit stops recording and keeps every earlier event; nothing
 * is updated or deleted afterwards. Operational state, never `brain.db`.
 */
import type { Database } from "bun:sqlite";
import type { StorageEvent, StorageEventKind, StorageEventsResponse } from "@schlessera/brain-ui-sdk/protocol";
import type { Pressure, Refusal } from "./pressure.js";

/**
 * Worst-case encoded bytes per event (16-digit `seq`, `at` and `episode`,
 * longest phase and value, a 96-character receipt identity and a 64-character
 * reason, plus a comma): pressure 187, refusal 195, scope 228, maintenance 323.
 * 256·187 + 128·195 + 64·228 + 512·323 = 252,800 bytes of events, which leaves
 * room for the envelope under the 262,144-byte payload cap. A maintenance run
 * records two events, so 512 cover 256 runs.
 */
export const STORAGE_EVENT_LIMITS = Object.freeze({ pressure: 256, refusal: 128, scope: 64, maintenance: 512, payloadBytes: 262_144 } as const);
const KINDS = ["pressure", "refusal", "scope", "maintenance"] as const satisfies readonly StorageEventKind[];
const REASON_CHARACTERS = 64;

interface Recorded {
  kind: StorageEventKind; phase: StorageEvent["phase"]; at: number;
  identity?: string; severity?: Pressure["severity"]; episode?: number;
  target?: string; resource?: Refusal["resource"]; rootScope?: string; previousRootScope?: string;
  receipt?: string; operation?: string; state?: string; reason?: string | null; principal?: string;
}
type Row = { seq: number; kind: StorageEventKind; phase: string; at: number; identity: string | null; severity: Pressure["severity"] | null; episode: number | null;
  target: string | null; resource: Refusal["resource"] | null; root_scope: string | null; previous_root_scope: string | null;
  receipt: string | null; operation: string | null; state: string | null; reason: string | null };

/** Returns the new `seq`, or null when the kind is full and recording is paused. */
export function recordStorageEvent(db: Database, brain: string, event: Recorded): number | null {
  const { total } = db.query("SELECT count(*) AS total FROM storage_events WHERE brain = ? AND kind = ?").get(brain, event.kind) as { total: number };
  if (total >= STORAGE_EVENT_LIMITS[event.kind]) return null;
  const result = db.query(`INSERT INTO storage_events (brain, kind, phase, at, identity, severity, episode, target, resource, root_scope, previous_root_scope, receipt, operation, state, reason, principal_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(brain, event.kind, event.phase, event.at, event.identity ?? null, event.severity ?? null, event.episode ?? null,
    event.target ?? null, event.resource ?? null, event.rootScope ?? null, event.previousRootScope ?? null, event.receipt ?? null, event.operation ?? null,
    event.state ?? null, event.reason?.slice(0, REASON_CHARACTERS) ?? null, event.principal ?? null);
  return Number(result.lastInsertRowid);
}

/**
 * Records a pressure change at `at`, the time of the evidence or owner report
 * that caused it. Steps, recoveries and ends are recorded only inside an
 * episode whose start was recorded, so an episode already open when recording
 * began never appears (#4541 ruling 3).
 */
export function recordPressureChange(db: Database, brain: string, before: Pressure, after: Pressure, at: number): void {
  const open = () => {
    const last = db.query("SELECT seq, phase, episode FROM storage_events WHERE brain = ? AND kind = 'pressure' AND identity = ? ORDER BY seq DESC LIMIT 1").get(brain, after.identity) as { seq: number; phase: string; episode: number | null } | null;
    return last && last.phase !== "end" ? { phase: last.phase, episode: last.episode ?? last.seq } : null;
  };
  const base = { kind: "pressure" as const, identity: after.identity, severity: after.severity };
  if (before.severity !== after.severity) {
    if (before.severity === "observed") { recordStorageEvent(db, brain, { ...base, phase: "start", at }); return; }
    const episode = open();
    if (episode) recordStorageEvent(db, brain, { ...base, phase: after.severity === "observed" ? "end" : "step", at, episode: episode.episode });
    return;
  }
  // One event per recovery attempt that follows a start or step; a recovery
  // that is reset and restarted at the same severity is the same attempt.
  if (after.severity !== "observed" && before.recoveryAt === null && after.recoveryAt !== null) {
    const episode = open();
    if (episode && episode.phase !== "recovery-started") recordStorageEvent(db, brain, { ...base, phase: "recovery-started", at: after.recoveryAt, episode: episode.episode });
  }
}

/**
 * Records a refusal entering the refused state, or the success that resolves it.
 * Repeats are one event. `at` is the first refusal of a coalesced run.
 */
export function recordRefusalChange(db: Database, brain: string, before: Pressure, after: Pressure, report: { target: string; resource: Refusal["resource"]; at: number; outcome: "no-space" | "success" }, at = report.at): void {
  const find = (pressure: Pressure) => pressure.refusals.find(value => value.target === report.target && value.resource === report.resource);
  const previous = find(before), next = find(after);
  const base = { kind: "refusal" as const, identity: after.identity, target: report.target, resource: report.resource, at };
  if (report.outcome === "no-space" && next?.at === report.at && next.successAt === null && (!previous || previous.successAt !== null)) recordStorageEvent(db, brain, { ...base, phase: "refused" });
  // A resolution needs its recorded refusal; one open before the timeline is omitted.
  else if (report.outcome === "success" && previous && previous.successAt === null && next?.successAt === report.at
    && (db.query("SELECT phase FROM storage_events WHERE brain = ? AND kind = 'refusal' AND identity = ? AND target = ? AND resource = ? ORDER BY seq DESC LIMIT 1")
      .get(brain, after.identity, report.target, report.resource) as { phase: string } | null)?.phase === "refused") recordStorageEvent(db, brain, { ...base, phase: "succeeded" });
}

const TRACKED_SCOPES = 16;
/**
 * Records a capacity's new store scope against the scope it was last observed
 * with, which is tracked on every observation (#4541). A warning's pressure
 * keeps its original scope, and its changed flag moves only with fresh evidence,
 * so neither is the predecessor. The first observation after recording began
 * only sets the starting scope: a change from older state has no known time.
 */
export function recordScopeChange(db: Database, brain: string, identity: string, rootScope: string, at: number): void {
  const known = (db.query("SELECT root_scope FROM storage_event_scopes WHERE brain = ? AND identity = ?").get(brain, identity) as { root_scope: string } | null)?.root_scope;
  if (known !== undefined && known !== rootScope) recordStorageEvent(db, brain, { kind: "scope", phase: "changed", identity, rootScope, previousRootScope: known, at });
  db.query("INSERT INTO storage_event_scopes (brain, identity, root_scope, at) VALUES (?, ?, ?, ?) ON CONFLICT (brain, identity) DO UPDATE SET root_scope = excluded.root_scope, at = excluded.at").run(brain, identity, rootScope, at);
  db.query("DELETE FROM storage_event_scopes WHERE brain = ? AND identity NOT IN (SELECT identity FROM storage_event_scopes WHERE brain = ? ORDER BY at DESC, identity LIMIT ?)").run(brain, brain, TRACKED_SCOPES);
}

function project(row: Row): StorageEvent {
  const base = { seq: row.seq, at: row.at };
  if (row.kind === "pressure") return { ...base, kind: "pressure", identity: row.identity!, phase: row.phase as "start", severity: row.severity!, episode: row.episode ?? row.seq };
  if (row.kind === "refusal") return { ...base, kind: "refusal", identity: row.identity!, phase: row.phase as "refused", target: row.target!, resource: row.resource! };
  if (row.kind === "scope") return { ...base, kind: "scope", identity: row.identity!, phase: "changed", rootScope: row.root_scope!, previousRootScope: row.previous_root_scope! };
  const maintenance = { ...base, kind: "maintenance" as const, receipt: row.receipt!, operation: row.operation as "pack-git" };
  return row.phase === "requested" ? { ...maintenance, phase: "requested" }
    : { ...maintenance, phase: "finished", state: row.state as "complete", reason: row.reason };
}

/**
 * Reads events after `since` in recording order. Pressure, refusal and scope
 * events belong to the brain; maintenance events belong to the principal that
 * requested the run, like its receipts.
 */
export function readStorageEvents(db: Database, brain: string, principal: string, query: { identity?: string; since?: number } = {}): StorageEventsResponse {
  const since = query.since ?? 0, identity = query.identity ?? null;
  const rows = db.query(`SELECT seq, kind, phase, at, identity, severity, episode, target, resource, root_scope, previous_root_scope, receipt, operation, state, reason
    FROM storage_events WHERE brain = ? AND seq > ? AND (principal_id IS NULL OR principal_id = ?) AND (? IS NULL OR identity IS NULL OR identity = ?) ORDER BY seq`)
    .all(brain, since, principal, identity, identity) as Row[];
  const totals = new Map((db.query("SELECT kind, count(*) AS total FROM storage_events WHERE brain = ? GROUP BY kind").all(brain) as Array<{ kind: StorageEventKind; total: number }>).map(row => [row.kind, row.total]));
  const events = rows.map(project);
  return { version: 1, since, next: events.at(-1)?.seq ?? since, limits: { ...STORAGE_EVENT_LIMITS },
    paused: Object.fromEntries(KINDS.map(kind => [kind, (totals.get(kind) ?? 0) >= STORAGE_EVENT_LIMITS[kind]])) as Record<StorageEventKind, boolean>, events };
}
