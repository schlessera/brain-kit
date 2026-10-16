import { z } from "zod";
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { capacityEvidence } from "./history-evidence.js";
import { newPressure, observePressure, type Pressure } from "./pressure.js";
import { HISTORY_LIMITS, bucket, hashScope, jsonBytes, retainAggregate, validateHistory, type Aggregate, type HistoryPayload } from "./history-model.js";
export interface HistoryState {
  version: 1; salt: string;
  lastPersistedAt: number; lastObservedAt: number; lastAttemptBucket: number | null;
  paused: "collection-unavailable" | "clock-reversal" | null;
  pressures: Pressure[];
  /** Restoring an old backup cannot revive authority to send its old episodes. */
  suppressedEpisodes: string[];
  scopeLimit: boolean;
}
export type StoredHistory = HistoryPayload<HistoryState>;
type Pending = { kind: "aggregate"; value: Aggregate } | { kind: "failure"; at: number };
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
  lastObservedAt: instant, lastAttemptBucket: instant.nullable(), paused: z.enum(["collection-unavailable", "clock-reversal"]).nullable(),
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
  let pending: Pending | null = null, unavailable: string | null = null, closed = false;
  // Constructing the store never collects filesystem inventory. Failure here is
  // a capability result; it cannot prevent existing recovery operations booting.
  try { db.query("INSERT OR IGNORE INTO storage_history (brain, payload_json) VALUES (?, ?)").run(brain, JSON.stringify(emptyHistory())); }
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
      // Do not overwrite a newer pending observation after a clock reversal.
      return;
    }
    const prior = pending && (pending.kind === "aggregate" ? pending.value.at : pending.at);
    if (prior === null || prior <= at) pending = value;
    flush();
  }
  function flush(): boolean {
    if (closed || !pending) return false;
    const candidate = pending, at = candidate.kind === "aggregate" ? candidate.value.at : candidate.at, time = now();
    try {
      const changed = db.transaction(() => {
        const previous = readStoredHistory(db, brain);
        if (!previous) throw Error("history-unavailable");
        const state = previous.metadata.state;
        if (time < state.lastPersistedAt || at < state.lastObservedAt || at > time) throw Error("history-clock-reversal");
        if (time - state.lastPersistedAt < HISTORY_LIMITS.writeInterval) return false;
        let next: StoredHistory;
        if (candidate.kind === "aggregate") {
          next = retainAggregate(previous, candidate.value);
          // A partial refresh may preserve the complete stored endpoint. Evaluate
          // the actual new capacity observation, never give the old total a new time.
          const evaluation = retainAggregate({ ...structuredClone(next), samples: next.samples.filter(row => row[1] !== 0 || bucket(0, row[3]) !== bucket(0, at)) }, candidate.value);
          const incoming = candidate.value.capacities.map(row => row.descriptor);
          const pressures = state.pressures.filter(value => value.severity !== "observed" || incoming.some(([identity]) => identity === value.identity))
            .map(value => value.severity === "observed" ? newPressure(value.identity, incoming.find(([identity]) => identity === value.identity)![1]) : value);
          for (const [identity, rootScope] of incoming) if (!pressures.some(value => value.identity === identity) && pressures.length < 4) pressures.push(newPressure(identity, rootScope));
          next.metadata.state.pressures = pressures.map(value => observePressure(value, capacityEvidence(evaluation, value.identity, time), time));
          next.metadata.state.scopeLimit = candidate.value.reason === 3 || incoming.some(([identity]) => !pressures.some(value => value.identity === identity));
          next.metadata.state.paused = null;
        } else {
          next = structuredClone(previous);
          for (const row of next.samples) if (bucket(row[1], row[3]) === bucket(row[1], at)) row[2] = 1;
          next.metadata.state.pressures = state.pressures.map(value => observePressure(value, null, time));
          next.metadata.state.paused = "collection-unavailable";
        }
        next.metadata.state.lastPersistedAt = time;
        next.metadata.state.lastObservedAt = at;
        next.metadata.state.lastAttemptBucket = bucket(0, at);
        const episodes = new Set(next.metadata.state.pressures.flatMap(value => [value.episode, value.resolvedEpisode].filter((id): id is string => id !== null)));
        next.metadata.state.suppressedEpisodes = next.metadata.state.suppressedEpisodes.filter(value => episodes.has(value));
        validateHistory(next);
        db.query("UPDATE storage_history SET payload_json = ?, revision = revision + 1 WHERE brain = ?").run(JSON.stringify(next), brain);
        return true;
      }).immediate();
      if (changed) { if (pending === candidate) pending = null; unavailable = null; }
      return changed;
    } catch (error) {
      unavailable = error instanceof Error && error.message.startsWith("history-") ? error.message : "history-write-unavailable";
      return false;
    }
  }
  return {
    brain, read, flush,
    offer(value: Aggregate) { offer({ kind: "aggregate", value }); },
    failure(at = now()) { offer({ kind: "failure", at }); },
    status() { const history = read(); return { history, pending: pending !== null, paused: unavailable ?? history?.metadata.state.paused ?? null, payloadBytes: history ? jsonBytes(history) : null }; },
    close() { closed = true; pending = null; },
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
    state.paused = "collection-unavailable";
    validateHistory(payload);
    db.query("UPDATE storage_history SET payload_json = ?, revision = revision + 1 WHERE brain = ?").run(JSON.stringify(payload), row.brain);
  }
  db.query("UPDATE storage_notice_receipts SET state = 'suppressed', pid = NULL, process_start = NULL WHERE state NOT IN ('accepted', 'unknown')").run();
  db.query("DELETE FROM storage_scan_leases").run();
}
