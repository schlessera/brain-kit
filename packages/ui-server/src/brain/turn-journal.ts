/** Concrete host journal: observations, durable ownership and completed-turn collection. */
import type { Database } from "bun:sqlite";
import type { JournalVersion, TurnJournalDetails, TurnJournalSummary, JournalOutwardAction, JournalObservationReference } from "@schlessera/brain-ui-sdk/protocol";
import { createJournalAccounting, JournalStorageUnavailable } from "./journal-accounting.js";
import { createJournalObjects, JournalCapacityError } from "./journal-objects.js";
import type { JournalSnapshotEntry } from "./journal-snapshot.js";
import { createNativeJournalCapture, type NativeJournalPolicy } from "./native-journal-capture.js";
import type { NativeJournalManager } from "./native-journal-observer.js";
import { processAlive, SELF } from "./writer-gate.js";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";

import { queryGovernanceEvents, recordGovernanceEvent } from "../governance/events.js";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const storageError = (error: unknown): Error => error instanceof JournalCapacityError || error instanceof JournalStorageUnavailable
  ? error : new JournalStorageUnavailable(error instanceof Error ? error.message : String(error));
type TurnRow = { turn_id: string; session_id: string | null; actor: "interactive" | "voice" | "user"; kind: "turn" | "revert"; source_turn_id: string | null; model: string | null; profile: "strict" | "governed"; policy_hash: string | null; started_at: number; ended_at: number | null; state: TurnJournalSummary["state"]; summary: string | null; missing: string; steering_inventory_missing: string; failure: string };
type ChangeRow = { sequence: number; path: string; scope: string; before_json: string | null; after_json: string | null; class: "content" | "steering" | "policy"; actor: "agent" | "user"; taint_source_event_id: number | null; conflict_observations: string; overlaps: string };
const version = (entry: JournalSnapshotEntry | undefined): JournalVersion | null => entry ? {
  kind: entry.kind, mode: entry.mode, bytes: entry.bytes, ignored: entry.ignored,
  ...(entry.hash ? { hash: entry.hash } : {}), ...(entry.target !== undefined ? { target: entry.target } : {}),
} : null;
const identity = (entry: JournalSnapshotEntry | undefined) => JSON.stringify(entry ? { ...version(entry), ...(entry.ignored ? { stamp: entry.stamp } : {}) } : null);

export function createTurnJournal(db: Database, options: {
  brainPath: string; dbPath: string; objectsRoot: string; capBytes?: number; now?: () => number;
  nativeManager: NativeJournalManager;
  changed?: (turnId: string, sessionId: string, summary: TurnJournalSummary) => void;
}) {
  const now = options.now ?? Date.now;
  const accounting = createJournalAccounting(db, options.dbPath, { capBytes: options.capBytes });
  const objects = createJournalObjects(options.objectsRoot, accounting);
  accounting.recover(objects);
  for (const row of db.query("SELECT turn_id,pid,pid_start FROM turn_journal_turns WHERE ended_at IS NULL").all() as { turn_id: string; pid: number; pid_start: string }[]) {
    if (!processAlive(row.pid, row.pid_start)) accounting.write(() => db.query("UPDATE turn_journal_turns SET state='partial',ended_at=?,missing=? WHERE turn_id=?").run(now(), JSON.stringify([{ path: ".", reason: "interrupted_observation" }]), row.turn_id));
  }
  const active = new Map<string, { policy: NativeJournalPolicy; stop: (error: Error) => void; sequence: number }>();
  const capture = createNativeJournalCapture(options.nativeManager, async (source, bytes, signal) => {
    const hash = await retainAsync(() => objects.putFileAsync(source, bytes, signal));
    // Pin the shared observation before another admission can collect objects.
    retain(() => accounting.write(() => {
      for (const turnId of active.keys()) db.query("INSERT OR IGNORE INTO turn_journal_object_refs VALUES (?,?)").run(turnId, hash);
    }));
    return hash;
  }, {}, { brainPath: options.brainPath, async createTemporary(maximum) {
    const reservation = await retainAsync(async () => accounting.reserveTemporary(maximum));
    const path = join(options.objectsRoot, `pending-${reservation.id}`);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    const discard = async () => {
      try { await unlink(path); } catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT") throw cleanup; }
      const directory = await open(options.objectsRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    };
    try {
      file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await discard(); // Persist anonymity before bytes or the ledger release.
      return { file, release: reservation.release };
    } catch (error) {
      if (file) {
        await file.close();
        await discard();
      }
      reservation.release(); throw error;
    }
  } });
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = tail.then(operation);
    tail = work.catch(() => {});
    return work;
  }
  async function retainAsync<T>(operation: () => Promise<T>): Promise<T> {
    for (;;) {
      try { return await operation(); }
      catch (error) { if (!(error instanceof JournalCapacityError) || !collectOne()) throw error; }
    }
  }
  const periodicObservers = new Set<{ before(): void; after(completed: boolean): void }>();
  const observers = new Set<(turnId: string, facts: { changedPaths: number; observedBytes: number; partial: boolean }) => void>();
  const pendingReadReleases = new Set<string>();
  const failures = new Map<string, string>();
  const failedAdmissions = new Set<string>();
  let scopeTimer: ReturnType<typeof setInterval> | undefined;
  let holds = 0;
  let observationFailures = 0;
  function held<T>(operation: () => Promise<T>, admission = false): Promise<T> {
    // Backend event emission is synchronous: establish the hold before yielding
    // or queueing so a provider cannot launch another tool past this boundary.
    const holders = [...periodicObservers];
    holds++;
    let acquired = 0;
    try { for (const holder of holders) { acquired++; holder.before(); } }
    catch (error) { holds--; for (const holder of holders.slice(0, acquired)) holder.after(false); return Promise.reject(error); }
    return serialize(async () => {
      let completed = false;
      const failedBefore = observationFailures;
      try { const result = await operation(); completed = true; return result; }
      finally {
        // A cancelled/refused new admission made no worker writes. Existing
        // participants resume when their shared observation itself succeeded.
        const safe = completed || admission && observationFailures === failedBefore;
        holds--; for (const holder of holders) holder.after(safe);
      }
    });
  }
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
    const counts = db.query("SELECT count(DISTINCT path) AS changedFiles,count(DISTINCT CASE WHEN class='steering' THEN path END) AS steeringFiles,max(overlaps!='[]') AS sharedAttribution FROM turn_journal_changes WHERE turn_id=?").get(turnId) as { changedFiles: number; steeringFiles: number; sharedAttribution: number };
    const cost = db.query("SELECT effective_cost_usd,pricing_estimate FROM activity_run_rollups WHERE run_id=?").get(turnId) as { effective_cost_usd: number | null; pricing_estimate: number | null } | null;
    const partial = row.state !== "expired" && (failures.has(turnId) || row.failure.trim() || row.state === "partial");
    const scope = db.query("SELECT summary FROM turn_scope WHERE turn_id=?").get(turnId) as { summary: string } | null;
    return { ...(scope ? { scope: JSON.parse(scope.summary) } : {}), state: partial ? "partial" : row.state, changedFiles: retained?.changedFiles ?? (partial && !counts.changedFiles ? null : counts.changedFiles), steeringFiles: retained?.steeringFiles ?? (partial && !counts.changedFiles ? null : counts.steeringFiles),
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

  async function observe(userPolicy: boolean = false): Promise<void> {
    releaseReads();
    const overlaps = [...active.keys()];
    const changed = new Map<string, { path: string; scope: string; before: JournalVersion | null; after: JournalVersion | null }>();
    const stopActive = (error: unknown) => {
      for (const [id, turn] of active) {
        // One failed notification must not leave another participant running.
        try { fail(id, error); } catch { /* Existing partial slot remains authoritative. */ }
        try { turn.stop(error instanceof Error ? error : new Error(String(error))); } catch { /* Continue stopping every participant. */ }
      }
    };
    let observation: Awaited<ReturnType<typeof capture.observe>>;
    try { observation = await capture.observe(new Map([...active].map(([id, turn]) => [id, turn.policy]))); }
    catch (error) { observationFailures++; const failure = storageError(error); stopActive(failure); throw failure; }
    try {
      for (const changes of observation.changes.values()) for (const item of changes) {
        if (identity(item.before) === identity(item.after)) continue;
        const value = { path: item.path, scope: item.after?.scope ?? item.before?.scope ?? "", before: version(item.before), after: version(item.after) };
        changed.set(JSON.stringify(value), value);
      }
      const steering = observation.steering;
      for (const [turnId, turn] of active) {
        const metadata = db.query("SELECT * FROM turn_journal_turns WHERE turn_id=?").get(turnId) as TurnRow;
        const taint = db.query("SELECT id FROM governance_events WHERE kind='taint' AND (turn_id=? OR (? IS NOT NULL AND session_id=?)) ORDER BY id LIMIT 1")
          .get(turnId, metadata.session_id, metadata.session_id) as { id: number } | null;
        retain(() => accounting.write(() => {
          for (const item of changed.values()) {
            const sequence = ++turn.sequence;
            const approvedPolicy = userPolicy && item.path === "context/policies/governance.md";
            const classification = approvedPolicy ? "policy" : steering.paths.has(item.path) ? "steering" : "content";
            const actor = approvedPolicy || metadata.kind === "revert" ? "user" : "agent";
            const source = classification === "steering" && actor === "agent" && taint ? taint.id : null;
            const overlappingTurnIds = overlaps.filter(id => id !== turnId);
            db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class,actor,overlaps,taint_source_event_id) VALUES (?,?,?,?,?,?,?,?,?,?)")
              .run(turnId, sequence, item.path, item.scope, item.before ? JSON.stringify(item.before) : null, item.after ? JSON.stringify(item.after) : null, classification, actor, JSON.stringify(overlappingTurnIds), source);
            if (classification === "steering") recordGovernanceEvent(db, { kind: "steering_change", sessionId: metadata.session_id, turnId,
              actor: actor === "user" ? "user" : metadata.actor, model: metadata.model, profile: metadata.profile, at: now(), dedupeKey: `${turnId}:${sequence}`,
              payload: { path: item.path, sequence, beforeHash: item.before?.hash ?? null, afterHash: item.after?.hash ?? null, taintSourceEventId: source, overlappingTurnIds } });
            pin(turnId, item.before); pin(turnId, item.after);
            const observed = db.query("SELECT sequence,after_json,overlaps FROM turn_journal_changes WHERE turn_id=? AND path=? ORDER BY sequence").all(turnId, item.path) as {sequence:number;after_json:string|null;overlaps:string}[];
            const participants = new Set(observed.flatMap(row => JSON.parse(row.overlaps) as string[]));
            const conflicting = new Map<number, JournalObservationReference>();
            for (const other of participants) {
              const shared = observed.filter(row => (JSON.parse(row.overlaps) as string[]).includes(other));
              if (new Set(shared.map(row => row.after_json ?? "null")).size < 2) continue;
              for (const row of shared) conflicting.set(row.sequence, {turnId, sequence:row.sequence, side:"after"});
            }
            if (conflicting.size) db.query("UPDATE turn_journal_changes SET conflict_observations=? WHERE turn_id=? AND path=?")
              .run(JSON.stringify([...conflicting.values()].sort((a,b)=>a.sequence-b.sequence)),turnId,item.path);
          }
          db.query("UPDATE turn_journal_turns SET steering_inventory_missing=? WHERE turn_id=?").run(JSON.stringify([...new Set([...(JSON.parse(metadata.steering_inventory_missing) as string[]), ...steering.unavailable])]), turnId);
          if (observation.unreadable.length) {
            const missing = new Map<string, object>((JSON.parse(metadata.missing) as { path: string; reason: string }[]).map(item => [item.path, item]));
            for (const item of observation.unreadable) {
              const { ms, ...known } = item;
              missing.set(item.path, known);
              const signature = `journal_reader:${item.kind ?? "unknown"}:${item.bytes ?? "unknown"}:${item.path}`.slice(0, 1000);
              recordGovernanceEvent(db, { kind: "roadblock", sessionId: metadata.session_id, turnId, actor: metadata.actor,
                model: metadata.model, profile: metadata.profile, at: now(), dedupeKey: `journal-reader:${turnId}:${item.path}`,
                payload: { category: "permission_denied", family: "journal_reader", signature,
                  failures: [{ toolCallId: null, signature, category: "permission_denied" }], resolution: null,
                  remedy: "capability", waste: { tokens: null, costUsd: null, ms }, eventIds: [] } });
            }
            db.query("UPDATE turn_journal_turns SET state='partial',missing=? WHERE turn_id=?").run(JSON.stringify([...missing.values()]), turnId);
          }
        }));
        publish(turnId);
        // Ignored versions have metadata but no content hash: count their largest
        // observed size once per path, independently of hashed changed versions.
        const facts = db.query(`SELECT count(*) AS changedPaths,coalesce(sum(hashedBytes+ignoredBytes),0) AS observedBytes FROM (
          SELECT path,sum(CASE WHEN json_extract(after_json,'$.kind')='file' AND coalesce(json_extract(after_json,'$.ignored'),0)!=1
            AND json_extract(after_json,'$.hash') IS NOT json_extract(before_json,'$.hash')
            THEN json_extract(after_json,'$.bytes') ELSE 0 END) AS hashedBytes,
          max(CASE WHEN json_extract(after_json,'$.kind')='file' AND json_extract(after_json,'$.ignored')=1
            THEN json_extract(after_json,'$.bytes') ELSE 0 END) AS ignoredBytes
          FROM turn_journal_changes WHERE turn_id=? GROUP BY path
        )`).get(turnId) as { changedPaths: number; observedBytes: number };
        for (const observer of observers) observer(turnId, { ...facts, partial: summary(turnId).state === "partial" });
      }
      await observation.commit();
    } catch (error) {
      observationFailures++;
      const failure = storageError(error);
      stopActive(failure);
      await observation.abort().catch(() => {});
      throw failure;
    }
  }
  return {
    /** @internal Host scope monitor consumes this same observation window. */
    onObservation(observer: (turnId: string, facts: { changedPaths: number; observedBytes: number; partial: boolean }) => void, periodic?: { before(): void; after(completed: boolean): void }) {
      observers.add(observer); if (periodic) periodicObservers.add(periodic);
      return () => { if (periodic) periodicObservers.delete(periodic); return observers.delete(observer); };
    },
    begin(turnId: string, metadata: { sessionId: string | null; actor: "interactive" | "voice" | "user"; model: string | null; profile: "strict" | "governed"; policyHash: string | null; coveredPaths?: readonly string[] }, stop: (error: Error) => void, signal?: AbortSignal) { return held(async () => {
      signal?.throwIfAborted();
      try { await capture.initialize(signal); }
      catch (error) { if (signal?.aborted) throw error; throw storageError(error); }
      for (const refused of failedAdmissions) finalizeRefusedAdmission(refused);
      await observe();
      signal?.throwIfAborted();
      const expired = db.query("SELECT turn_id FROM turn_journal_turns WHERE ended_at IS NOT NULL AND ended_at<?").all(now() - RETENTION_MS) as { turn_id: string }[];
      for (const row of expired) expire(row.turn_id, true);
      retain(() => accounting.write(() => {
        db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,model,profile,policy_hash,pid,pid_start,started_at,state) VALUES (?,?,?,?,?,?,?,?,?,'recording') ON CONFLICT(turn_id) DO UPDATE SET started_at=excluded.started_at WHERE turn_journal_turns.kind='revert' AND turn_journal_turns.ended_at IS NULL")
          .run(turnId, metadata.sessionId, metadata.actor, metadata.model, metadata.profile, metadata.policyHash, SELF.pid, SELF.start, now());
      }));
      try {
      const policy = await capture.policy(metadata.coveredPaths);
      signal?.throwIfAborted();
      active.set(turnId, { policy, stop, sequence: 0 }); publish(turnId);
      if (!scopeTimer) {
        scopeTimer = setInterval(() => {
          void held(() => observe()).catch(error => {
            for (const [id, turn] of active) { fail(id, error); turn.stop(error instanceof Error ? error : new Error(String(error))); }
          });
        }, 15_000);
        scopeTimer.unref?.();
      }
      } catch (error) {
        failures.set(turnId, error instanceof JournalCapacityError ? "journal_capacity" : "journal_unavailable");
        failedAdmissions.add(turnId);
        try { finalizeRefusedAdmission(turnId); } catch { /* finish/next admission retries without reviving the worker. */ }
        publish(turnId);
        throw error instanceof JournalCapacityError || error instanceof JournalStorageUnavailable
          ? error : new JournalStorageUnavailable("native journal admission could not be prepared");
      }
    }, true); },
    bindSession(turnId: string, sessionId: string) { if (!active.has(turnId)) return; accounting.write(() => db.query("UPDATE turn_journal_turns SET session_id=? WHERE turn_id=?").run(sessionId, turnId)); publish(turnId); },
    bindModel(turnId: string, sessionId: string | null, model: string): boolean {
      if (!model || !active.has(turnId)) return false;
      const row = db.query("SELECT session_id,ended_at FROM turn_journal_turns WHERE turn_id=?").get(turnId) as { session_id: string | null; ended_at: number | null } | null;
      if (!row || row.ended_at !== null || row.session_id !== sessionId) return false;
      accounting.write(() => db.query("UPDATE turn_journal_turns SET model=? WHERE turn_id=? AND ended_at IS NULL").run(model, turnId));
      publish(turnId); return true;
    },
    observe(): Promise<void> { return held(() => observe()); },
    isHeld(): boolean { return holds > 0; },
    async idle(): Promise<void> { let waiting: Promise<unknown>; do { waiting = tail; await waiting; } while (waiting !== tail); },
    /** @internal Only the authenticated history service selects generated sibling coverage. */
    coverPaths(turnId: string, paths: readonly string[]): void {
      const turn=active.get(turnId); if(!turn)throw new JournalStorageUnavailable("history coverage requires an active observation window");
      turn.policy.cover(paths);
    },
    /** The caller retains approval/current-principal authority; this never revives a completed turn. */
    observeUserPolicy(turnId: string, approvedWrite: () => void): Promise<void> { return held(async () => {
      if (!active.has(turnId) || summary(turnId).state !== "recording") throw new JournalStorageUnavailable("approved policy write requires an active complete observation window");
      await observe();
      if (summary(turnId).state !== "recording") throw new JournalStorageUnavailable("policy observation became incomplete before the approved write");
      try { approvedWrite(); } finally { await observe(true); }
    }); },
    finish(turnId: string) { return held(async () => {
      if (!active.has(turnId)) { if (failedAdmissions.has(turnId)) finalizeRefusedAdmission(turnId); return; }
      try { await observe(); }
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
    }); },
    /** Ordinary current coverage only; never adds selected paths to ignored content. */
    removalCoverage(paths: readonly string[], signal?: AbortSignal, absent = false): Promise<boolean[]> { return held(async () => {
      if (paths.length > 32) throw new JournalStorageUnavailable("Too many selected attachments.");
      await capture.initialize(signal); await observe(); signal?.throwIfAborted();
      const policy = await capture.policy();
      return paths.map(path => absent ? capture.allowed(path, policy) : capture.eligible(path, policy));
    }); },
    /** Targeted user removal retains its original before effects; no ignore/retention override. */
    retainBefore(turnId: string, path: string, signal?: AbortSignal): Promise<JournalVersion | null> { return held(async () => {
      const turn = active.get(turnId);
      if (!turn || summary(turnId).state !== "recording") throw new JournalStorageUnavailable("A complete active journal is required before removal.");
      const before = version(await capture.retainBefore(path, turn.policy, signal));
      if (!before || before.ignored || before.kind !== "file" || !before.hash) return null;
      accounting.write(() => pin(turnId, before));
      if (!objects.verify(before.hash, before.bytes)) throw new JournalStorageUnavailable("The retained original could not be verified.");
      return before;
    }); },
    hasRetainedVersion(turnId: string, selected: JournalVersion): boolean {
      if (!selected.hash || selected.ignored || selected.kind !== "file" || ["unknown", "expired"].includes(summary(turnId).state)) return false;
      if (!db.query("SELECT 1 FROM turn_journal_object_refs WHERE turn_id=? AND hash=?").get(turnId, selected.hash)) return false;
      try { return objects.verify(selected.hash, selected.bytes); } catch { return false; }
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
    /** Acquire the read lease while the selected source still owns its original. */
    withRetainedRemoval<T>(turnId: string, selected: JournalVersion, apply: (copy: (fd: number) => void) => T): T {
      if (!selected.hash || selected.ignored || selected.kind !== "file") throw new JournalStorageUnavailable("retained original is unavailable");
      const lease = accounting.openRead(selected.hash, () => {
        if (!db.query("SELECT 1 FROM turn_journal_object_refs r JOIN turn_journal_turns t ON t.turn_id=r.turn_id WHERE r.turn_id=? AND r.hash=? AND t.state IN ('complete','partial') AND t.ended_at IS NOT NULL").get(turnId, selected.hash!)) throw new JournalStorageUnavailable("original retention ownership expired before admission");
      });
      try { return objects.withVerifiedCopy(selected.hash, selected.bytes, apply); }
      finally { try { accounting.releaseRead(lease); } catch { pendingReadReleases.add(lease); } }
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
        before: item.before_json ? JSON.parse(item.before_json) as JournalVersion : null, after: item.after_json ? JSON.parse(item.after_json) as JournalVersion : null, overlappingTurnIds: JSON.parse(item.overlaps) as string[], ...(item.taint_source_event_id ? { tainted: true as const, taintSourceEventId: item.taint_source_event_id } : {}),
        ...(JSON.parse(item.conflict_observations).length ? { conflict: { versions: JSON.parse(item.conflict_observations) as JournalObservationReference[],
          latest: { turnId, sequence: (db.query("SELECT max(sequence) AS sequence FROM turn_journal_changes WHERE turn_id=? AND path=?").get(turnId,item.path) as {sequence:number}).sequence, side:"after" as const } } } : {}) }));
      const failure = failures.get(turnId) ?? row.failure.trim();
      const outward = queryGovernanceEvents(db, { sessionId, turnId, kinds: ["outward_action"], limit: 1001 });
      const outwardActions: JournalOutwardAction[] = outward.slice(0, 1000).map(event => ({ id: event.id, at: event.at,
        tool: String(event.payload.tool), action: event.payload.action as JournalOutwardAction["action"], target: event.payload.target as string | null,
        decision: event.payload.decision as JournalOutwardAction["decision"], historyRewrite: event.payload.historyRewrite === true, revertible: false }));
      return { turnId, sessionId, summary: summary(turnId), changes, ...(outwardActions.length ? { outwardActions, outwardActionsTruncated: outward.length > 1000 } : {}), missing: [...JSON.parse(row.missing), ...(JSON.parse(row.steering_inventory_missing) as string[]).map(path => ({ path, reason: "configuration_inputs_not_fully_identified" })), ...(failure ? [{ path: ".", reason: failure }] : [])] };
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
    async close() { clearInterval(scopeTimer); try { await tail; await capture.close(); } finally { objects.close(); } },
  };
}

export type TurnJournal = ReturnType<typeof createTurnJournal>;
