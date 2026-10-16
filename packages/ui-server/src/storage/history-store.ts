import { z } from "zod";
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { capacityEvidence } from "./history-evidence.js";
import { newPressure, observePressure, ownerWrite, type Pressure, type Refusal } from "./pressure.js";
import { HISTORY_LIMITS, bucket, hashScope, jsonBytes, retainAggregate, validateHistory, type Aggregate, type HistoryPayload } from "./history-model.js";
export interface HistoryState {
  version: 1; salt: string;
  lastPersistedAt: number; lastObservedAt: number; lastAttemptBucket: number | null;
  paused: "collection-unavailable" | "clock-reversal" | "history-owner-evidence-budget" | null;
  pressures: Pressure[];
  /** Restoring an old backup cannot revive authority to send its old episodes. */
  suppressedEpisodes: string[];
  scopeLimit: boolean;
}
export type StoredHistory = HistoryPayload<HistoryState>;
type Pending = { kind: "aggregate"; value: Aggregate } | { kind: "failure"; at: number };
export interface StorageWriteReport { identity: string; rootScope: string; target: string; resource: Refusal["resource"]; at: number; outcome: "no-space" | "success" }
export const storageBrainKey = (brainPath: string) => hashScope(realpathSync(brainPath));
export function emptyHistory(): StoredHistory {
  return { metadata: { samples: {}, capacities: {}, state: { version: 1, salt: randomBytes(32).toString("hex"), lastPersistedAt: 0, lastObservedAt: 0, lastAttemptBucket: null, paused: null, pressures: [], suppressedEpisodes: [], scopeLimit: false } }, samples: [] };
}
const instant = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{32}$/);
const pressureSchema = z.object({
  identity: digest, rootScope: digest, severity: z.enum(["observed", "low", "critical"]),
  capacity: z.boolean(), forecast: z.boolean(), refusals: z.array(z.object({
    target: digest, resource: z.enum(["bytes", "quota", "inodes", "unknown"]), at: instant, successAt: instant.nullable(),
  }).strict()), at: instant, recoveryAt: instant.nullable(), episode: z.string().uuid().nullable(),
  resolvedEpisode: z.string().uuid().nullable(), supportAt: instant.nullable(), scopeChanged: z.boolean(),
}).strict().refine(value => (value.severity === "critical") === (value.episode !== null)
  && (value.severity !== "observed" || !value.capacity && !value.forecast && !value.refusals.length)
  && new Set(value.refusals.map(row => row.target + ":" + row.resource)).size === value.refusals.length);
const stateSchema = z.object({
  version: z.literal(1), salt: z.string().regex(/^[a-f0-9]{64}$/), lastPersistedAt: instant,
  lastObservedAt: instant, lastAttemptBucket: instant.nullable(), paused: z.enum(["collection-unavailable", "clock-reversal", "history-owner-evidence-budget"]).nullable(),
  pressures: z.array(pressureSchema).max(4), suppressedEpisodes: z.array(z.string().uuid()).max(8), scopeLimit: z.boolean(),
}).strict().refine(value => new Set(value.pressures.map(row => row.identity)).size === value.pressures.length);
export function parseStoredHistory(value: string): StoredHistory {
  const result = JSON.parse(value) as StoredHistory;
  validateHistory(result);
  stateSchema.parse(result.metadata.state);
  return result;
}
export function readStoredHistory(db: Database, brain: string): StoredHistory | null {
  const row = db.query("SELECT payload_json FROM storage_history WHERE brain = ?").get(brain) as { payload_json: string } | null;
  return row ? parseStoredHistory(row.payload_json) : null;
}
export function createStorageHistory(db: Database, brainPath: string, options: { now?: () => number } = {}) {
  const brain = storageBrainKey(brainPath), now = options.now ?? Date.now;
  const initial = emptyHistory();
  let pending: Pending | null = null, unavailable: string | null = null, closed = false;
  let pendingWrites: StorageWriteReport[] = [], interrupted = false, ownerOverflow = false;
  // Constructing the store never collects filesystem inventory. Failure here is
  // a capability result; it cannot prevent existing recovery operations booting.
  const initialize = () => db.query("INSERT OR IGNORE INTO storage_history (brain, payload_json) VALUES (?, ?)").run(brain, JSON.stringify(initial));
  try { initialize(); }
  catch { unavailable = "history-write-unavailable"; }
  const read = () => {
    try { return readStoredHistory(db, brain); }
    catch { unavailable = "history-read-unavailable"; return null; }
  };
  function offer(value: Pending) {
    if (closed) return;
    const at = value.kind === "aggregate" ? value.value.at : value.at;
    const stored = read();
    if (stored && at < stored.metadata.state.lastObservedAt) {
      unavailable = "history-clock-reversal";
      interrupted = true;
      // Do not overwrite a newer pending observation after a clock reversal.
      return;
    }
    const prior = pending && (pending.kind === "aggregate" ? pending.value.at : pending.at);
    if (prior === null || prior <= at) pending = value;
    flush();
  }
  function flush(): boolean {
    if (closed || !pending && !pendingWrites.length) return false;
    const candidate = pending, writes = pendingWrites, time = now();
    const at = Math.max(candidate ? candidate.kind === "aggregate" ? candidate.value.at : candidate.at : 0, ...writes.map(row => row.at));
    try {
      const changed = db.transaction(() => {
        initialize();
        const previous = readStoredHistory(db, brain);
        if (!previous) throw Error("history-unavailable");
        const state = previous.metadata.state;
        const ownerEvidenceLost = ownerOverflow || state.paused === "history-owner-evidence-budget";
        if (time < state.lastPersistedAt || at < state.lastObservedAt || at > time) throw Error("history-clock-reversal");
        if (time - state.lastPersistedAt < HISTORY_LIMITS.writeInterval) return false;
        let next: StoredHistory;
        if (interrupted || ownerEvidenceLost) state.pressures = state.pressures.map(value => ({ ...value, recoveryAt: null, supportAt: null }));
        if (candidate?.kind === "aggregate") {
          next = retainAggregate(previous, candidate.value);
          if (interrupted || state.paused) for (const sample of next.samples) if (sample[3] === candidate.value.at) sample[2] = 1;
          // A partial refresh may preserve the complete stored endpoint. Evaluate
          // the actual new capacity observation, never give the old total a new time.
          const evaluation = retainAggregate({ ...structuredClone(next), samples: next.samples.filter(row => row[1] !== 0 || bucket(0, row[3]) !== bucket(0, at)) }, candidate.value);
          if (interrupted || state.paused) for (const sample of evaluation.samples) if (sample[3] === candidate.value.at) sample[2] = 1;
          const incoming = candidate.value.capacities.map(row => row.descriptor);
          const pressures = state.pressures.filter(value => value.severity !== "observed" || incoming.some(([identity]) => identity === value.identity))
            .map(value => value.severity === "observed" ? newPressure(value.identity, incoming.find(([identity]) => identity === value.identity)![1]) : value);
          for (const [identity, rootScope] of incoming) if (!pressures.some(value => value.identity === identity) && pressures.length < 4) pressures.push(newPressure(identity, rootScope));
          next.metadata.state.pressures = pressures.map(value => {
            const observed = observePressure(value, capacityEvidence(evaluation, value.identity, time), time);
            // Fresh direct observations can escalate pressure, but cannot prove
            // recovery of an owner refusal whose identity was not retained.
            if (ownerEvidenceLost) observed.recoveryAt = null;
            return observed;
          });
          next.metadata.state.scopeLimit = candidate.value.reason === 3 || incoming.some(([identity]) => !pressures.some(value => value.identity === identity));
          next.metadata.state.paused = null;
        } else if (candidate) {
          next = structuredClone(previous);
          for (const row of next.samples) if (bucket(row[1], row[3]) === bucket(row[1], at)) row[2] = 1;
          next.metadata.state.pressures = state.pressures.map(value => observePressure(value, null, time));
          next.metadata.state.paused = "collection-unavailable";
        } else next = structuredClone(previous);
        for (const report of writes) {
          let pressure = next.metadata.state.pressures.find(value => value.identity === report.identity);
          if (!pressure && report.outcome === "success") continue;
          if (!pressure) {
            if (next.metadata.state.pressures.length >= 4) throw Error("history-pressure-capacity-budget");
            pressure = newPressure(report.identity, report.rootScope); next.metadata.state.pressures.push(pressure);
          }
          const index = next.metadata.state.pressures.indexOf(pressure);
          // Buffered reports were checked when received. A newer capacity sample
          // from this or another process cannot erase an intervening refusal.
          if (pressure.refusals.some(value => value.target === report.target && value.resource === report.resource && value.at > report.at)) continue;
          const changed = ownerWrite({ ...pressure, at: Math.min(pressure.at, report.at) }, report, time);
          changed.at = Math.max(changed.at, pressure.at);
          next.metadata.state.pressures[index] = changed;
        }
        if (ownerEvidenceLost) next.metadata.state.paused = "history-owner-evidence-budget";
        next.metadata.state.lastPersistedAt = time;
        if (candidate) {
          const observedAt = candidate.kind === "aggregate" ? candidate.value.at : candidate.at;
          next.metadata.state.lastObservedAt = observedAt;
          next.metadata.state.lastAttemptBucket = bucket(0, observedAt);
        }
        const episodes = new Set(next.metadata.state.pressures.flatMap(value => [value.episode, value.resolvedEpisode].filter((id): id is string => id !== null)));
        next.metadata.state.suppressedEpisodes = next.metadata.state.suppressedEpisodes.filter(value => episodes.has(value));
        validateHistory(next); stateSchema.parse(next.metadata.state);
        db.query("UPDATE storage_history SET payload_json = ?, revision = revision + 1 WHERE brain = ?").run(JSON.stringify(next), brain);
        return true;
      }).immediate();
      if (changed) { if (pending === candidate) pending = null; if (pendingWrites === writes) pendingWrites = []; interrupted = false; ownerOverflow = false; unavailable = null; }
      return changed;
    } catch (error) {
      interrupted = true;
      unavailable = error instanceof Error && error.message.startsWith("history-") ? error.message : "history-write-unavailable";
      return false;
    }
  }
  return {
    brain, read, flush, salt: read()?.metadata.state.salt ?? initial.metadata.state.salt,
    offer(value: Aggregate) { offer({ kind: "aggregate", value }); },
    failure(at = now()) { interrupted = true; offer({ kind: "failure", at }); },
    ownerWrite(report: StorageWriteReport) {
      if (closed) return;
      if (![report.identity, report.rootScope, report.target].every(value => /^[a-f0-9]{32}$/.test(value)) || !Number.isSafeInteger(report.at) || report.at < 0 || report.at > now()) throw Error("history-write-report-invalid");
      const stored = read();
      if (report.at < (stored?.metadata.state.lastPersistedAt ?? 0)) { interrupted = true; unavailable = "history-clock-reversal"; return; }
      const same = (value: StorageWriteReport) => value.identity === report.identity && value.rootScope === report.rootScope && value.target === report.target && value.resource === report.resource;
      // Success is evidence only for an existing matching refusal. Repeated
      // successes must not consume the bounded space reserved for failures.
      if (report.outcome === "success" && !pendingWrites.some(value => same(value) && value.outcome === "no-space")
        && !stored?.metadata.state.pressures.some(value => value.identity === report.identity && value.rootScope === report.rootScope
          && value.refusals.some(refusal => refusal.target === report.target && refusal.resource === report.resource))) return;
      const next = [...pendingWrites.filter(value => !same(value) || value.at > report.at
        || report.outcome === "success" && value.outcome === "no-space"), report];
      if (jsonBytes(next) > HISTORY_LIMITS.metadataBytes) {
        ownerOverflow = true; interrupted = true; unavailable = "history-owner-evidence-budget"; return;
      }
      pendingWrites = next; flush();
    },
    status() {
      const history = read();
      const scan = db.query("SELECT result_at FROM storage_scan_leases WHERE brain = ?").get(brain) as { result_at: number | null } | null;
      const waiting = scan?.result_at !== null && scan?.result_at !== undefined && scan.result_at > (history?.metadata.state.lastObservedAt ?? 0);
      return { history, pending: pending !== null || pendingWrites.length > 0 || waiting, paused: unavailable ?? (history && now() < history.metadata.state.lastPersistedAt ? "history-clock-reversal" : history?.metadata.state.paused ?? null), payloadBytes: history ? jsonBytes(history) : null };
    },
    close() { closed = true; pending = null; pendingWrites = []; },
  };
}
export type StorageHistory = ReturnType<typeof createStorageHistory>;

/** Called inside the existing operational restore transaction. */
export function invalidateRestoredStorage(db: Database, at: number): void {
  const rows = db.query("SELECT brain, payload_json FROM storage_history").all() as Array<{ brain: string; payload_json: string }>;
  for (const row of rows) {
    const payload = parseStoredHistory(row.payload_json), state = payload.metadata.state;
    state.suppressedEpisodes = state.pressures.flatMap(value => [value.episode, value.resolvedEpisode].filter((id): id is string => id !== null));
    state.pressures = state.pressures.map(value => ({ ...value, recoveryAt: null, supportAt: null }));
    state.lastPersistedAt = Math.max(state.lastPersistedAt, at);
    if (state.paused !== "history-owner-evidence-budget") state.paused = "collection-unavailable";
    validateHistory(payload);
    db.query("UPDATE storage_history SET payload_json = ?, revision = revision + 1 WHERE brain = ?").run(JSON.stringify(payload), row.brain);
  }
  db.query("UPDATE storage_notice_receipts SET state = 'suppressed', pid = NULL, process_start = NULL WHERE state NOT IN ('accepted', 'unknown')").run();
  db.query("DELETE FROM storage_scan_leases").run();
}
