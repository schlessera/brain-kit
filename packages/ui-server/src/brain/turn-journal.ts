/** Concrete host journal: observations, durable ownership and completed-turn collection. */
import type { Database } from "bun:sqlite";
import type { JournalVersion, TurnJournalDetails, TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";
import { createJournalAccounting, JournalStorageUnavailable } from "./journal-accounting.js";
import { createJournalObjects, JournalCapacityError } from "./journal-objects.js";
import { createJournalWalker, type JournalSnapshot, type JournalSnapshotEntry } from "./journal-snapshot.js";
import { processAlive, SELF } from "./writer-gate.js";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type TurnRow = { turn_id: string; session_id: string | null; actor: "interactive" | "voice" | "user"; kind: "turn" | "revert"; source_turn_id: string | null; model: string | null; profile: "strict" | "governed"; policy_hash: string | null; started_at: number; ended_at: number | null; state: TurnJournalSummary["state"]; summary: string | null; missing: string; failure: string };
type ChangeRow = { sequence: number; path: string; scope: string; before_json: string | null; after_json: string | null; class: "content" | "steering" | "policy"; actor: "agent" | "user"; overlaps: string };
const version = (entry: JournalSnapshotEntry | undefined): JournalVersion | null => entry ? {
  kind: entry.kind, mode: entry.mode, bytes: entry.bytes, ignored: entry.ignored,
  ...(entry.hash ? { hash: entry.hash } : {}), ...(entry.target !== undefined ? { target: entry.target } : {}),
} : null;
const identity = (entry: JournalSnapshotEntry | undefined) => JSON.stringify(entry ? { ...version(entry), ...(entry.ignored ? { stamp: entry.stamp } : {}) } : null);

export function createTurnJournal(db: Database, options: {
  brainPath: string; dbPath: string; objectsRoot: string; capBytes?: number; now?: () => number;
  changed?: (turnId: string, sessionId: string, summary: TurnJournalSummary) => void;
}) {
  const now = options.now ?? Date.now;
  const accounting = createJournalAccounting(db, options.dbPath, { capBytes: options.capBytes });
  const objects = createJournalObjects(options.objectsRoot, accounting);
  accounting.recover(objects);
  for (const row of db.query("SELECT turn_id,pid,pid_start FROM turn_journal_turns WHERE ended_at IS NULL").all() as { turn_id: string; pid: number; pid_start: string }[]) {
    if (!processAlive(row.pid, row.pid_start)) accounting.write(() => db.query("UPDATE turn_journal_turns SET state='partial',ended_at=?,missing=? WHERE turn_id=?").run(now(), JSON.stringify([{ path: ".", reason: "interrupted_observation" }]), row.turn_id));
  }
  const active = new Map<string, { walker: ReturnType<typeof createJournalWalker>; previous: JournalSnapshot; stop: (error: Error) => void; sequence: number }>();
  const pendingReadReleases = new Set<string>();
  const failures = new Map<string, string>();
  const failedAdmissions = new Set<string>();
  let scopeTimer: ReturnType<typeof setInterval> | undefined;
  function fail(turnId: string, error: unknown) {
    const reason = error instanceof JournalCapacityError ? "journal_capacity" : "journal_unavailable";
    failures.set(turnId, reason);
    // Admission preallocates this fixed-size terminal slot. It never needs a
    // larger row when an observation has exhausted available capacity.
    try { accounting.write(() => db.query("UPDATE turn_journal_turns SET state='partial',failure=? WHERE turn_id=?").run(reason.padEnd(64), turnId)); }
    catch { /* Busy storage remains recording on disk; restart marks it interrupted, never complete. */ }
    publish(turnId);
  }
  function releaseReads() {
    for (const id of pendingReadReleases) { accounting.releaseRead(id); pendingReadReleases.delete(id); }
  }

  function summary(turnId: string): TurnJournalSummary {
    const row = db.query("SELECT * FROM turn_journal_turns WHERE turn_id=?").get(turnId) as TurnRow | null;
    if (!row) return { state: "unknown", changedFiles: null, steeringFiles: null, costUsd: null, costIsEstimate: null, profile: null, actor: null, model: null, policyHash: null, sharedAttribution: false, observedAt: null };
    const retained = row.summary ? JSON.parse(row.summary) as { changedFiles: number; steeringFiles: number; sharedAttribution: boolean } : undefined;
    const counts = db.query("SELECT count(DISTINCT path) AS changedFiles,count(DISTINCT CASE WHEN class IN ('steering','policy') THEN path END) AS steeringFiles,max(overlaps!='[]') AS sharedAttribution FROM turn_journal_changes WHERE turn_id=?").get(turnId) as { changedFiles: number; steeringFiles: number; sharedAttribution: number };
    const cost = db.query("SELECT effective_cost_usd,pricing_estimate FROM activity_run_rollups WHERE run_id=?").get(turnId) as { effective_cost_usd: number | null; pricing_estimate: number | null } | null;
    const partial = row.state !== "expired" && (failures.has(turnId) || row.failure.trim() || row.state === "partial");
    return { state: partial ? "partial" : row.state, changedFiles: retained?.changedFiles ?? (partial && !counts.changedFiles ? null : counts.changedFiles), steeringFiles: retained?.steeringFiles ?? (partial && !counts.changedFiles ? null : counts.steeringFiles),
      sharedAttribution: retained?.sharedAttribution ?? Boolean(counts.sharedAttribution), costUsd: cost?.effective_cost_usd ?? null,
      costIsEstimate: cost?.pricing_estimate == null ? null : Boolean(cost.pricing_estimate),
      profile: row.profile, actor: row.actor, kind: row.kind, ...(row.source_turn_id ? { sourceTurnId: row.source_turn_id } : {}), model: row.model, policyHash: row.policy_hash, observedAt: row.ended_at ?? row.started_at };
  }
  function publish(turnId: string) {
    const row = db.query("SELECT session_id FROM turn_journal_turns WHERE turn_id=?").get(turnId) as { session_id: string | null } | null;
    if (row?.session_id) options.changed?.(turnId, row.session_id, summary(turnId));
  }
  function collectObjects() {
    releaseReads();
    accounting.write(() => {
      const unused = db.query("SELECT hash FROM turn_journal_objects WHERE state='present' AND NOT EXISTS(SELECT 1 FROM turn_journal_object_refs r WHERE r.hash=turn_journal_objects.hash) AND NOT EXISTS(SELECT 1 FROM turn_journal_reservations r WHERE r.hash=turn_journal_objects.hash)").all() as { hash: string }[];
      for (const row of unused) {
        if (objects.has(row.hash)) objects.remove(row.hash);
        db.query("DELETE FROM turn_journal_objects WHERE hash=?").run(row.hash);
      }
    });
  }
  function expire(turnId: string, removeSummary = false) {
    const before = summary(turnId);
    accounting.write(() => {
      db.query("DELETE FROM turn_journal_changes WHERE turn_id=?").run(turnId);
      db.query("DELETE FROM turn_journal_manifests WHERE turn_id=?").run(turnId);
      db.query("DELETE FROM turn_journal_object_refs WHERE turn_id=?").run(turnId);
      if (removeSummary) db.query("DELETE FROM turn_journal_turns WHERE turn_id=? AND ended_at IS NOT NULL").run(turnId);
      else db.query("UPDATE turn_journal_turns SET state='expired',summary=? WHERE turn_id=? AND ended_at IS NOT NULL").run(JSON.stringify({ changedFiles: before.changedFiles, steeringFiles: before.steeringFiles, sharedAttribution: before.sharedAttribution }), turnId);
    });
    failures.delete(turnId); collectObjects(); publish(turnId);
  }
  function collectOne(): boolean {
    const row = db.query("SELECT turn_id,state FROM turn_journal_turns WHERE ended_at IS NOT NULL ORDER BY (state='expired'),ended_at LIMIT 1").get() as { turn_id: string; state: string } | null;
    if (!row) return false;
    expire(row.turn_id, row.state === "expired"); return true;
  }
  function retain<T>(operation: () => T): T {
    for (;;) {
      try { return operation(); }
      catch (error) { if (!(error instanceof JournalCapacityError) || !collectOne()) throw error; }
    }
  }
  function finalizeRefusedAdmission(turnId: string) {
    retain(() => accounting.write(() => {
      // The preallocated terminal slot shrinks more than ended_at grows.
      // A refused worker made no changes, so initial-only CAS pins are unneeded.
      db.query("UPDATE turn_journal_turns SET state='partial',failure=?,ended_at=? WHERE turn_id=?").run(failures.get(turnId) ?? "journal_unavailable", now(), turnId);
      db.query("DELETE FROM turn_journal_manifests WHERE turn_id=?").run(turnId);
      db.query("DELETE FROM turn_journal_object_refs WHERE turn_id=?").run(turnId);
    }));
    failedAdmissions.delete(turnId); collectObjects(); publish(turnId);
  }
  function pin(turnId: string, entry: JournalVersion | null) {
    if (entry?.hash) db.query("INSERT OR IGNORE INTO turn_journal_object_refs VALUES (?,?)").run(turnId, entry.hash);
  }

  function observe(userPolicy: boolean = false): void {
    releaseReads();
    const overlaps = [...active.keys()];
    const changed = new Map<string, { path: string; scope: string; before: JournalVersion | null; after: JournalVersion | null }>();
    const missing = new Map<string, { path: string; reason: string }[]>();
    for (const [turnId, turn] of active) {
      const snapshot = turn.walker.observe();
      const before = new Map(turn.previous.entries.map(entry => [entry.path, entry]));
      const after = new Map(snapshot.entries.map(entry => [entry.path, entry]));
      const uncertain = new Set(snapshot.missing.map(entry => entry.path));
      for (const path of new Set([...before.keys(), ...after.keys()])) {
        if ([...uncertain].some(parent => path === parent || path.startsWith(`${parent}/`))) continue;
        if (identity(before.get(path)) === identity(after.get(path))) continue;
        const item = { path, scope: after.get(path)?.scope ?? before.get(path)?.scope ?? "", before: version(before.get(path)), after: version(after.get(path)) };
        changed.set(JSON.stringify(item), item);
      }
      turn.previous = snapshot;
      if (snapshot.missing.length) missing.set(turnId, snapshot.missing);
    }
    for (const [turnId, turn] of active) {
      try {
        retain(() => accounting.write(() => {
          for (const item of changed.values()) {
            const sequence = ++turn.sequence;
            const approvedPolicy = userPolicy && item.path === "context/policies/governance.md";
            db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class,actor,overlaps) VALUES (?,?,?,?,?,?,?,?,?)")
              .run(turnId, sequence, item.path, item.scope, item.before ? JSON.stringify(item.before) : null, item.after ? JSON.stringify(item.after) : null, approvedPolicy ? "policy" : "content", approvedPolicy || (db.query("SELECT kind FROM turn_journal_turns WHERE turn_id=?").get(turnId) as {kind:string})?.kind === "revert" ? "user" : "agent", JSON.stringify(overlaps.filter(id => id !== turnId)));
            pin(turnId, item.before); pin(turnId, item.after);
          }
          const failures = missing.get(turnId) ?? [];
          if (failures.length) db.query("UPDATE turn_journal_turns SET state='partial',missing=? WHERE turn_id=?").run(JSON.stringify(failures), turnId);
        }));
        if (missing.has(turnId)) turn.stop(missing.get(turnId)!.some(item => item.reason === "journal_capacity")
          ? new JournalCapacityError() : new JournalStorageUnavailable("some observed paths could not be retained"));
      } catch (error) { fail(turnId, error); turn.stop(error instanceof Error ? error : new Error(String(error))); throw error; }
      publish(turnId);
    }
  }
  return {
    begin(turnId: string, metadata: { sessionId: string | null; actor: "interactive" | "voice" | "user"; model: string | null; profile: "strict" | "governed"; policyHash: string | null; coveredPaths?: readonly string[] }, stop: (error: Error) => void) {
      for (const refused of failedAdmissions) finalizeRefusedAdmission(refused);
      observe();
      const expired = db.query("SELECT turn_id FROM turn_journal_turns WHERE ended_at IS NOT NULL AND ended_at<?").all(now() - RETENTION_MS) as { turn_id: string }[];
      for (const row of expired) expire(row.turn_id, true);
      retain(() => accounting.write(() => {
        db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,model,profile,policy_hash,pid,pid_start,started_at,state) VALUES (?,?,?,?,?,?,?,?,?,'recording') ON CONFLICT(turn_id) DO UPDATE SET started_at=excluded.started_at WHERE turn_journal_turns.kind='revert' AND turn_journal_turns.ended_at IS NULL")
          .run(turnId, metadata.sessionId, metadata.actor, metadata.model, metadata.profile, metadata.policyHash, SELF.pid, SELF.start, now());
      }));
      const captureObjects = { has: objects.has, putFile(fd: number, bytes: number) {
        const hash = retain(() => objects.putFile(fd, bytes));
        retain(() => accounting.write(() => db.query("INSERT OR IGNORE INTO turn_journal_object_refs VALUES (?,?)").run(turnId, hash)));
        return hash;
      } };
      try {
      const walker = createJournalWalker(options.brainPath, captureObjects, metadata.coveredPaths);
      let snapshot: JournalSnapshot;
      snapshot = walker.begin();
      if (snapshot.missing.length) {
        const message = `initial snapshot incomplete (${snapshot.missing.map(item => `${item.path}: ${item.reason}`).join(", ")})`;
        throw snapshot.missing.some(item => item.reason === "journal_capacity") ? new JournalCapacityError(message) : new JournalStorageUnavailable(message);
      }
      retain(() => accounting.write(() => {
        db.query("INSERT INTO turn_journal_manifests VALUES (?,?)").run(turnId, JSON.stringify(snapshot));
        for (const entry of snapshot.entries) pin(turnId, version(entry));
      }));
      active.set(turnId, { walker, previous: snapshot, stop, sequence: 0 }); publish(turnId);
      if (!scopeTimer) {
        scopeTimer = setInterval(() => {
          try { observe(); } catch (error) {
            for (const [id, turn] of active) { fail(id, error); turn.stop(error instanceof Error ? error : new Error(String(error))); }
          }
        }, 15_000);
        scopeTimer.unref?.();
      }
      } catch (error) {
        failures.set(turnId, error instanceof JournalCapacityError ? "journal_capacity" : "journal_unavailable");
        failedAdmissions.add(turnId);
        try { finalizeRefusedAdmission(turnId); } catch { /* finish/next admission retries without reviving the worker. */ }
        publish(turnId);
        throw error instanceof JournalCapacityError || error instanceof JournalStorageUnavailable
          ? error : new JournalStorageUnavailable("initial snapshot could not be recorded");
      }
    },
    bindSession(turnId: string, sessionId: string) { if (!active.has(turnId)) return; accounting.write(() => db.query("UPDATE turn_journal_turns SET session_id=? WHERE turn_id=?").run(sessionId, turnId)); publish(turnId); },
    observe(): void { observe(); },
    /** The caller retains approval/current-principal authority; this never revives a completed turn. */
    observeUserPolicy(turnId: string, approvedWrite: () => void): void {
      if (!active.has(turnId) || summary(turnId).state !== "recording") throw new JournalStorageUnavailable("approved policy write requires an active complete observation window");
      observe();
      if (summary(turnId).state !== "recording") throw new JournalStorageUnavailable("policy observation became incomplete before the approved write");
      try { approvedWrite(); } finally { observe(true); }
    },
    finish(turnId: string) {
      if (!active.has(turnId)) { if (failedAdmissions.has(turnId)) finalizeRefusedAdmission(turnId); return; }
      try { observe(); }
      finally {
        active.delete(turnId);
        if (!active.size) { clearInterval(scopeTimer); scopeTimer = undefined; }
        accounting.write(() => {
          if (failures.has(turnId)) db.query("UPDATE turn_journal_turns SET state='partial',failure=? WHERE turn_id=?").run(failures.get(turnId)!.padEnd(64), turnId);
          db.query("UPDATE turn_journal_turns SET ended_at=?,failure=trim(failure),state=CASE WHEN state='partial' THEN state ELSE 'complete' END WHERE turn_id=?").run(now(), turnId);
          db.query("DELETE FROM turn_journal_manifests WHERE turn_id=?").run(turnId);
          db.query("DELETE FROM turn_journal_object_refs WHERE turn_id=? AND NOT EXISTS (SELECT 1 FROM turn_journal_changes c WHERE c.turn_id=? AND (json_extract(c.before_json,'$.hash')=turn_journal_object_refs.hash OR json_extract(c.after_json,'$.hash')=turn_journal_object_refs.hash))").run(turnId, turnId);
        });
        collectObjects(); publish(turnId);
      }
    },
    /** All operation metadata uses the journal's existing physical allocation owner. */
    writeOperation<T>(write: () => T): T { return accounting.write(write); },
    reserveRevert(turnId: string, sourceTurnId: string, versions: readonly (JournalVersion | null)[]) {
      const source = db.query("SELECT * FROM turn_journal_turns WHERE turn_id=? AND ended_at IS NOT NULL AND state IN ('complete','partial')").get(sourceTurnId) as TurnRow | null;
      if (!source) throw new JournalStorageUnavailable("source journal is unavailable");
      accounting.write(() => {
        db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,model,profile,policy_hash,pid,pid_start,started_at,state,kind,source_turn_id) VALUES (?,?,'user',NULL,?,?,?,?,?,'recording','revert',?)")
          .run(turnId, source.session_id, source.profile, source.policy_hash, SELF.pid, SELF.start, now(), sourceTurnId);
        for (const entry of versions) pin(turnId, entry);
      });
    },
    finishReserved(turnId: string) {
      if (active.has(turnId)) throw new Error("active revert must finish its observation");
      accounting.write(() => {
        db.query("UPDATE turn_journal_turns SET ended_at=?,state='partial',failure='revert_not_observed' WHERE turn_id=? AND ended_at IS NULL").run(now(), turnId);
        db.query("DELETE FROM turn_journal_object_refs WHERE turn_id=?").run(turnId);
      }); collectObjects();
    },
    withRetainedVersion<T>(selected: JournalVersion | null, apply: (copy: (fd: number) => void) => T): T {
      if (!selected || selected.kind === "symlink") return apply(() => {});
      if (!selected.hash || selected.ignored || selected.kind !== "file") throw new JournalStorageUnavailable("retained version is unavailable");
      const lease = accounting.openRead(selected.hash);
      try { return objects.withVerifiedCopy(selected.hash, selected.bytes, apply); }
      finally { try { accounting.releaseRead(lease); } catch { pendingReadReleases.add(lease); } }
    },
    summary,
    details(sessionId: string, turnId: string): TurnJournalDetails | null {
      const row = db.query("SELECT * FROM turn_journal_turns WHERE turn_id=? AND session_id=?").get(turnId, sessionId) as TurnRow | null;
      if (!row) return null;
      const changes = (db.query("SELECT * FROM turn_journal_changes WHERE turn_id=? ORDER BY sequence,path").all(turnId) as ChangeRow[]).map(item => ({ sequence: item.sequence, path: item.path, scope: item.scope, class: item.class, actor: item.actor,
        before: item.before_json ? JSON.parse(item.before_json) as JournalVersion : null, after: item.after_json ? JSON.parse(item.after_json) as JournalVersion : null, overlappingTurnIds: JSON.parse(item.overlaps) as string[] }));
      const failure = failures.get(turnId) ?? row.failure.trim();
      return { turnId, sessionId, summary: summary(turnId), changes, missing: [...JSON.parse(row.missing), ...(failure ? [{ path: ".", reason: failure }] : [])] };
    },
    version(sessionId: string, turnId: string, sequence: number, side: "before" | "after") {
      const details = this.details(sessionId, turnId), change = details?.changes.find(item => item.sequence === sequence);
      const selected = change?.[side];
      if (!selected?.hash || details?.summary.state === "expired") return null;
      return { selected, bytes: (maxBytes: number) => objects.read(selected.hash!, maxBytes), stream() {
        const lease = accounting.openRead(selected.hash!);
        const release = () => { try { accounting.releaseRead(lease); } catch { pendingReadReleases.add(lease); } };
        try { return objects.stream(selected.hash!, release); } catch (error) { release(); throw error; }
      } };
    },
    close() { clearInterval(scopeTimer); objects.close(); },
  };
}

export type TurnJournal = ReturnType<typeof createTurnJournal>;
