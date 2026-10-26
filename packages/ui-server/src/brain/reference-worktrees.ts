/**
 * Managed reference worktrees (#2430): writable snapshots of authorized
 * shared source with a fixed reported starting commit.
 *
 * - Allocation reads the source through the acquisition service, so its
 *   authority, freshness and private boundary apply, then snapshots the
 *   sealed source root and takes a read-only baseline checkpoint.
 * - Access moves the worktree into one open worker generation of the same
 *   principal, after authority is checked again and journal coverage is in
 *   place. A generation is never the source of a later grant: a worktree held
 *   by a live generation is busy, and one held by a dead generation is parked
 *   first.
 * - Only explicit access, resumption or renewal moves `accessed_at`. Expiry
 *   after three days protects a live holder, recovers a holder only on
 *   positive evidence that it is gone, and retains anything unknown.
 * - Release and expiry record durable cleanup eligibility facts and remove
 *   only a positively clean, unheld worktree. Anything else is kept and
 *   charged until hygiene review (#2431) disposes of it; every removal is
 *   revalidated here, just before it, and recorded before the pool sees it.
 * See docs/decisions/managed-worktrees.md.
 */
import type { Database } from "bun:sqlite";
import { referenceWrites } from "./reference-writes.js";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@opentelemetry/api-logs";
import { parseNativeBrainDelta, type createNativeBrainManagerClient, type NativePoolCheckpoint, type NativePoolRecord } from "@schlessera/brain-ui-sdk/internal";
import { processAlive, SELF } from "./writer-gate.js";
import { ReferenceSourceError, type ReferenceSources } from "./reference-source.js";

/**
 * Generations whose turn runs in this process (`running`), and the subset that
 * still accepts grants (`accepting`). Process-wide, so any service instance in
 * this process reads the same liveness evidence.
 */
const running = new Set<string>(), accepting = new Set<string>();
/** Accesses in flight per generation; retiring a generation waits for them. */
const inflight = new Map<string, Set<Promise<unknown>>>();
/**
 * One operation at a time per worktree or generation, across every service
 * instance in this process: a grant and a removal of one worktree never
 * interleave (#2431).
 */
const chains = new Map<string, Promise<unknown>>();

type Client = ReturnType<typeof createNativeBrainManagerClient>;
export type ReferenceWorktreePool = Pick<Client, "poolStatus" | "poolCreate" | "poolRelease" | "poolCheckpoint" | "poolDelta"
  | "poolAccessOpen" | "poolAccess" | "poolPark" | "poolAccessClose" | "listPoolRecovery">;

/** Inactivity after which an unheld worktree expires; only explicit access, resumption or renewal resets it. */
export const REFERENCE_WORKTREE_INACTIVITY_MS = 3 * 24 * 60 * 60 * 1000;
/** Changed paths named in a cleanup fact; the count is always complete. */
const SAMPLE = 16;

export type ReferenceWorktreeErrorCode = "invalid" | "unauthorized" | "missing" | "unavailable" | "capacity" | "released" | "busy";
export class ReferenceWorktreeError extends Error {
  constructor(readonly code: ReferenceWorktreeErrorCode, message: string) { super(message); this.name = "ReferenceWorktreeError"; }
}

/** Durable evidence for cleanup review. Eligible only with no holder and no work since the baseline. */
export interface ReferenceWorktreeCleanup {
  reason: "released" | "expired";
  assessedAt: number;
  /** The holding worker generation: none, live, or one whose liveness cannot be established. */
  owner: "none" | "live" | "unknown";
  /** Changes since the baseline checkpoint: none, unpreserved work, or not established. */
  work: "none" | "unpreserved" | "unknown";
  changedPaths: number | null;
  /** Changed candidates whose metadata could not be compared. */
  unverifiedPaths: number | null;
  sample: string[];
  /** SHA-1 over every changed path and what it holds, sorted; null when work was not established. */
  digest?: string | null;
  error: string | null;
  eligible: boolean;
}

export interface ReferenceWorktree {
  id: string;
  domain: "public" | "private";
  repository: string;
  revision: string;
  /** Fixed starting commit; the worktree never moves with its source. */
  commit: string;
  state: "active" | "released" | "expired";
  allowanceBytes: number;
  createdAt: number;
  /** Last explicit access, resumption or renewal. */
  accessedAt: number;
  expiresAt: number;
  releasedAt: number | null;
  /** Worker generation that currently holds it, else null. */
  generation: string | null;
  cleanup: ReferenceWorktreeCleanup | null;
}

/** What a removal must still find true just before it deletes; a returned reason refuses it. */
export interface ReferenceWorktreeRemoval {
  trigger: "automatic" | "review";
  /** The eligibility or reviewed fingerprint the removal was admitted under. */
  premise: string;
  expect: (fresh: { row: ReferenceWorktreeRow; work: Pick<ReferenceWorktreeCleanup, "work" | "changedPaths" | "unverifiedPaths" | "sample" | "digest" | "error"> }) => string | null;
  /** The requesting principal's authority, read once more after every await; it throws to refuse. */
  authorize?: () => void;
}
export type ReferenceWorktreeRemovalOutcome = { status: "deleted" | "reclaimed" } | { status: "refused" | "failed"; reason: string };

export interface ReferenceWorktreeGeneration { id: string; path: string; principalId: string; turnId: string; profile: "governed" | "strict" }

/** A worktree's durable host record. */
export interface ReferenceWorktreeRow {
  id: string; principal_id: string; domain: string; repository: string; revision: string; base_commit: string | null; source_root: string; baseline: string | null;
  allowance: number; state: "creating" | "active" | "released" | "expired"; created_at: number; accessed_at: number; released_at: number | null; holder: string | null; cleanup: string | null;
  root_uuid: string | null;
}
type WorktreeRow = ReferenceWorktreeRow;
/** A removal's durable receipt (#2431). */
export interface ReferenceWorktreeCleanupReceipt {
  worktree_id: string; trigger: "automatic" | "review"; state: "started" | "deleted" | "reclaimed" | "failed" | "interrupted";
  premise: string; started_at: number; finished_at: number | null; error: string | null;
}
interface GenerationRow {
  id: string; principal_id: string; turn_id: string; profile: "governed" | "strict"; path: string; owner_pid: number; owner_start: string; owner_boot: string;
  owner_pid_namespace: string; opened_at: number; closed_at: number | null;
}

/** Worktrees keep their source root's extents: capacity eviction of that root would free nothing. */
export function referenceWorktreeDependents(db: Database, rootId: string): boolean {
  // A removed worktree whose reclamation was observed holds nothing of its source any more.
  return Boolean(db.query(`SELECT 1 FROM reference_worktrees w WHERE w.source_root = ? AND NOT EXISTS
    (SELECT 1 FROM reference_worktree_cleanups c WHERE c.worktree_id = w.id AND c.state = 'reclaimed') LIMIT 1`).get(rootId));
}

/** This process's owner identity, recorded with each generation it opens. */
export function referenceWorktreeOwner(): { pid: number; start: string; boot: string; pidNamespace: string } {
  return { pid: SELF.pid, start: SELF.start, boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pidNamespace: String(statSync("/proc/self/ns/pid", { bigint: true }).ino) };
}

type Owner = ReturnType<typeof referenceWorktreeOwner>;
/** Record a checkpoint before the pool creates it, so recovery can tell whose it is. */
export function recordReferenceWorktreeCheckpoint(db: Database, owner: Owner, id: string, worktreeId: string, at = Date.now()): Promise<void> {
  return referenceWrites(db)("recordCheckpoint", id, worktreeId, owner.pid, owner.start, owner.boot, owner.pidNamespace, at);
}
export function forgetReferenceWorktreeCheckpoint(db: Database, id: string): Promise<void> {
  return referenceWrites(db)("forgetCheckpoint", id);
}

export function createReferenceWorktrees(options: {
  db: Database; pool: ReferenceWorktreePool; sources: Pick<ReferenceSources, "request" | "covers">;
  /**
   * Journal coverage for a worktree a worker generation is about to reach.
   * Absent: access refuses, so no write path exists without the journal.
   */
  coverage?: (input: { turnId: string; worktreeId: string }, signal?: AbortSignal) => Promise<void>;
  inactivityMs?: number;
  now?: () => number;
  owner?: ReturnType<typeof referenceWorktreeOwner>;
  log?: Logger;
}) {
  const { db, pool } = options;
  const write = referenceWrites(db);
  const now = options.now ?? Date.now, inactivity = options.inactivityMs ?? REFERENCE_WORKTREE_INACTIVITY_MS;
  if (!Number.isSafeInteger(inactivity) || inactivity < 1) throw new ReferenceWorktreeError("invalid", "worktree inactivity must be a positive integer");
  const owner = options.owner ?? referenceWorktreeOwner();
  /** Generations this instance opened; closing the instance ends their registration. */
  const opened = new Set<string>();
  /** This instance's own operations; closing waits for them. */
  const mine = new Set<Promise<unknown>>();
  let closed = false;

  /** One operation at a time per worktree or generation. */
  function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const settled = next.catch(() => {});
    chains.set(key, settled); mine.add(settled);
    void settled.then(() => { mine.delete(settled); if (chains.get(key) === settled) chains.delete(key); });
    return next;
  }
  const worktree = (id: string) => db.query("SELECT * FROM reference_worktrees WHERE id = ?").get(id) as WorktreeRow | null;
  const generation = (id: string) => db.query("SELECT * FROM reference_worktree_generations WHERE id = ?").get(id) as GenerationRow | null;
  function warn(body: string, error: unknown) {
    options.log?.emit({ severityText: "WARN", body: `${body}: ${error instanceof Error ? error.message : String(error)}` });
  }
  function view(row: WorktreeRow): ReferenceWorktree {
    return { id: row.id, domain: row.domain === "public" ? "public" : "private", repository: row.repository, revision: row.revision, commit: row.base_commit ?? "",
      state: row.state === "creating" ? "active" : row.state, allowanceBytes: row.allowance, createdAt: row.created_at, accessedAt: row.accessed_at,
      expiresAt: row.accessed_at + inactivity, releasedAt: row.released_at, generation: row.holder, cleanup: row.cleanup ? JSON.parse(row.cleanup) : null };
  }
  /** A principal sees only its own worktrees; another principal's identity reads as missing. */
  function owned(id: string, principalId: string): WorktreeRow {
    const row = worktree(id);
    if (!row || row.principal_id !== principalId || row.state === "creating") throw new ReferenceWorktreeError("missing", "No managed worktree with this identity belongs to you.");
    return row;
  }

  /**
   * Whether a generation's workers may still be running. True: its turn is
   * running in this process, or another live owner holds it. False: positive
   * evidence that it ended (closed, another boot, a dead owner, or a turn this
   * process no longer runs). Null: liveness cannot be established.
   */
  function live(row: GenerationRow): boolean | null {
    if (row.closed_at !== null) return false;
    if (row.owner_boot !== owner.boot) return false;
    if (row.owner_pid_namespace !== owner.pidNamespace) return null;
    if (row.owner_pid === owner.pid && row.owner_start === owner.start) return running.has(row.id);
    return processAlive(row.owner_pid, row.owner_start);
  }
  function holderState(row: WorktreeRow): boolean | null {
    if (!row.holder) return false;
    const holder = generation(row.holder);
    // A holder with no record has no evidence either way.
    return holder ? live(holder) : null;
  }

  /**
   * Authority is read again for new access: a path or cached identity alone
   * grants nothing. A worktree of private source needs a live grant covering
   * its repository, whatever the revision's current visibility; the
   * repository's revision is then validated under the source's own clocks.
   */
  async function authorize(row: Pick<WorktreeRow, "principal_id" | "repository" | "revision" | "domain">, signal?: AbortSignal) {
    covered(row);
    try { (await options.sources.request({ principalId: row.principal_id, repository: row.repository, revision: row.revision, signal })).release(); }
    catch (error) {
      if (error instanceof ReferenceSourceError) throw new ReferenceWorktreeError(error.code === "cancelled" || error.code === "busy" ? "unavailable"
        : error.code === "missing" || error.code === "invalid" ? "unauthorized" : error.code, `Worktree authority could not be confirmed: ${error.message}`);
      throw error;
    }
  }
  /** A private worktree's grant, read live; checked again after every await before a grant. */
  function covered(row: Pick<WorktreeRow, "principal_id" | "repository" | "domain">) {
    if (row.domain !== "public" && !options.sources.covers({ principalId: row.principal_id, repository: row.repository }))
      throw new ReferenceWorktreeError("unauthorized", "No live reference grant covers this private worktree's repository.");
  }

  /** Changes since the baseline, from one fresh checkpoint and a metadata delta; nothing of the worktree is executed. */
  async function assessWork(row: WorktreeRow, signal?: AbortSignal): Promise<Pick<ReferenceWorktreeCleanup, "work" | "changedPaths" | "unverifiedPaths" | "sample" | "digest" | "error">> {
    const unknown = (error: string) => ({ work: "unknown" as const, changedPaths: null, unverifiedPaths: null, sample: [], digest: null, error });
    if (!row.baseline) return unknown("The worktree has no baseline checkpoint.");
    const id = randomUUID();
    let current: NativePoolCheckpoint | undefined, recorded = false;
    try {
      const baseline = await pool.poolCheckpoint(row.baseline, row.id, signal);
      await recordReferenceWorktreeCheckpoint(db, owner, id, row.id, now()); recorded = true;
      current = await pool.poolCheckpoint(id, row.id, signal);
      const delta = await pool.poolDelta(baseline.id, current.id, signal);
      void delta.completed.catch(() => {});
      const candidates = new Set<string>();
      for await (const candidate of parseNativeBrainDelta(delta.stream, {
        before: { uuid: baseline.root!.uuid, transaction: BigInt(baseline.transaction) },
        after: { uuid: current.root!.uuid, transaction: BigInt(current.transaction) }, signal,
      })) {
        for (const path of candidate.paths) if (path) candidates.add(path);
        // Both ends of a rename are compared, so a swap through a temporary name is seen.
        if (candidate.rename) for (const path of [candidate.rename.from, candidate.rename.to]) if (path) candidates.add(path);
      }
      await delta.completed;
      const changed: string[] = [], stamps: string[] = [], budget = { bytes: HASH_BUDGET };
      let unverified = 0;
      // Any differing entry is work, directories included: a rename or swap
      // changes the directories it moves even when every name still exists.
      for (const path of [...candidates].sort()) {
        const before = stamp(join(baseline.path!, path)), after = stamp(join(current.path!, path));
        if (before === undefined || after === undefined) unverified++;
        else if (before !== after) {
          const held = after === null ? "absent" : await content(join(current.path!, path), budget);
          changed.push(path); stamps.push(`${path}\t${held}`);
          if (held === "unreadable") unverified++;
        }
      }
      return { work: changed.length ? "unpreserved" : unverified ? "unknown" : "none", changedPaths: changed.length, unverifiedPaths: unverified,
        // The digest moves with every edit to a changed path, not only with which paths changed.
        sample: changed.slice(0, SAMPLE), digest: createHash("sha1").update(stamps.join("\n")).digest("hex"), error: null };
    } catch (error) { return unknown(error instanceof Error ? error.message : String(error)); }
    finally {
      // Released even when its creation reply was lost: the identity is recorded, so it is never left behind.
      if (recorded) await pool.poolRelease(id).then(() => forgetReferenceWorktreeCheckpoint(db, id),
        cleanup => warn("worktree assessment checkpoint release failed; startup recovery retries it", cleanup));
    }
  }
  /**
   * Record release or expiry facts. With `remove`, a positively clean and
   * unheld worktree is then removed, revalidated once more just before.
   */
  async function assess(row: WorktreeRow, reason: "released" | "expired", signal?: AbortSignal, remove = true): Promise<ReferenceWorktreeCleanup> {
    const holder = holderState(row);
    const ownerState = holder === false ? "none" : holder ? "live" : "unknown";
    // A live or unknown holder may still be writing: no work assessment can be final.
    const work = ownerState === "none" ? await assessWork(row, signal)
      : { work: "unknown" as const, changedPaths: null, unverifiedPaths: null, sample: [], digest: null, error: null };
    const facts: ReferenceWorktreeCleanup = { reason, assessedAt: now(), owner: ownerState, ...work, eligible: ownerState === "none" && work.work === "none" };
    await write("assess", JSON.stringify(facts), row.id);
    // A removal that cannot run now leaves a clean worktree for the next reconciliation; release and expiry still succeed.
    if (remove && facts.eligible) await removeClean(worktree(row.id)!, signal).catch(error => warn("automatic worktree removal did not run; reconciliation retries it", error));
    return facts;
  }
  /** Automatic removal: only a worktree whose fresh assessment is still positively clean and unheld. */
  function removeClean(row: WorktreeRow, signal?: AbortSignal) {
    return removeWorktree(row, { trigger: "automatic", premise: "eligible",
      expect: fresh => fresh.work.work === "none" ? null : "The worktree is no longer positively clean." }, signal);
  }

  const cleanupOf = (id: string) => db.query("SELECT * FROM reference_worktree_cleanups WHERE worktree_id = ?").get(id) as ReferenceWorktreeCleanupReceipt | null;
  /** A removal admitted, applied or observed: never applied again through this identity. */
  const removed = (id: string) => ["started", "deleted", "reclaimed"].includes(cleanupOf(id)?.state ?? "");
  async function poolRecord(id: string, signal?: AbortSignal): Promise<NativePoolRecord | null> {
    for (let after: string | null = null; ;) {
      const page = await pool.listPoolRecovery(after, signal);
      const found = page.records.find(record => record.id === id);
      if (found || !page.next) return found ?? null;
      after = page.next;
    }
  }
  /** The checkpoints that keep a worktree's extents charged: its baseline and any ledger entry. */
  function checkpointsOf(row: WorktreeRow): string[] {
    const ledger = (db.query("SELECT id FROM reference_worktree_checkpoints WHERE worktree_id = ?").all(row.id) as { id: string }[]).map(item => item.id);
    return [...new Set([...(row.baseline ? [row.baseline] : []), ...ledger])];
  }
  /**
   * The only destructive effect on a worktree (#2431). Immediately before it,
   * the worktree must still be released or expired, held by no live or
   * unknown owner, the same native root, unchanged while it was assessed, and
   * its fresh assessment must satisfy the caller's premise; then the caller's
   * authority is read once more. The receipt is recorded before the pool is
   * asked, so a restart reads its outcome instead of deleting again. The
   * worktree goes first and its checkpoints after: a failure before the
   * worktree is deleted keeps the baseline, so the work stays assessable.
   */
  async function removeWorktree(row: WorktreeRow, input: ReferenceWorktreeRemoval, signal?: AbortSignal): Promise<ReferenceWorktreeRemovalOutcome> {
    const refuse = (reason: string) => ({ status: "refused" as const, reason });
    const prior = cleanupOf(row.id)?.state ?? null;
    if (removed(row.id)) return refuse("The worktree was already removed.");
    if (row.state !== "released" && row.state !== "expired") return refuse("Only a released or expired worktree is removed.");
    if (row.holder || holderState(row) !== false) return refuse("A worker may still hold this worktree.");
    const work = await assessWork(row, signal);
    // The pool's view last, after the assessment: no access generation holds the root, and it is still the one recorded.
    const record = await poolRecord(row.id, signal);
    if (!record || record.purpose !== "worktree" || record.state !== "writable" || record.access !== null || !row.root_uuid || record.root?.uuid !== row.root_uuid)
      return refuse("The native worktree no longer matches its recorded identity.");
    const current = worktree(row.id)!;
    if (current.holder || current.accessed_at !== row.accessed_at || current.state !== row.state || (cleanupOf(row.id)?.state ?? null) !== prior)
      return refuse("The worktree changed while it was assessed.");
    // Partly unknown is unknown: a path that could not be compared is never removed unseen.
    if (work.work === "unknown" || work.unverifiedPaths !== 0) return refuse("The worktree's work cannot be established; it is kept.");
    const premise = input.expect({ row: current, work });
    if (premise) return refuse(premise);
    try { input.authorize?.(); } catch (error) { return refuse(error instanceof Error ? error.message : String(error)); }
    // Submit immediately after the checks; keep the serial section until the receipt commits.
    await write("startRemoval", row.id, input.trigger, input.premise, now());
    let receipt: NativePoolRecord;
    try { receipt = await pool.poolRelease(row.id, signal); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // The pool may have committed the deletion before the reply was lost.
      const after = await poolRecord(row.id).catch(() => undefined);
      if (after === undefined) { warn("worktree removal outcome unknown; reconciliation reads it", error); return { status: "failed", reason }; }
      if (!after || after.state === "writable") {
        await write("failRemoval", now(), reason.slice(0, 1000), row.id);
        return { status: "failed", reason };
      }
      receipt = after;
    }
    await write("finishRemoval", receipt.state === "reclaimed" ? "reclaimed" : "deleted", now(), row.id);
    await settle(row.id, signal, false);
    return { status: cleanupOf(row.id)!.state as "deleted" | "reclaimed" };
  }
  /**
   * Finish what a removal left: an outcome lost to a restart or a lost reply
   * is read from the pool and never applied again, a deletion the pool
   * committed is completed, the removed worktree's checkpoints are released,
   * and only the pool's observed reclamation credits the removal.
   */
  async function settle(id: string, signal?: AbortSignal, retry = true) {
    const cleanup = cleanupOf(id);
    if (!cleanup || !["started", "deleted", "reclaimed"].includes(cleanup.state)) return;
    let record = await poolRecord(id, signal).catch(() => undefined);
    if (record === undefined) return;
    if (cleanup.state === "started") {
      if (!record || record.state === "writable") {
        await write("interruptRemoval", now(), "The removal was interrupted before the pool deleted the worktree.", id);
        return;
      }
      await write("observeDeletion", now(), id);
    }
    // The pool committed this deletion; finishing it is the same effect, not a second one.
    if (record && record.state === "deleting") record = await pool.poolRelease(id, signal).catch(error => { warn("committed worktree deletion not yet finished", error); return record; });
    const row = worktree(id);
    if (row) for (const checkpoint of checkpointsOf(row)) {
      // Released once: a removed worktree never names its baseline again.
      const forget = () => write("forgetBaseline", id, checkpoint);
      try {
        // A retry first asks the pool. With the worktree deleted no checkpoint of it
        // can still be created, so an identity the pool no longer records is gone:
        // released before a crash, or reclaimed and forgotten. Releasing it again
        // would fail or leave a tombstone.
        if (retry && await poolRecord(checkpoint, signal) === null) { await forget(); continue; }
        await pool.poolRelease(checkpoint, signal);
        await forget();
      } catch (error) {
        const record = await poolRecord(checkpoint).catch(() => undefined);
        if (record === null || (record && (record.state === "deleted" || record.state === "reclaimed"))) await forget();
        else warn("removed worktree's checkpoint was not released; reconciliation retries it", error);
      }
    }
    // Releasing the checkpoints can complete the worktree's reclamation.
    const observed = await poolRecord(id, signal).catch(() => record);
    if (observed?.state === "reclaimed") await write("observeReclamation", id);
  }
  /** Settle every removal still open: unfinished, awaiting reclamation, or leaving a checkpoint behind. */
  async function settleAll(signal?: AbortSignal) {
    const open = db.query(`SELECT c.worktree_id AS id FROM reference_worktree_cleanups c LEFT JOIN reference_worktrees w ON w.id = c.worktree_id
      WHERE c.state IN ('started', 'deleted') OR (c.state = 'reclaimed' AND (w.baseline IS NOT NULL
        OR EXISTS (SELECT 1 FROM reference_worktree_checkpoints k WHERE k.worktree_id = c.worktree_id)))`).all() as { id: string }[];
    for (const { id } of open) await serial(id, () => settle(id, signal));
  }
  /** Return a worktree whose holder is provably gone to the masked roots, then forget the holder. */
  async function recoverHolder(row: WorktreeRow, signal?: AbortSignal): Promise<WorktreeRow> {
    await pool.poolPark(row.id, signal);
    await write("recoverHolder", row.id, row.holder);
    return worktree(row.id)!;
  }

  async function allocate(input: { principalId: string; repository: unknown; revision: unknown; signal?: AbortSignal }): Promise<ReferenceWorktree> {
    if (closed) throw new ReferenceWorktreeError("unavailable", "Managed worktrees are closed.");
    let lease;
    try { lease = await options.sources.request({ principalId: input.principalId, repository: input.repository, revision: input.revision, signal: input.signal }); }
    catch (error) {
      if (error instanceof ReferenceSourceError) throw new ReferenceWorktreeError(error.code === "cancelled" || error.code === "busy" ? "unavailable" : error.code, error.message);
      throw error;
    }
    const id = randomUUID(), at = now();
    try {
      const allowance = (await pool.poolStatus(input.signal)).limits.operationBytes;
      // Recorded before the pool sees it: recovery and eviction protection both start here.
      await write("allocate", id, input.principalId, lease.domain === "public" ? "public" : `private:${input.principalId}`, lease.repository, lease.revision, lease.commit, lease.rootId, allowance, at, at);
      try {
        const created = await pool.poolCreate(id, "worktree", lease.rootId, allowance, input.signal);
        await write("recordRoot", created.root?.uuid ?? null, id);
        const baseline = randomUUID();
        await write("recordBaseline", baseline, id);
        await pool.poolCheckpoint(baseline, id, input.signal);
      } catch (error) {
        await discard(id).catch(cleanup => warn("unfinished worktree was not released; startup recovery retries it", cleanup));
        const code = (error as { code?: string }).code;
        throw new ReferenceWorktreeError(code === "capacity" ? "capacity" : "unavailable", `The worktree could not be created: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Allocation is an explicit access: the inactivity clock starts now.
      await write("activate", now(), id);
      return view(worktree(id)!);
    } finally { lease.release(); }
  }
  /** Release an unfinished allocation's roots; its record goes only once the pool confirms. */
  async function discard(id: string) {
    const row = worktree(id);
    if (!row) return;
    if (row.baseline) await pool.poolRelease(row.baseline);
    await pool.poolRelease(id);
    await write("discard", id);
  }

  /** Open one worker generation of a running turn: an empty directory its workers bind whole. */
  async function openGeneration(input: { principalId: string; turnId: string; profile: "governed" | "strict"; signal?: AbortSignal }): Promise<ReferenceWorktreeGeneration> {
    if (closed) throw new ReferenceWorktreeError("unavailable", "Managed worktrees are closed.");
    if (input.profile !== "governed" && input.profile !== "strict") throw new ReferenceWorktreeError("invalid", "Only interactive worker profiles hold managed worktrees.");
    const id = randomUUID();
    const access = await pool.poolAccessOpen(id, input.signal);
    await write("openGeneration", id, input.principalId, input.turnId, input.profile, access.path, owner.pid, owner.start, owner.boot, owner.pidNamespace, now());
    running.add(id); accepting.add(id); opened.add(id);
    return { id, path: access.path, principalId: input.principalId, turnId: input.turnId, profile: input.profile };
  }
  /**
   * End a generation once its workers exited and its final observation is
   * recorded: park everything it holds, then assess released and expired
   * worktrees it was keeping.
   */
  /**
   * Stop granting to a generation and wait for accesses already in flight.
   * Run it before the turn's final observation: everything granted is then
   * covered by that observation, and nothing is granted after it.
   */
  async function retireGeneration(id: string): Promise<void> {
    accepting.delete(id);
    await Promise.allSettled([...(inflight.get(id) ?? [])]);
  }
  function closeGeneration(id: string, signal?: AbortSignal): Promise<void> {
    return serial(`generation:${id}`, async () => {
      await retireGeneration(id);
      const row = generation(id);
      if (!row) { running.delete(id); return; }
      const held = db.query("SELECT id FROM reference_worktrees WHERE holder = ?").all(id) as { id: string }[];
      // Hold each worktree's queue through parking and the one close transaction.
      // A renewal/release already admitted there commits before the turn's end effects.
      const keys = held.map(row => row.id).sort();
      const closing = (index: number): Promise<void> => index < keys.length
        ? serial(keys[index]!, () => closing(index + 1)) : finish();
      async function finish() {
        // Its turn is over either way: a failed close leaves a generation recovery can prove ended.
        try { await pool.poolAccessClose(id, signal); } finally { running.delete(id); }
        await write("closeGeneration", id, now());
        for (const { id: worktreeId } of held) {
          const current = worktree(worktreeId);
          if (current && (current.state === "released" || current.state === "expired")) await assess(current, current.state, signal);
        }
      }
      await closing(0);
    });
  }

  function access(input: { worktreeId: string; principalId: string; generation: string; signal?: AbortSignal }): Promise<ReferenceWorktree> {
    // Registered before any await, so retiring the generation waits for this access.
    if (!accepting.has(input.generation))
      return Promise.reject(new ReferenceWorktreeError("unavailable", "This worker generation is not running; no worktree can be made available to it."));
    const pending = inflight.get(input.generation) ?? new Set<Promise<unknown>>();
    inflight.set(input.generation, pending);
    const work = grant(input);
    pending.add(work);
    void work.catch(() => {}).finally(() => { pending.delete(work); if (!pending.size) inflight.delete(input.generation); });
    return work;
  }
  function grant(input: { worktreeId: string; principalId: string; generation: string; signal?: AbortSignal }): Promise<ReferenceWorktree> {
    return serial(input.worktreeId, async () => {
      if (closed) throw new ReferenceWorktreeError("unavailable", "Managed worktrees are closed.");
      const target = generation(input.generation);
      // Only a generation this process opened for a running turn receives a grant.
      if (!target || target.closed_at !== null || !accepting.has(target.id) || live(target) !== true)
        throw new ReferenceWorktreeError("unavailable", "This worker generation is not running; no worktree can be made available to it.");
      if (target.principal_id !== input.principalId) throw new ReferenceWorktreeError("unauthorized", "This worker generation belongs to another principal.");
      let row = owned(input.worktreeId, input.principalId);
      // Once a removal was admitted the identity is final, whatever its outcome.
      if (row.state === "released" || cleanupOf(row.id)) throw new ReferenceWorktreeError("released", "This worktree was released; request a new one.");
      if (!options.coverage) throw new ReferenceWorktreeError("unavailable", "Journal coverage for managed worktrees is unavailable; access is refused.");
      if (row.holder && row.holder !== target.id) {
        const holder = holderState(row);
        if (holder !== false) throw new ReferenceWorktreeError("busy", holder ? "Another running worker holds this worktree." : "Another worker may still hold this worktree; its liveness is unknown.");
        row = await recoverHolder(row, input.signal);
      }
      await authorize(row, input.signal);
      if (row.holder !== target.id) {
        // Coverage first: no worker reaches a worktree its journal does not observe.
        await options.coverage({ turnId: target.turn_id, worktreeId: row.id }, input.signal);
        // Authority may have ended while revalidation or coverage awaited.
        covered(row);
        await pool.poolAccess(row.id, target.id, input.signal);
        // A removal admitted elsewhere while the grant awaited wins: the grant is withdrawn, never recorded.
        if (cleanupOf(row.id)) {
          await pool.poolPark(row.id).catch(error => warn("withdrawn worktree grant was not parked", error));
          throw new ReferenceWorktreeError("released", "This worktree was released; request a new one.");
        }
      }
      // Explicit access or resumption: the only events, with renewal, that move the clock.
      await write("grant", target.id, now(), row.id);
      return view(worktree(row.id)!);
    });
  }
  /** `live`, when given, is read where the effect runs: a caller whose turn ended changes nothing (#2432). */
  function renew(input: { worktreeId: string; principalId: string; live?: () => boolean }): Promise<ReferenceWorktree> {
    return serial(input.worktreeId, async () => {
      if (input.live && !input.live()) throw new ReferenceWorktreeError("unavailable", "The turn that asked for this ended first; nothing changed.");
      const row = owned(input.worktreeId, input.principalId);
      if (cleanupOf(row.id)) throw new ReferenceWorktreeError("released", "This worktree was released.");
      if (row.state !== "active") throw new ReferenceWorktreeError(row.state === "released" ? "released" : "unavailable",
        row.state === "released" ? "This worktree was released." : "This worktree expired; access it again to resume it.");
      await write("renew", now(), row.id);
      return view(worktree(row.id)!);
    });
  }
  function release(input: { worktreeId: string; principalId: string; signal?: AbortSignal; live?: () => boolean }): Promise<ReferenceWorktree> {
    return serial(input.worktreeId, async () => {
      if (input.live && !input.live()) throw new ReferenceWorktreeError("unavailable", "The turn that asked for this ended first; nothing changed.");
      let row = owned(input.worktreeId, input.principalId);
      if (row.state === "released") return view(row);
      await write("release", now(), row.id);
      row = worktree(row.id)!;
      // A live holder keeps it until its generation closes, after the final observation.
      if (holderState(row) === false && row.holder) row = await recoverHolder(row, input.signal);
      if (holderState(row) !== true) await assess(row, "released", input.signal);
      return view(worktree(row.id)!);
    });
  }

  /**
   * Inactivity expiry and holder recovery. A live holder keeps its worktree
   * past expiry; a holder that is provably gone is recovered; a holder whose
   * liveness is unknown keeps ownership, and its worktree stays charged.
   */
  async function reconcile(signal?: AbortSignal): Promise<{ expired: string[]; recovered: string[]; retained: string[] }> {
    const result = { expired: [] as string[], recovered: [] as string[], retained: [] as string[] };
    const due = db.query("SELECT id FROM reference_worktrees WHERE (state = 'active' AND accessed_at + ? <= ?) OR (state IN ('released', 'expired') AND holder IS NOT NULL)")
      .all(inactivity, now()) as { id: string }[];
    for (const { id } of due) await serial(id, async () => {
      let row = worktree(id);
      if (!row) return;
      const expiring = row.state === "active";
      if (expiring && row.accessed_at + inactivity > now()) return;
      const holder = holderState(row);
      if (holder === true) { result.retained.push(id); return; }
      if (holder === false && row.holder) { row = await recoverHolder(row, signal); result.recovered.push(id); }
      if (holder === null) result.retained.push(id);
      if (expiring) { await write("expire", id); result.expired.push(id); row = worktree(id)!; }
      await assess(row, row.state === "released" ? "released" : "expired", signal);
    });
    // A positively clean worktree whose automatic removal did not run (a
    // refused race, or facts recorded without removal) is removed now.
    const clean = db.query(`SELECT w.id FROM reference_worktrees w WHERE w.state IN ('released', 'expired') AND w.holder IS NULL
      AND NOT EXISTS (SELECT 1 FROM reference_worktree_cleanups c WHERE c.worktree_id = w.id)`).all() as { id: string }[];
    for (const { id } of clean) await serial(id, async () => {
      const row = worktree(id);
      if (row && (row.state === "released" || row.state === "expired") && !row.holder && !cleanupOf(id) && row.cleanup && (JSON.parse(row.cleanup) as ReferenceWorktreeCleanup).eligible)
        await removeClean(row, signal);
    });
    await settleAll(signal);
    return result;
  }

  /** After a restart: finish unfinished allocations and close generations whose owner is provably gone. */
  async function recover(signal?: AbortSignal): Promise<{ discarded: string[]; closed: string[]; retained: string[] }> {
    const result = { discarded: [] as string[], closed: [] as string[], retained: [] as string[] };
    // A removal interrupted by a restart: read its outcome from the pool, never apply it again.
    await settleAll(signal);
    // A worktree recorded before its native identity was: adopt the identity of
    // the writable worktree root the pool holds under its ID and source.
    for (const row of db.query("SELECT * FROM reference_worktrees WHERE root_uuid IS NULL AND state != 'creating'").all() as WorktreeRow[]) {
      const record = await poolRecord(row.id, signal).catch(() => null);
      if (record?.purpose === "worktree" && record.state === "writable" && record.from === row.source_root && record.root)
        await write("adoptRoot", record.root.uuid, row.id);
    }
    for (const { id } of db.query("SELECT id FROM reference_worktrees WHERE state = 'creating'").all() as { id: string }[]) {
      try { await discard(id); result.discarded.push(id); } catch (error) { warn("unfinished worktree release failed", error); result.retained.push(id); }
    }
    for (const row of db.query("SELECT * FROM reference_worktree_generations WHERE closed_at IS NULL").all() as GenerationRow[]) {
      if (live(row) !== false) { result.retained.push(row.id); continue; }
      try { await closeGeneration(row.id, signal); result.closed.push(row.id); } catch (error) { warn("abandoned worktree generation could not be closed", error); result.retained.push(row.id); }
    }
    // Journal and assessment checkpoints are released only when the process
    // that took them is provably gone; a live or unverifiable owner keeps them.
    const checkpoints = db.query("SELECT * FROM reference_worktree_checkpoints").all() as (Omit<GenerationRow, "principal_id" | "turn_id" | "profile" | "path" | "opened_at" | "closed_at">
      & { worktree_id: string })[];
    for (const row of checkpoints) {
      const ended = row.owner_boot !== owner.boot ? true : row.owner_pid_namespace !== owner.pidNamespace ? null
        : row.owner_pid === owner.pid && row.owner_start === owner.start ? false : !processAlive(row.owner_pid, row.owner_start);
      if (ended !== true) { result.retained.push(row.id); continue; }
      try { await pool.poolRelease(row.id, signal); await forgetReferenceWorktreeCheckpoint(db, row.id); }
      catch (error) { warn("stale worktree checkpoint was not released", error); result.retained.push(row.id); }
    }
    await reconcile(signal);
    return result;
  }

  return {
    allocate, access, renew, release, reconcile, recover,
    openGeneration, retireGeneration, closeGeneration,
    /** Hygiene review's revalidated removal of one released or expired worktree (#2431). */
    remove(worktreeId: string, input: ReferenceWorktreeRemoval, signal?: AbortSignal): Promise<ReferenceWorktreeRemovalOutcome> {
      return serial(worktreeId, async () => {
        const row = worktree(worktreeId);
        return row && row.state !== "creating" ? removeWorktree(row, input, signal) : { status: "refused" as const, reason: "No managed worktree has this identity." };
      });
    },
    /**
     * Assess a released or expired worktree again now. Removal follows only
     * with `remove`, so a preview never deletes anything.
     */
    reassess(worktreeId: string, options: { remove: boolean; signal?: AbortSignal }): Promise<void> {
      return serial(worktreeId, async () => {
        const row = worktree(worktreeId);
        // An unresolved removal is read from the pool first; it is never reported gone on a guess.
        if (cleanupOf(worktreeId)?.state === "started") await settle(worktreeId, options.signal);
        // After a failed or interrupted removal the evidence may still be refreshed, never acted on.
        if (row && (row.state === "released" || row.state === "expired") && !removed(row.id)) await assess(row, row.state, options.signal, options.remove && !cleanupOf(row.id));
      });
    },
    /** Every worktree with its removal receipt and holder liveness, read from host state only. */
    inventory(): { row: ReferenceWorktreeRow; view: ReferenceWorktree; cleanup: ReferenceWorktreeCleanupReceipt | null; holderLive: boolean | null }[] {
      return (db.query("SELECT * FROM reference_worktrees WHERE state != 'creating' ORDER BY id").all() as WorktreeRow[]).map(row => ({
        row, view: view(row), cleanup: cleanupOf(row.id), holderLive: holderState(row),
      }));
    },
    get(input: { worktreeId: string; principalId: string }): ReferenceWorktree { return view(owned(input.worktreeId, input.principalId)); },
    list(principalId: string): ReferenceWorktree[] {
      return (db.query("SELECT * FROM reference_worktrees WHERE principal_id = ? AND state != 'creating' ORDER BY created_at, id").all(principalId) as WorktreeRow[]).map(view);
    },
    dependents(rootId: string): boolean { return referenceWorktreeDependents(db, rootId); },
    async close() {
      closed = true;
      // A closed service runs no turn: its generations are provably over for any later instance.
      for (const id of opened) { accepting.delete(id); running.delete(id); }
      await Promise.allSettled([...mine]);
    },
  };
}
export type ReferenceWorktrees = ReturnType<typeof createReferenceWorktrees>;

/** Bytes of changed files one assessment hashes; larger or sparse files fall back to snapshot-stable metadata. */
const HASH_BUDGET = 64 * 1024 * 1024;
/**
 * What one changed path holds: type, mode, size, link target and, for a
 * regular file within the assessment's hashing budget, a hash of its bytes,
 * read without blocking. A file beyond the budget is named by its inode,
 * modification and change time instead: a snapshot keeps them, and a worker
 * cannot set the change time. Times are otherwise excluded, since a worker
 * can set them.
 */
async function content(path: string, budget: { bytes: number }): Promise<string> {
  try {
    const info = lstatSync(path, { bigint: true });
    const meta = `${info.mode}:${info.size}:${info.isSymbolicLink() ? readlinkSync(path) : ""}`;
    if (!info.isFile()) return meta;
    if (info.size > BigInt(budget.bytes)) return `${meta}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`;
    budget.bytes -= Number(info.size);
    const hash = createHash("sha1");
    for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
    return `${meta}:${hash.digest("hex")}`;
  } catch { return "unreadable"; }
}
/** Metadata that changes with content, mode, type, links or link target; access time is excluded. */
function stamp(path: string): string | null | undefined {
  try {
    const info = lstatSync(path, { bigint: true });
    const target = info.isSymbolicLink() ? readlinkSync(path) : "";
    return `${info.mode}:${info.ino}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${target}`;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return undefined;
  }
}
