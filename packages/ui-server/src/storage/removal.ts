import { subprocessEnv } from "../config/env.js";
/** Human-authorized attachment edits with charged retained originals and durable per-item intent. */
import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { inspectStorageAttachment, removeStorageAttachment, restoreStorageAttachment, storageAttachmentPath, storageAttachmentVacant, StorageAttachmentRefusal, type StorageAttachmentVersion, type StorageAttachmentFacts } from "@schlessera/brain/storage";
import type { JournalVersion, StorageRemovalInspection, StorageRemovalCapability, StorageRemovalReview, StorageRemovalReceipt, StorageRemovalFile } from "@schlessera/brain-ui-sdk/protocol";
import { BRAIN_LOCK_KEY, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { GIT_LOCK_KEY } from "@schlessera/brain-ui-sdk/internal";
import { MAINTENANCE_ENTRY, type HostBoundary } from "../brain/host-boundary.js";
import type { TurnJournal } from "../brain/turn-journal.js";
import { SELF, processAlive, type WriterGate } from "../brain/writer-gate.js";
import { StorageUnavailable, type StorageCoordinator } from "./coordinator.js";
import { readRemovalFacts } from "./removal-facts.js";
import { storageObservation } from "./maintenance.js";

export const STORAGE_REMOVAL_LIMITS = Object.freeze({ items: 32, fileBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, milliseconds: 300_000, reviewMilliseconds: 60_000, receiptBytes: 262_144, receipts: 128 });
const REVIEW_TTL = 10 * 60_000, runningHere = new Set<string>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const prefix = (path: string, root: string) => root === "." || path === root || path.startsWith(`${root}/`);
type PrivateFile = { path: string; version: StorageAttachmentVersion | null; consequences: string; retained: JournalVersion | null };
type Row = { id: string; principal_id: string; action: "remove" | "undo"; source_id: string | null; selection: string; fingerprint: string; journal_turn_id: string; state: StorageRemovalReceipt["state"]; pid: number; pid_start: string; receipt: string; private_versions: string };
const factIdentity = (facts: StorageAttachmentFacts, path: string) => digest({ file: facts.files.find(file => file.path === path), complete: facts.complete, unchecked: facts.unchecked });
const encode = (value: unknown) => { const text = JSON.stringify(value); if (Buffer.byteLength(text) > STORAGE_REMOVAL_LIMITS.receiptBytes) throw new StorageUnavailable(400, "Attachment receipt exceeds its bound."); return text.padEnd(STORAGE_REMOVAL_LIMITS.receiptBytes); };
const validId = (id: string) => /^[a-zA-Z0-9_-]{16,96}$/.test(id);

export function createStorageRemoval(db: Database, options: {
  brainPath: string; boundary: Pick<HostBoundary, "isolated" | "status" | "run">; journal: TurnJournal; gate: WriterGate; lock: KeyedLock; storage: StorageCoordinator;
  authorized(principal: string): boolean;
  /** Existing operator-owned stores, represented relative to the canonical brain when applicable. */
  protectedPaths: readonly string[];
  retainedRoot?: string;
}) {
  const brain = realpathSync(options.brainPath), journal = options.journal;
  const record = (root: string, target: string, outcome: "success" | "no-space", error?: unknown) => {
    const code = (error as { code?: string; reason?: string } | undefined)?.code;
    const quota = code === "EDQUOT" || (error as { reason?: string } | undefined)?.reason === "journal_capacity";
    if (outcome === "success") for (const resource of ["bytes", "quota", "inodes", "unknown"] as const) options.storage.ownerWrite(root, target, resource, outcome);
    else if (quota || code === "ENOSPC") options.storage.ownerWrite(root, target, quota ? "quota" : "unknown", outcome);
  };
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const reviews = new Set<AbortController>(), pendingReviews = new Set<Promise<void>>(); let closed = false;
  const key = (id: string) => `${brain}:${id}`;
  const select = (id: string) => db.query("SELECT * FROM turn_journal_storage_operations WHERE id=? AND brain=?").get(id, brain) as Row | null;
  const authorize = (principal: string) => { if (!options.authorized(principal)) throw new StorageUnavailable(403, "Attachment removal requires current human-owner access."); };
  function capability(principal: string): StorageRemovalCapability {
    authorize(principal); reconcile(); const status = options.boundary.status();
    const latest = db.query("SELECT * FROM turn_journal_storage_operations WHERE brain=? AND principal_id=? ORDER BY requested_at DESC,rowid DESC LIMIT 1").get(brain, principal) as Row | null;
    const available = !closed && process.platform === "linux" && options.boundary.isolated() && status.available;
    return { available, reason: available ? null : "qualified_native_recovery_unavailable", limits: STORAGE_REMOVAL_LIMITS, latest: latest ? recover(latest) : null };
  }
  function protectedReason(path: string): string | null {
    if (!storageAttachmentPath(path)) return "unsupported_or_protected_attachment";
    const status = options.boundary.status();
    if (!status.available || status.profileFallback || !status.protectedPaths) return "protection_or_ownership_unknown";
    if ([...options.protectedPaths, ...status.protectedPaths.map(value => value.path)].some(root => prefix(path, root))) return "protected_owner_path";
    return null;
  }
  const save = (row: Row, result: StorageRemovalReceipt, versions?: PrivateFile[]) => journal.writeOperation(() => {
    db.query("UPDATE turn_journal_storage_operations SET state=?,receipt=?,private_versions=? WHERE id=? AND brain=?")
      .run(result.state, encode(result), versions ? encode(versions) : row.private_versions, row.id, brain);
    row.state = result.state; row.receipt = encode(result); if (versions) row.private_versions = encode(versions);
  });
  function recover(row: Row): StorageRemovalReceipt {
    const result = JSON.parse(row.receipt) as StorageRemovalReceipt;
    if (["waiting", "running"].includes(row.state) && (!processAlive(row.pid, row.pid_start) || row.pid === SELF.pid && row.pid_start === SELF.start && !runningHere.has(key(row.id)))) {
      result.state = row.state === "waiting" ? "refused" : "unknown"; result.reason = row.state === "waiting" ? "interrupted_before_effect" : "interrupted_outcome_unknown"; result.completedAt = Date.now();
      for (const item of result.items) if (item.state === "applying") { item.state = "unknown"; item.reason = "interrupted_outcome_unknown"; }
      try { save(row, result); } catch { /* Durable pending intent still prevents replay. */ }
    }
    const versions = JSON.parse(row.private_versions) as PrivateFile[];
    for (const item of result.items) {
      const original = versions.find(file => file.path === item.path)?.retained;
      item.undoAvailable = row.action === "remove" && item.state === "removed" && !!original && journal.hasRetainedVersion(row.journal_turn_id, original);
      item.undoReason = item.undoAvailable ? null : item.state === "removed" ? "retained_detail_expired_or_unavailable" : "no_confirmed_removal";
    }
    return result;
  }
  function reconcile() { for (const row of db.query("SELECT * FROM turn_journal_storage_operations WHERE brain=? AND state IN ('waiting','running')").all(brain) as Row[]) recover(row); }
  function receipt(principal: string, id: string) {
    authorize(principal); const row = select(id);
    if (!row || row.principal_id !== principal) throw new StorageUnavailable(404, "Attachment receipt unavailable.");
    return recover(row);
  }
  async function exclusive<T>(signal: AbortSignal, purpose: string, apply: () => Promise<T>): Promise<T> {
    const hold = await options.gate.acquire("exclusive", purpose, { queueTurns: true, signal });
    try { return await options.lock.withLock(BRAIN_LOCK_KEY, () => options.lock.withLock(GIT_LOCK_KEY, apply, { signal }), { signal }); }
    finally { hold.release(); }
  }
  function pathsFor(paths: string[]): string[] {
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > STORAGE_REMOVAL_LIMITS.items || paths.some(path => typeof path !== "string" || Buffer.byteLength(path) > 4096 || /[\\\u0000-\u001f\u007f]/u.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) || new Set(paths).size !== paths.length) throw new StorageUnavailable(400, "Select one bounded exact set of attachment paths.");
    return [...paths].sort();
  }
  async function prepareReview(principal: string, id: string, paths: string[], sourceId: string | null, persist: boolean): Promise<StorageRemovalReceipt> {
    authorize(principal); paths = pathsFor(paths);
    if (!validId(id) || sourceId !== null && !validId(sourceId)) throw new StorageUnavailable(400, "Invalid attachment operation identity.");
    const selection = JSON.stringify(paths), action = sourceId ? "undo" : "remove";
    const prior = select(id);
    if (prior) { if (prior.principal_id !== principal || prior.selection !== selection || prior.action !== action || prior.source_id !== sourceId) throw new StorageUnavailable(409, "Operation identity belongs to another selection."); return recover(prior); }
    if (!capability(principal).available) throw new StorageUnavailable(503, "This host cannot remove attachments yet.");
    if (reviews.size || active.size) throw new StorageUnavailable(409, "Another attachment review or operation is active.");
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), STORAGE_REMOVAL_LIMITS.reviewMilliseconds); reviews.add(controller);
    let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; }); pendingReviews.add(done);
    const check = () => { controller.signal.throwIfAborted(); authorize(principal); };
    try { return await exclusive(controller.signal, `storage-review:${id}`, async () => {
      check();
      const supported = paths.filter(storageAttachmentPath);
      const facts = supported.length ? await readRemovalFacts(options.boundary, brain, supported, controller.signal, check) : { fingerprint: "", complete: false, scannedFiles: 0, unchecked: ["unsupported selection"], files: [] };
      const covered = await journal.removalCoverage(paths, controller.signal, !!sourceId), source = sourceId ? select(sourceId) : null;
      if (sourceId && (!source || source.principal_id !== principal || source.action !== "remove")) throw new StorageUnavailable(404, "Original removal unavailable.");
      const sourceReceipt = source ? recover(source) : null, sourceVersions = source ? JSON.parse(source.private_versions) as PrivateFile[] : [];
      const files: StorageRemovalFile[] = [], versions: PrivateFile[] = []; let selectedFileBytes = 0;
      for (const [index, path] of paths.entries()) {
        check(); const fact = facts.files.find(value => value.path === path); let reason = protectedReason(path), version: StorageAttachmentVersion | null = null, retained: JournalVersion | null = null;
        try {
          if (source) {
            const original = sourceVersions.find(value => value.path === path), removed = sourceReceipt!.items.find(value => value.path === path);
            version = original?.version ?? null; retained = original?.retained ?? null;
            if (!version || !retained || removed?.state !== "removed" || !journal.hasRetainedVersion(source.journal_turn_id, retained)) reason ??= "retained_detail_expired_or_unavailable";
            else if (!storageAttachmentVacant(brain, path, version)) reason ??= "replacement_or_parent_changed";
          } else if (!reason) { version = await inspectStorageAttachment(brain, path, controller.signal); }
        } catch (error) { reason ??= error instanceof StorageAttachmentRefusal ? error.reason : "version_unavailable"; }
        // A missing undo target has no current file metadata; its ordinary ignore rules still apply at admission.
        if (!covered[index]) reason ??= "journal_coverage_unavailable";
        if (!facts.complete || !fact || fact.truncated || fact.git === "unknown") reason ??= "consequences_incomplete";
        if (fact?.git === "ignored") reason ??= "ignored_content_not_covered";
        if (!reason && version && selectedFileBytes + version.bytes > STORAGE_REMOVAL_LIMITS.totalBytes) reason = "batch_byte_bound";
        if (!reason && version) selectedFileBytes += version.bytes;
        files.push({ path, bytes: version?.bytes ?? null, hash: version?.hash ?? null, eligible: !reason && !!version, reason, git: fact?.git ?? "unknown", references: fact?.references.map(({ source, certainty }) => ({ source, certainty })) ?? [], recovery: reason ? "unavailable" : source ? "retained" : "requires-retention" });
        versions.push({ path, version, retained, consequences: factIdentity(facts, path) });
      }
      check(); const now = Date.now(), proposed = { id, action, sourceId, observedAt: now, expiresAt: now + REVIEW_TTL, files, complete: facts.complete, unchecked: facts.unchecked, selectedFileBytes } as Omit<StorageRemovalReview, "fingerprint">;
      const reviewed: StorageRemovalReview = { ...proposed, fingerprint: digest({ proposed, versions }) };
      const result: StorageRemovalReceipt = { review: reviewed, state: "review", requestedAt: now, startedAt: null, completedAt: null, reason: null,
        items: files.map(file => ({ path: file.path, state: file.eligible ? "not-started" : "protected", reason: file.reason, undoAvailable: false, undoReason: "no_confirmed_removal" })),
        before: null, after: null, index: "not-requested", commit: "not-requested", sync: "not-requested", retained: { journal: "subject-to-retention", git: "unchanged-by-operation", backups: "not-measured" } };
      if (persist) journal.writeOperation(() => {
        if ((db.query("SELECT count(*) AS total FROM turn_journal_storage_operations WHERE brain=?").get(brain) as {total: number}).total >= STORAGE_REMOVAL_LIMITS.receipts) throw new StorageUnavailable(503, "Attachment receipt capacity reached; existing receipts remain readable.");
        db.query("INSERT INTO turn_journal_storage_operations (id,brain,principal_id,action,source_id,selection,fingerprint,journal_turn_id,state,pid,pid_start,requested_at,receipt,private_versions) VALUES (?,?,?,?,?,?,?,?,'review',?,?,?,?,?)")
          .run(id, brain, principal, action, sourceId, selection, reviewed.fingerprint, `storage_${id}`, SELF.pid, SELF.start, now, encode(result), encode(versions));
      });
      return result;
    }); } finally { clearTimeout(timeout); reviews.delete(controller); pendingReviews.delete(done); finish(); }
  }
  async function execute(row: Row, controller: AbortController) {
    const result = JSON.parse(row.receipt) as StorageRemovalReceipt, versions = JSON.parse(row.private_versions) as PrivateFile[];
    const timeout = setTimeout(() => controller.abort(), STORAGE_REMOVAL_LIMITS.milliseconds);
    const check = () => { controller.signal.throwIfAborted(); authorize(row.principal_id); if ((db.query("SELECT cancel_requested FROM turn_journal_storage_operations WHERE id=?").get(row.id) as {cancel_requested: number}).cancel_requested) throw Error("cancelled"); };
    const revoked = setInterval(() => { try { check(); } catch { controller.abort(); } }, 100);
    let journalStarted = false, effects = false, unresolved = false;
    try {
      check(); result.before = storageObservation(await options.storage.measure(row.principal_id, controller.signal), ["content", "git", "journal", "database"]);
      await exclusive(controller.signal, `storage-remove:${row.id}`, async () => {
        check(); if (Date.now() >= result.review.expiresAt) throw Error("review_expired");
        const eligible = result.review.files.filter(file => file.eligible).map(file => file.path);
        const facts = await readRemovalFacts(options.boundary, brain, eligible, controller.signal, check);
        const covered = await journal.removalCoverage(eligible, controller.signal, row.action === "undo");
        check();
        await journal.begin(row.journal_turn_id, { sessionId: null, actor: "user", model: null, profile: "strict", policyHash: null }, () => controller.abort(), controller.signal); journalStarted = true;
        result.state = "running"; result.startedAt = Date.now(); save(row, result);
        for (const item of result.items) {
          if (item.state !== "not-started") continue;
          check(); const privateFile = versions.find(file => file.path === item.path)!;
          const reason = protectedReason(item.path);
          if (reason) { item.state = "protected"; item.reason = reason; save(row, result); continue; }
          if (privateFile.consequences !== factIdentity(facts, item.path)) { item.state = "changed"; item.reason = "consequences_changed"; save(row, result); continue; }
          try {
            if (!covered[eligible.indexOf(item.path)]) throw new StorageAttachmentRefusal("protected");
            if (row.action === "remove") {
              const current = await inspectStorageAttachment(brain, item.path, controller.signal);
              if (JSON.stringify(current) !== JSON.stringify(privateFile.version)) throw new StorageAttachmentRefusal("changed");
              try {
                privateFile.retained = await journal.retainBefore(row.journal_turn_id, item.path, controller.signal);
                if (privateFile.retained && options.retainedRoot) record(`store:${options.retainedRoot}`, "retained-attachment", "success");
              } catch (error) { if (options.retainedRoot) record(`store:${options.retainedRoot}`, "retained-attachment", "no-space", error); throw error; }
              if (!privateFile.retained || privateFile.retained.hash !== current.hash || privateFile.retained.bytes !== current.bytes || privateFile.retained.mode !== current.mode || !journal.hasRetainedVersion(row.journal_turn_id, privateFile.retained)) throw Error("retained_before_unavailable");
            } else {
              const source = select(row.source_id!);
              if (!source || !privateFile.retained || !journal.hasRetainedVersion(source.journal_turn_id, privateFile.retained)) throw Error("retained_detail_expired_or_unavailable");
              if (!storageAttachmentVacant(brain, item.path, privateFile.version!)) throw new StorageAttachmentRefusal("occupied");
            }
            check(); if (protectedReason(item.path)) throw new StorageAttachmentRefusal("protected");
            item.state = "applying"; save(row, result, versions); // Durable retained identity and item intent precede the first file effect.
            if (row.action === "remove") await removeStorageAttachment(brain, item.path, privateFile.version!, controller.signal, check);
            else {
              try { journal.withRetainedRemoval(select(row.source_id!)!.journal_turn_id, privateFile.retained!, copy => restoreStorageAttachment(brain, item.path, privateFile.version!, copy, check)); record("brain", item.path, "success"); }
              catch (error) { record("brain", item.path, "no-space", error); throw error; }
            }
            effects = true; item.state = row.action === "remove" ? "removed" : "restored"; item.reason = null;
            save(row, result, versions); // An acknowledgement failure cannot authorize another file.
            await journal.observe();
          } catch (error) {
            if (item.state === "applying" || item.state === "removed" || item.state === "restored") { unresolved = true; throw error; }
            item.state = error instanceof StorageAttachmentRefusal && ["changed", "occupied"].includes(error.reason) ? "changed" : error instanceof StorageAttachmentRefusal && error.reason === "protected" ? "protected" : "failed";
            item.reason = error instanceof StorageAttachmentRefusal ? error.reason : (error as {reason?: string}).reason === "journal_capacity" ? "journal_capacity" : ["ENOSPC", "EDQUOT"].includes((error as {code?: string}).code ?? "") ? "recovery_no_space" : "recovery_or_file_unavailable";
            save(row, result, versions);
          }
        }
        await journal.finish(row.journal_turn_id); journalStarted = false;
        if (journal.summary(row.journal_turn_id).state !== "complete") unresolved = true;
      });
      result.state = unresolved ? "unknown" : result.items.every(item => ["removed", "restored"].includes(item.state)) ? "complete" : "partial";
    } catch {
      result.state = unresolved || result.items.some(item => item.state === "applying") ? "unknown" : effects ? "partial" : controller.signal.aborted ? "cancelled" : "refused";
      result.reason = result.state === "unknown" ? "outcome_requires_reconciliation" : controller.signal.aborted ? "cancelled_or_revoked" : "operation_unavailable";
    } finally {
      clearTimeout(timeout); clearInterval(revoked);
      if (journalStarted) { try { await journal.finish(row.journal_turn_id); } catch { result.state = "unknown"; result.reason = "journal_reconciliation_unavailable"; } }
      if (effects && !closed && options.authorized(row.principal_id)) {
        const after = new AbortController(), deadline = setTimeout(() => after.abort(), 36_000);
        try {
          const refreshed = await options.boundary.run({ argv: [process.execPath, "--config=/dev/null", "--no-env-file", MAINTENANCE_ENTRY], env: subprocessEnv("brainCli", { NO_COLOR: "1" }), credentials: false, gate: "shared", purpose: "storage-index-refresh", outputAreas: ["brain.db", "brain.db-wal", "brain.db-shm", "brain.db-journal"], stdin: JSON.stringify({ op: "index", root: brain }), timeoutMs: 30_000, outputBytes: 262144, signal: after.signal, assertAuthorized: () => authorize(row.principal_id) });
          result.index = refreshed.exitCode === 0 && !refreshed.timedOut && JSON.parse(refreshed.stdout).ok === true ? "complete" : "unavailable";
        } catch { result.index = "unavailable"; } finally { clearTimeout(deadline); }
      }
      if (result.startedAt && !closed && options.authorized(row.principal_id)) {
        const after = new AbortController(), deadline = setTimeout(() => after.abort(), 36_000);
        try { result.after = storageObservation(await options.storage.measure(row.principal_id, after.signal), ["content", "git", "journal", "database"]); } catch { result.after = null; } finally { clearTimeout(deadline); }
      }
      for (const item of result.items) if (item.state === "applying") { item.state = "unknown"; item.reason = "outcome_requires_reconciliation"; }
      result.completedAt = Date.now();
      try { save(row, result, versions); } catch { /* Original per-item intent survives; a later read returns unknown without replay. */ }
    }
  }
  return {
    capability, receipt,
    review: (principal: string, id: string, paths: string[], sourceId: string | null = null) => prepareReview(principal, id, paths, sourceId, true),
    async inspect(principal: string, paths: string[]): Promise<StorageRemovalInspection> {
      const { review } = await prepareReview(principal, crypto.randomUUID(), paths, null, false);
      const { observedAt, files, complete, unchecked, selectedFileBytes } = review;
      const result = { observedAt, files, complete, unchecked, selectedFileBytes };
      encode(result); // Same response ceiling; never persist or expose a confirmable identity.
      return result;
    },
    start(principal: string, id: string, fingerprint: string) {
      authorize(principal); const row = select(id);
      if (!row || row.principal_id !== principal) throw new StorageUnavailable(404, "Attachment review unavailable.");
      if (fingerprint !== row.fingerprint) throw new StorageUnavailable(409, "Review identity changed.");
      const result = recover(row);
      if (row.state !== "review") return result;
      if (!capability(principal).available || Date.now() >= result.review.expiresAt || !result.review.files.some(file => file.eligible)) throw new StorageUnavailable(409, "Refresh the attachment review before removal.");
      journal.writeOperation(() => {
        if (db.query("SELECT 1 FROM turn_journal_storage_operations WHERE brain=? AND state IN ('waiting','running')").get(brain)) throw new StorageUnavailable(409, "Another attachment operation is active.");
        result.state = "waiting";
        const changed = db.query("UPDATE turn_journal_storage_operations SET state='waiting',pid=?,pid_start=?,receipt=? WHERE id=? AND state='review'").run(SELF.pid, SELF.start, encode(result), id);
        if (changed.changes !== 1) throw new StorageUnavailable(409, "Attachment operation already admitted.");
      });
      const controller = new AbortController(); runningHere.add(key(id));
      const pending = Promise.resolve().then(() => execute(select(id)!, controller)).finally(() => { active.delete(id); runningHere.delete(key(id)); });
      active.set(id, { controller, promise: pending });
      return result;
    },
    cancel(principal: string, id: string) { const result = receipt(principal, id); if (["waiting", "running"].includes(result.state)) journal.writeOperation(() => db.query("UPDATE turn_journal_storage_operations SET cancel_requested=1 WHERE id=?").run(id)); active.get(id)?.controller.abort(); return result; },
    async idle() { await Promise.allSettled([...active.values()].map(value => value.promise)); },
    async close() { closed = true; for (const controller of reviews) controller.abort(); for (const value of active.values()) value.controller.abort(); await Promise.allSettled([...pendingReviews, ...[...active.values()].map(value => value.promise)]); },
  };
}
export type StorageRemoval = ReturnType<typeof createStorageRemoval>;
