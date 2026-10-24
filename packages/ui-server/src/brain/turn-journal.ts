/** Concrete host journal: observations, durable ownership and completed-turn collection. */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { JournalVersion, TurnJournalDetails, TurnJournalSummary, JournalOutwardAction, JournalObservationReference } from "@schlessera/brain-ui-sdk/protocol";
import { openSqliteWriter, type SqliteWriter } from "../db/write-worker.js";
import { installEscapeGuard, JournalStorageUnavailable } from "./journal-accounting.js";
import { createJournalObjects, JournalCapacityError } from "./journal-objects.js";
import * as journalStore from "./journal-store.js";
import { reviveJournalError, type JournalStatement, type JournalStoreOptions } from "./journal-store.js";
import type { JournalSnapshotEntry } from "./journal-snapshot.js";
import { createNativeJournalCapture, type NativeJournalPolicy } from "./native-journal-capture.js";
import type { NativeJournalManager } from "./native-journal-observer.js";
import { processAlive, SELF } from "./writer-gate.js";
import { referenceWorktreeJournalManager, referenceWorktreeJournalPath, REFERENCE_WORKTREE_JOURNAL_SCOPE, type ReferenceWorktreeCheckpointLedger,
  type ReferenceWorktreeJournalPool } from "./reference-worktree-journal.js";
import { constants, lstatSync, realpathSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";

import { queryGovernanceEvents } from "../governance/events.js";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const storageError = (error: unknown): Error => error instanceof JournalCapacityError || error instanceof JournalStorageUnavailable
  ? error : new JournalStorageUnavailable(error instanceof Error ? error.message : String(error));
type TurnRow = { turn_id: string; session_id: string | null; actor: "interactive" | "voice" | "user"; kind: "turn" | "revert"; source_turn_id: string | null; model: string | null; profile: "strict" | "governed"; policy_hash: string | null; started_at: number; ended_at: number | null; state: TurnJournalSummary["state"]; summary: string | null; missing: string; steering_inventory_missing: string; failure: string };
type ChangeRow = { sequence: number; path: string; scope: string; before_json: string | null; after_json: string | null; class: "content" | "steering" | "policy"; actor: "agent" | "user"; taint_source_event_id: number | null; conflict_observations: string; overlaps: string };
const statement = (sql: string, ...params: SQLQueryBindings[]): JournalStatement => ({ sql, params });
const version = (entry: JournalSnapshotEntry | undefined): JournalVersion | null => entry ? {
  kind: entry.kind, mode: entry.mode, bytes: entry.bytes, ignored: entry.ignored,
  ...(entry.hash ? { hash: entry.hash } : {}), ...(entry.target !== undefined ? { target: entry.target } : {}),
} : null;
const identity = (entry: JournalSnapshotEntry | undefined) => JSON.stringify(entry ? { ...version(entry), ...(entry.ignored ? { stamp: entry.stamp } : {}) } : null);

export function createTurnJournal(db: Database, options: {
  brainPath: string; dbPath: string; objectsRoot: string; capBytes?: number; now?: () => number;
  nativeManager: NativeJournalManager;
  /** Managed worktrees (#2430): each is its own separately checkpointed root. */
  referencePool?: ReferenceWorktreeJournalPool;
  /** Owner records for worktree observation checkpoints, so startup recovery releases only an ended process's. */
  referenceCheckpoints?: ReferenceWorktreeCheckpointLedger;
  changed?: (turnId: string, sessionId: string, summary: TurnJournalSummary) => void;
  /** The app's write worker; absent, the journal opens its own for `db`'s file. */
  writer?: SqliteWriter;
}) {
  const now = options.now ?? Date.now;
  // Every journal write is an accounted transaction on the write worker's
  // connection, committed at synchronous=FULL off the event loop and in
  // submission order (#2814). This connection only reads; its own guard
  // refuses any journal row it would change.
  const writer = options.writer ?? openSqliteWriter(db);
  const ownWriter = !options.writer;
  const ledger = writer.channel<JournalStoreOptions>(journalStore, { dbPath: options.dbPath, objectsRoot: options.objectsRoot, ...(options.capBytes !== undefined ? { capBytes: options.capBytes } : {}) }, reviveJournalError);
  if (writer.offloop) installEscapeGuard(db);
  /** Startup recovery commits before any later write; `ready` reports its refusal. */
  const ready = (async () => {
    await ledger.ready;
    await ledger.call("recover");
    const interrupted = (db.query("SELECT turn_id,pid,pid_start FROM turn_journal_turns WHERE ended_at IS NULL").all() as { turn_id: string; pid: number; pid_start: string }[])
      .filter(row => !processAlive(row.pid, row.pid_start));
    for (const row of interrupted) await ledger.call("statements", [statement("UPDATE turn_journal_turns SET state='partial',ended_at=?,missing=? WHERE turn_id=?", now(), JSON.stringify([{ path: ".", reason: "interrupted_observation" }]), row.turn_id)]);
  })();
  ready.catch(() => {});
  // Every later call passes through `ready` the same way, so calls reach the
  // worker, and commit, in the order they were made.
  const call = <T>(name: string, ...args: unknown[]): Promise<T> => ready.then(() => ledger.call<T>(name, ...args));
  const write = (statements: JournalStatement[]) => call<number[]>("statements", statements);
  const objects = createJournalObjects(options.objectsRoot, { async reserve(bytes, hash) {
    const id = await call<string>("reserve", bytes, hash);
    return { id, finish: (actual: string, size: number, duplicate: boolean) => call<void>("finishReservation", id, actual, size, duplicate), cancel: () => call<void>("cancelReservation", id) };
  } });
  /** Writes no admission awaits; `idle()` waits for them too. */
  const unserialized = new Set<Promise<unknown>>();
  function tracked<T>(work: Promise<T>): Promise<T> {
    unserialized.add(work); void work.finally(() => unserialized.delete(work)).catch(() => {});
    return work;
  }
  /** Active turns; `sessionId` is the binding their record holds once earlier writes commit. */
  const active = new Map<string, { policy: NativeJournalPolicy; stop: (error: Error) => void; sequence: number; sessionId: string | null }>();
  const retainVersion = async (source: number, bytes: number, signal?: AbortSignal) => {
    const hash = await retain(() => objects.putFileAsync(source, bytes, signal));
    // Pin the shared observation before another admission can collect objects.
    await retain(() => write([...active.keys()].map(turnId => statement("INSERT OR IGNORE INTO turn_journal_object_refs VALUES (?,?)", turnId, hash))));
    return hash;
  };
  const readIdentity = { brainPath: options.brainPath, async createTemporary(maximum: number) {
    const id = await retain(() => call<string>("reserveTemporary", maximum));
    const reservation = { id, release: () => call<void>("releaseTemporary", id) };
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
      await reservation.release(); throw error;
    }
  } };
  const capture = createNativeJournalCapture(options.nativeManager, retainVersion, {}, readIdentity);
  /** Managed worktrees a running turn's workers can reach, each observed as its own root. */
  const worktrees = new Map<string, { turnId: string; capture: ReturnType<typeof createNativeJournalCapture>; policy: NativeJournalPolicy }>();
  async function dropWorktrees(turnId?: string) {
    for (const [id, root] of [...worktrees]) if (turnId === undefined || root.turnId === turnId) {
      worktrees.delete(id);
      // A checkpoint this cannot release stays a held lease; startup recovery releases it.
      await root.capture.close().catch(() => {});
    }
  }
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = tail.then(operation);
    tail = work.catch(() => {});
    return work;
  }
  /** A capacity refusal collects the oldest ended turn and retries, until none is left. */
  async function retain<T>(operation: () => Promise<T>): Promise<T> {
    await ready;
    for (;;) {
      try { return await operation(); }
      catch (error) { if (!(error instanceof JournalCapacityError) || !await collectOne()) throw error; }
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
  /** The turn is partial at once; its durable marker commits after. */
  async function fail(turnId: string, error: unknown) {
    const reason = error instanceof JournalCapacityError ? "journal_capacity" : "journal_unavailable";
    failures.set(turnId, reason);
    // Admission preallocates this fixed-size terminal slot. It never needs a
    // larger row when an observation has exhausted available capacity.
    try { await write([statement("UPDATE turn_journal_turns SET state='partial',failure=? WHERE turn_id=?", reason.padEnd(64), turnId)]); }
    catch { /* Busy storage remains recording on disk; restart marks it interrupted, never complete. */ }
    publish(turnId);
  }
  async function releaseReads() {
    for (const id of pendingReadReleases) { await call("releaseRead", id); pendingReadReleases.delete(id); }
  }
  const releaseRead = (lease: string) => call<void>("releaseRead", lease).catch(() => { pendingReadReleases.add(lease); });

  function summary(turnId: string): TurnJournalSummary {
    const row = db.query("SELECT * FROM turn_journal_turns WHERE turn_id=?").get(turnId) as TurnRow | null;
    if (!row) return { state: "unknown", changedFiles: null, steeringFiles: null, costUsd: null, costIsEstimate: null, profile: null, actor: null, model: null, policyHash: null, sharedAttribution: false, observedAt: null };
    const retained = row.summary ? JSON.parse(row.summary) as { changedFiles: number; steeringFiles: number; sharedAttribution: boolean } : undefined;
    const counts = db.query("SELECT count(DISTINCT path) AS changedFiles,count(DISTINCT CASE WHEN class='steering' THEN path END) AS steeringFiles,max(overlaps!='[]') AS sharedAttribution FROM turn_journal_changes WHERE turn_id=?").get(turnId) as { changedFiles: number; steeringFiles: number; sharedAttribution: number };
    const cost = db.query("SELECT effective_cost_usd,pricing_estimate FROM activity_run_rollups WHERE run_id=?").get(turnId) as { effective_cost_usd: number | null; pricing_estimate: number | null } | null;
    const partial = row.state !== "expired" && (failures.has(turnId) || row.failure.trim() || row.state === "partial");
    const scope = db.query("SELECT summary FROM turn_scope WHERE turn_id=?").get(turnId) as { summary: string } | null;
    return { configurationCoverage: (JSON.parse(row.steering_inventory_missing) as string[]).length ? "incomplete" : !partial && row.state === "complete" ? "complete" : "unknown", ...(scope ? { scope: JSON.parse(scope.summary) } : {}), state: partial ? "partial" : row.state, changedFiles: retained?.changedFiles ?? (partial && !counts.changedFiles ? null : counts.changedFiles), steeringFiles: retained?.steeringFiles ?? (partial && !counts.changedFiles ? null : counts.steeringFiles),
      sharedAttribution: retained?.sharedAttribution ?? Boolean(counts.sharedAttribution), costUsd: cost?.effective_cost_usd ?? null,
      costIsEstimate: cost?.pricing_estimate == null ? null : Boolean(cost.pricing_estimate),
      profile: row.profile, actor: row.actor, kind: row.kind, ...(row.source_turn_id ? { sourceTurnId: row.source_turn_id } : {}), model: row.model, policyHash: row.policy_hash, observedAt: row.ended_at ?? row.started_at };
  }
  function publish(turnId: string) {
    const row = db.query("SELECT session_id FROM turn_journal_turns WHERE turn_id=?").get(turnId) as { session_id: string | null } | null;
    if (row?.session_id) options.changed?.(turnId, row.session_id, summary(turnId));
  }
  async function collectObjects() {
    await releaseReads();
    await call("collectObjects");
  }
  async function expire(turnId: string, removeSummary = false) {
    const before = summary(turnId);
    await write([
      statement("DELETE FROM turn_journal_changes WHERE turn_id=?", turnId),
      statement("DELETE FROM turn_journal_claude_memory WHERE turn_id=?", turnId),
      statement("DELETE FROM turn_journal_manifests WHERE turn_id=?", turnId),
      statement("DELETE FROM turn_journal_object_refs WHERE turn_id=?", turnId),
      removeSummary ? statement("DELETE FROM turn_journal_turns WHERE turn_id=? AND ended_at IS NOT NULL", turnId)
        : statement("UPDATE turn_journal_turns SET state='expired',summary=? WHERE turn_id=? AND ended_at IS NOT NULL", JSON.stringify({ changedFiles: before.changedFiles, steeringFiles: before.steeringFiles, sharedAttribution: before.sharedAttribution }), turnId),
    ]);
    failures.delete(turnId); await collectObjects(); publish(turnId);
  }
  async function collectOne(): Promise<boolean> {
    const row = db.query("SELECT turn_id,state FROM turn_journal_turns WHERE ended_at IS NOT NULL ORDER BY (state='expired'),ended_at LIMIT 1").get() as { turn_id: string; state: string } | null;
    if (!row) return false;
    await expire(row.turn_id, row.state === "expired"); return true;
  }
  async function finalizeRefusedAdmission(turnId: string) {
    await retain(() => write([
      // The preallocated terminal slot shrinks more than ended_at grows.
      // A refused worker made no changes, so initial-only CAS pins are unneeded.
      statement("UPDATE turn_journal_turns SET state='partial',failure=?,ended_at=? WHERE turn_id=?", failures.get(turnId) ?? "journal_unavailable", now(), turnId),
      statement("DELETE FROM turn_journal_manifests WHERE turn_id=?", turnId),
      statement("DELETE FROM turn_journal_object_refs WHERE turn_id=?", turnId),
    ]));
    failedAdmissions.delete(turnId); await collectObjects(); publish(turnId);
  }
  const pin = (turnId: string, entry: JournalVersion | null): JournalStatement[] =>
    entry?.hash ? [statement("INSERT OR IGNORE INTO turn_journal_object_refs VALUES (?,?)", turnId, entry.hash)] : [];

  async function observe(userPolicy: boolean = false): Promise<void> {
    await releaseReads();
    const overlaps = [...active.keys()];
    const changed = new Map<string, { path: string; scope: string; before: JournalVersion | null; after: JournalVersion | null }>();
    const stopActive = async (error: unknown) => {
      const recorded: Promise<void>[] = [];
      for (const [id, turn] of active) {
        // One failed notification must not leave another participant running.
        // Existing partial slot remains authoritative if the marker cannot be recorded.
        recorded.push(fail(id, error).catch(() => {}));
        try { turn.stop(error instanceof Error ? error : new Error(String(error))); } catch { /* Continue stopping every participant. */ }
      }
      await Promise.all(recorded);
    };
    let observation: Awaited<ReturnType<typeof capture.observe>>;
    try { observation = await capture.observe(new Map([...active].map(([id, turn]) => [id, turn.policy]))); }
    catch (error) { observationFailures++; const failure = storageError(error); await stopActive(failure); throw failure; }
    // Each managed worktree is observed through its own checkpoints, for the one turn that holds it.
    const separate: { worktreeId: string; turnId: string; observation: Awaited<ReturnType<typeof capture.observe>> }[] = [];
    for (const [worktreeId, root] of [...worktrees]) {
      const holder = active.get(root.turnId);
      if (!holder) continue;
      try { separate.push({ worktreeId, turnId: root.turnId, observation: await root.capture.observe(new Map([[root.turnId, root.policy]])) }); }
      catch (error) {
        // Only the holding turn depends on this root: it stops, and its record stays partial.
        worktrees.delete(worktreeId); void root.capture.close().catch(() => {});
        const failure = storageError(error);
        const recorded = fail(root.turnId, failure).catch(() => { /* The partial slot remains authoritative. */ });
        try { holder.stop(failure); } catch { /* Continue with the other participants. */ }
        await recorded;
      }
    }
    try {
      for (const changes of observation.changes.values()) for (const item of changes) {
        if (identity(item.before) === identity(item.after)) continue;
        const value = { path: item.path, scope: item.after?.scope ?? item.before?.scope ?? "", before: version(item.before), after: version(item.after) };
        changed.set(JSON.stringify(value), value);
      }
      const steering = observation.steering;
      for (const [turnId, turn] of active) {
        const worktree = separate.filter(root => root.turnId === turnId).flatMap(root => (root.observation.changes.get(turnId) ?? [])
          .filter(change => identity(change.before) !== identity(change.after))
          .map(change => ({ path: referenceWorktreeJournalPath(root.worktreeId, change.path), scope: REFERENCE_WORKTREE_JOURNAL_SCOPE, before: version(change.before), after: version(change.after) })));
        const unreadable = [...observation.unreadable, ...separate.filter(root => root.turnId === turnId).flatMap(root => root.observation.unreadable
          .map(item => ({ ...item, path: referenceWorktreeJournalPath(root.worktreeId, item.path === "." ? "" : item.path) })))];
        turn.sequence = await retain(() => call<number>("recordObservation", {
          turnId, sequence: turn.sequence, at: now(), userPolicy, changed: [...changed.values()], steeringPaths: [...steering.paths],
          overlaps, worktree, steeringUnavailable: [...steering.unavailable], unreadable,
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
      for (const root of separate) await root.observation.commit();
    } catch (error) {
      observationFailures++;
      const failure = storageError(error);
      await stopActive(failure);
      await observation.abort().catch(() => {});
      for (const root of separate) await root.observation.abort().catch(() => {});
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
      for (const refused of failedAdmissions) await finalizeRefusedAdmission(refused);
      await observe();
      signal?.throwIfAborted();
      const expired = db.query("SELECT turn_id FROM turn_journal_turns WHERE ended_at IS NOT NULL AND ended_at<?").all(now() - RETENTION_MS) as { turn_id: string }[];
      for (const row of expired) await expire(row.turn_id, true);
      await retain(() => write([statement("INSERT INTO turn_journal_turns (turn_id,session_id,actor,model,profile,policy_hash,pid,pid_start,started_at,state) VALUES (?,?,?,?,?,?,?,?,?,'recording') ON CONFLICT(turn_id) DO UPDATE SET started_at=excluded.started_at WHERE turn_journal_turns.kind='revert' AND turn_journal_turns.ended_at IS NULL",
        turnId, metadata.sessionId, metadata.actor, metadata.model, metadata.profile, metadata.policyHash, SELF.pid, SELF.start, now())]));
      try {
      const policy = await capture.policy(metadata.coveredPaths);
      signal?.throwIfAborted();
      active.set(turnId, { policy, stop, sequence: 0, sessionId: metadata.sessionId }); publish(turnId);
      if (!scopeTimer) {
        scopeTimer = setInterval(() => {
          void held(() => observe()).catch(error => {
            for (const [id, turn] of active) { void fail(id, error).catch(() => {}); turn.stop(error instanceof Error ? error : new Error(String(error))); }
          });
        }, 15_000);
        scopeTimer.unref?.();
      }
      } catch (error) {
        failures.set(turnId, error instanceof JournalCapacityError ? "journal_capacity" : "journal_unavailable");
        failedAdmissions.add(turnId);
        try { await finalizeRefusedAdmission(turnId); } catch { /* finish/next admission retries without reviving the worker. */ }
        publish(turnId);
        throw error instanceof JournalCapacityError || error instanceof JournalStorageUnavailable
          ? error : new JournalStorageUnavailable("native journal admission could not be prepared");
      }
    }, true); },
    async bindSession(turnId: string, sessionId: string): Promise<void> {
      const turn = active.get(turnId);
      if (!turn) return;
      turn.sessionId = sessionId;
      await tracked(write([statement("UPDATE turn_journal_turns SET session_id=? WHERE turn_id=?", sessionId, turnId)])); publish(turnId);
    },
    /**
     * Decided at once from the active turn's binding, so the caller adopts the
     * model before its next event; the record commits after every earlier write.
     */
    bindModel(turnId: string, sessionId: string | null, model: string): boolean {
      const turn = active.get(turnId);
      if (!model || !turn || turn.sessionId !== sessionId) return false;
      void tracked(call<boolean>("bindModel", turnId, sessionId, model)).then(bound => { if (bound) publish(turnId); }, () => {});
      return true;
    },
    observe(): Promise<void> { return held(() => observe()); },
    /**
     * Cover one managed worktree (#2430) for an active turn before any of its
     * workers can reach it: a baseline checkpoint and inventory of that root.
     */
    attachWorktree(turnId: string, worktreeId: string, signal?: AbortSignal): Promise<void> { return serialize(async () => {
      if (!options.referencePool) throw new JournalStorageUnavailable("managed worktree coverage requires the reference pool");
      if (!active.has(turnId) || failures.has(turnId)) throw new JournalStorageUnavailable("worktree coverage requires an active complete observation window");
      const existing = worktrees.get(worktreeId);
      if (existing) { if (existing.turnId === turnId) return; throw new JournalStorageUnavailable("another turn already observes this worktree"); }
      const root = createNativeJournalCapture(referenceWorktreeJournalManager(options.referencePool, worktreeId, options.referenceCheckpoints), retainVersion, {}, readIdentity, { steering: false });
      try {
        await root.initialize(signal);
        const policy = await root.policy();
        signal?.throwIfAborted();
        worktrees.set(worktreeId, { turnId, capture: root, policy });
      } catch (error) { await root.close().catch(() => {}); throw signal?.aborted ? error : storageError(error); }
    }); },
    /** Worktrees an active turn's journal observes. */
    worktrees(turnId: string): string[] { return [...worktrees].filter(([, root]) => root.turnId === turnId).map(([id]) => id); },
    isHeld(): boolean { return holds > 0; },
    async idle(): Promise<void> {
      let waiting: Promise<unknown>;
      do { waiting = tail; await waiting; } while (waiting !== tail);
      await Promise.allSettled([...unserialized]);
    },
    /** Settles once startup recovery has run; rejects with its refusal. */
    ready,
    /** @internal Only the authenticated history service selects generated sibling coverage. */
    coverPaths(turnId: string, paths: readonly string[]): void {
      const turn=active.get(turnId); if(!turn)throw new JournalStorageUnavailable("history coverage requires an active observation window");
      turn.policy.cover(paths);
    },
    /** The caller retains approval/current-principal authority; this never revives a completed turn. */
    observeUserPolicy(turnId: string, approvedWrite: () => void | Promise<void>): Promise<void> { return held(async () => {
      if (!active.has(turnId) || summary(turnId).state !== "recording") throw new JournalStorageUnavailable("approved policy write requires an active complete observation window");
      await observe();
      if (summary(turnId).state !== "recording") throw new JournalStorageUnavailable("policy observation became incomplete before the approved write");
      try { await approvedWrite(); } finally { await observe(true); }
    }); },
    finish(turnId: string) { return held(async () => {
      if (!active.has(turnId)) { if (failedAdmissions.has(turnId)) await finalizeRefusedAdmission(turnId); return; }
      try { await observe(); }
      finally {
        active.delete(turnId);
        await dropWorktrees(turnId);
        if (!active.size) { clearInterval(scopeTimer); scopeTimer = undefined; }
        await write([
          ...(failures.has(turnId) ? [statement("UPDATE turn_journal_turns SET state='partial',failure=? WHERE turn_id=?", failures.get(turnId)!.padEnd(64), turnId)] : []),
          statement("UPDATE turn_journal_turns SET ended_at=?,failure=trim(failure),state=CASE WHEN state='partial' THEN state ELSE 'complete' END WHERE turn_id=?", now(), turnId),
          statement("DELETE FROM turn_journal_manifests WHERE turn_id=?", turnId),
          statement("DELETE FROM turn_journal_object_refs WHERE turn_id=? AND NOT EXISTS (SELECT 1 FROM turn_journal_changes c WHERE c.turn_id=? AND (json_extract(c.before_json,'$.hash')=turn_journal_object_refs.hash OR json_extract(c.after_json,'$.hash')=turn_journal_object_refs.hash)) AND NOT EXISTS (SELECT 1 FROM turn_journal_claude_memory m WHERE m.turn_id=? AND m.state!='saved' AND (json_extract(m.before_json,'$.hash')=turn_journal_object_refs.hash OR json_extract(m.after_json,'$.hash')=turn_journal_object_refs.hash))", turnId, turnId, turnId),
        ]);
        await collectObjects(); publish(turnId);
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
      await write(pin(turnId, before));
      if (!objects.verify(before.hash, before.bytes)) throw new JournalStorageUnavailable("The retained original could not be verified.");
      return before;
    }); },
    hasRetainedVersion(turnId: string, selected: JournalVersion): boolean {
      if (!selected.hash || selected.ignored || selected.kind !== "file" || ["unknown", "expired"].includes(summary(turnId).state)) return false;
      if (!db.query("SELECT 1 FROM turn_journal_object_refs WHERE turn_id=? AND hash=?").get(turnId, selected.hash)) return false;
      try { return objects.verify(selected.hash, selected.bytes); } catch { return false; }
    },
    /**
     * Validated copy-out is the only native source of an external destination.
     * Every retained object and record commits before `save()` runs.
     */
    async persistClaudeMemory(turnId: string, change: { directory: string; note: string; before: Uint8Array | null; beforeMode: number; after: Uint8Array } | null, save: () => void): Promise<void> {
      if (!active.has(turnId)) throw new JournalStorageUnavailable("memory persistence requires an active turn");
      const path = change ? `claude-memory://${change.note}` : "claude-memory://";
      try {
        if (!change) throw new JournalStorageUnavailable("native memory persistence could not be inspected");
        if (!change.note.endsWith(".md") || /[\\/\u0000-\u001f\u007f]/u.test(change.note) || [".", ".."].includes(change.note)) throw new Error("invalid memory note");
        const directory = realpathSync(change.directory), info = lstatSync(directory);
        if (directory !== change.directory || !info.isDirectory() || directory === options.brainPath || directory.startsWith(`${options.brainPath}/`)) throw new Error("invalid external memory store");
        const retained = async (bytes: Uint8Array | null, mode: number): Promise<JournalVersion | null> => bytes === null ? null : {
          kind: "file", mode, bytes: bytes.length, hash: await retain(() => objects.putBytes(bytes)), ignored: false,
        };
        const before = await retained(change.before, change.beforeMode);
        // Pin the first object before a second admission can collect under pressure.
        await retain(() => write(pin(turnId, before)));
        const after = await retained(change.after, 0o600);
        await retain(() => write(pin(turnId, after)));
        await retain(() => write([statement("INSERT OR REPLACE INTO turn_journal_claude_memory VALUES (?,?,?,?,?,?,?,?,?)",
          turnId, path, directory, String(info.dev), String(info.ino), change.note, before ? JSON.stringify(before) : null, JSON.stringify(after), "pending")]));
        save();
        await this.recordClaudeMemory(turnId, path, { directory, device: String(info.dev), inode: String(info.ino), note: change.note }, before, after);
      } catch (error) {
        // A note-specific refusal does not erase other successfully retained
        // changes. If even this bounded missing receipt cannot fit, use the
        // admission's preallocated partial terminal slot instead.
        try {
          if (!await retain(() => call<boolean>("markMemoryUnconfirmed", turnId, path))) throw error;
          publish(turnId);
        } catch { await fail(turnId, error); }
        if (change) throw error;
      }
    },
    /** @internal Reads only a durable host-created destination, never a requested path. */
    claudeMemoryTarget(turnId: string, path: string) {
      return db.query("SELECT directory,device,inode,note FROM turn_journal_claude_memory WHERE turn_id=? AND path=?").get(turnId, path) as { directory: string; device: string; inode: string; note: string } | null;
    },
    /** @internal Record a successful native save or authenticated recovery with existing retained objects. */
    async recordClaudeMemory(turnId: string, path: string, target: { directory: string; device: string; inode: string; note: string }, before: JournalVersion | null, after: JournalVersion | null): Promise<void> {
      const turn = active.get(turnId); if (!turn) throw new JournalStorageUnavailable("memory observation requires an active turn");
      const sequence = ++turn.sequence;
      await retain(() => call("recordClaudeMemory", turnId, sequence, path, target, before, after, now()));
      publish(turnId);
    },
    /** All operation metadata uses the journal's existing physical allocation owner: one accounted write of these statements. */
    writeOperation(statements: readonly JournalStatement[]): Promise<number[]> { return write([...statements]); },
    async reserveRevert(turnId: string, sourceTurnId: string, versions: readonly (JournalVersion | null)[]): Promise<void> {
      const source = db.query("SELECT * FROM turn_journal_turns WHERE turn_id=? AND ended_at IS NOT NULL AND state IN ('complete','partial')").get(sourceTurnId) as TurnRow | null;
      if (!source) throw new JournalStorageUnavailable("source journal is unavailable");
      await write([
        statement("INSERT INTO turn_journal_turns (turn_id,session_id,actor,model,profile,policy_hash,pid,pid_start,started_at,state,kind,source_turn_id) VALUES (?,?,'user',NULL,?,?,?,?,?,'recording','revert',?)",
          turnId, source.session_id, source.profile, source.policy_hash, SELF.pid, SELF.start, now(), sourceTurnId),
        ...versions.flatMap(entry => pin(turnId, entry)),
      ]);
    },
    async finishReserved(turnId: string): Promise<void> {
      if (active.has(turnId)) throw new Error("active revert must finish its observation");
      await write([
        statement("UPDATE turn_journal_turns SET ended_at=?,state='partial',failure='revert_not_observed' WHERE turn_id=? AND ended_at IS NULL", now(), turnId),
        statement("DELETE FROM turn_journal_object_refs WHERE turn_id=?", turnId),
      ]); await collectObjects();
    },
    /** Acquire the read lease while the selected source still owns its original. */
    async withRetainedRemoval<T>(turnId: string, selected: JournalVersion, apply: (copy: (fd: number) => void) => T): Promise<T> {
      if (!selected.hash || selected.ignored || selected.kind !== "file") throw new JournalStorageUnavailable("retained original is unavailable");
      const lease = await call<string>("openRead", selected.hash, turnId);
      try { return await objects.withVerifiedCopy(selected.hash, selected.bytes, apply); }
      finally { await releaseRead(lease); }
    },
    async withRetainedVersion<T>(selected: JournalVersion | null, apply: (copy: (fd: number) => void) => T): Promise<T> {
      if (!selected || selected.kind === "symlink") return apply(() => {});
      if (!selected.hash || selected.ignored || selected.kind !== "file") throw new JournalStorageUnavailable("retained version is unavailable");
      const lease = await call<string>("openRead", selected.hash);
      try { return await objects.withVerifiedCopy(selected.hash, selected.bytes, apply); }
      finally { await releaseRead(lease); }
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
      return { turnId, sessionId, summary: summary(turnId), changes, ...(outwardActions.length ? { outwardActions, outwardActionsTruncated: outward.length > 1000 } : {}), missing: [...JSON.parse(row.missing), ...(db.query("SELECT path FROM turn_journal_claude_memory WHERE turn_id=? AND state!='saved'").all(turnId) as {path:string}[]).filter(item => !(JSON.parse(row.missing) as {path:string}[]).some(missing => missing.path === item.path)).map(item => ({path:item.path,reason:"memory_persistence_unconfirmed"})), ...(JSON.parse(row.steering_inventory_missing) as string[]).map(path => ({ path, reason: "configuration_inputs_not_fully_identified" })), ...(failure ? [{ path: ".", reason: failure }] : [])] };
    },
    version(sessionId: string, turnId: string, sequence: number, side: "before" | "after") {
      const details = this.details(sessionId, turnId), change = details?.changes.find(item => item.sequence === sequence);
      const selected = change?.[side];
      if (!selected?.hash || details?.summary.state === "expired") return null;
      return { selected, bytes: (maxBytes: number) => objects.read(selected.hash!, maxBytes), async stream() {
        const lease = await call<string>("openRead", selected.hash!);
        const release = () => releaseRead(lease);
        try { return objects.stream(selected.hash!, release); } catch (error) { release(); throw error; }
      } };
    },
    async close() {
      clearInterval(scopeTimer);
      try { await tail; await Promise.allSettled([...unserialized]); await dropWorktrees(); await capture.close(); }
      finally { objects.close(); await ledger.close(); if (ownWriter) await writer.close(); }
    },
  };
}

export type TurnJournal = ReturnType<typeof createTurnJournal>;
