import type { Database } from "bun:sqlite";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import * as historyWrites from "./history-writes.js";
import { emptyHistory, storageBrainKey, readStoredHistory, parseStoredHistory, type Pending, type StorageWriteReport } from "./history-data.js";
import { HISTORY_LIMITS, jsonBytes, validateHistory, type Aggregate } from "./history-model.js";
export { emptyHistory, storageBrainKey, readStoredHistory, parseStoredHistory, type HistoryState, type StoredHistory, type StorageWriteReport } from "./history-data.js";

export function createStorageHistory(db: Database, brainPath: string, options: { now?: () => number; writer?: SqliteWriter } = {}) {
  const brain = storageBrainKey(brainPath), now = options.now ?? Date.now;
  const initial = emptyHistory();
  let pending: Pending | null = null, unavailable: string | null = null, closed = false;
  let pendingWrites: StorageWriteReport[] = [], interrupted = false, ownerOverflow = false;
  let inFlight: Promise<boolean> | null = null, flushAgain = false;
  // New failures arriving during a commit must survive that commit's result.
  let interruptionVersion = 0, overflowVersion = 0;
  const procedures = options.writer ? null : historyWrites.setup(db, { brain, initial });
  const call = options.writer ? procedureCaller(db, historyWrites, { brain, initial }, options.writer) : null;
  // Constructing the store never collects filesystem inventory. Failure here is
  // a capability result; it cannot prevent existing recovery operations booting.
  if (call) void call("initialize").catch(() => { unavailable = "history-write-unavailable"; });
  else try { procedures!.initialize(); }
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
      interrupted = true; interruptionVersion++;
      // Do not overwrite a newer pending observation after a clock reversal.
      return;
    }
    const prior = pending && (pending.kind === "aggregate" ? pending.value.at : pending.at);
    if (prior === null || prior <= at) pending = value;
    flush();
  }
  function flush(): boolean | Promise<boolean> {
    if (inFlight) { flushAgain = true; return inFlight; }
    if (closed || !pending && !pendingWrites.length) return call ? Promise.resolve(false) : false;
    const candidate = pending, writes = pendingWrites, time = now();
    const at = Math.max(candidate ? candidate.kind === "aggregate" ? candidate.value.at : candidate.at : 0, ...writes.map(row => row.at));
    const interruption = interruptionVersion, overflow = overflowVersion;
    const input = { candidate, writes, time, at, interrupted, ownerOverflow };
    const apply = (changed: boolean) => {
      if (changed) {
        if (pending === candidate) pending = null;
        // Overflow raised during this commit still needs these buffered reports
        // to carry its evidence-loss marker into the next bounded write.
        if (pendingWrites === writes && overflowVersion === overflow) pendingWrites = [];
        if (interruptionVersion === interruption) interrupted = false;
        if (overflowVersion === overflow) ownerOverflow = false;
        if (interruptionVersion === interruption && overflowVersion === overflow) unavailable = null;
      }
      return changed;
    };
    const failed = (error: unknown) => {
      interrupted = true; interruptionVersion++;
      unavailable = error instanceof Error && error.message.startsWith("history-") ? error.message : "history-write-unavailable";
      return false;
    };
    if (!call) {
      try { return apply(procedures!.flush(input)); } catch (error) { return failed(error); }
    }
    // Post synchronously, in submission order. Every caller awaits the same
    // drain, including the one follow-up requested during the current commit.
    inFlight = call<boolean>("flush", input).then(apply, failed).then(async changed => {
      inFlight = null;
      if (flushAgain) { flushAgain = false; return await flush() || changed; }
      return changed;
    });
    return inFlight;
  }
  return {
    brain, read, flush, salt: read()?.metadata.state.salt ?? initial.metadata.state.salt,
    offer(value: Aggregate) { offer({ kind: "aggregate", value }); },
    failure(at = now()) { interrupted = true; interruptionVersion++; offer({ kind: "failure", at }); },
    ownerWrite(report: StorageWriteReport) {
      if (closed) return;
      if (![report.identity, report.rootScope, report.target].every(value => /^[a-f0-9]{32}$/.test(value)) || !Number.isSafeInteger(report.at) || report.at < 0 || report.at > now()) throw Error("history-write-report-invalid");
      const stored = read();
      if (report.at < (stored?.metadata.state.lastPersistedAt ?? 0)) { interrupted = true; interruptionVersion++; unavailable = "history-clock-reversal"; return; }
      const same = (value: StorageWriteReport) => value.identity === report.identity && value.rootScope === report.rootScope && value.target === report.target && value.resource === report.resource;
      // Success is evidence only for an existing matching refusal. Repeated
      // successes must not consume the bounded space reserved for failures.
      if (report.outcome === "success" && !pendingWrites.some(value => same(value) && value.outcome === "no-space")
        && !stored?.metadata.state.pressures.some(value => value.identity === report.identity && value.rootScope === report.rootScope
          && value.refusals.some(refusal => refusal.target === report.target && refusal.resource === report.resource))) return;
      const next = [...pendingWrites.filter(value => !same(value) || value.at > report.at
        || report.outcome === "success" && value.outcome === "no-space"), report];
      if (jsonBytes(next) > HISTORY_LIMITS.metadataBytes) {
        ownerOverflow = true; overflowVersion++; interrupted = true; interruptionVersion++; unavailable = "history-owner-evidence-budget"; return;
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
