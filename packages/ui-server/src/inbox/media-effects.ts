/**
 * The host side of the four media review effects (#2781, epic #1777, rev 4
 * §5-§6, ruling Rollback A): capture before mutation in the bounded change
 * journal, per-file compensation, Undo and restart recovery. The CLI plans
 * and writes (`brain hygiene media`); this module owns everything that needs
 * the journal.
 *
 * - **Capture first.** Under the exclusive writer gate, a journal turn
 *   covers every file the plan lists, and each existing pre-image is retained
 *   and verified against the plan's SHA-256 *before* the CLI writes. A
 *   capture that cannot fit the journal's shared cap (or its per-file copy
 *   bound) refuses as `capture-capacity`, with nothing written.
 * - **Per-file compensation.** Each file is put back only while it still
 *   holds exactly what this effect wrote; anything else is a `conflict`, left
 *   as it is, and the outcome is `partial`. No all-file atomicity is claimed.
 * - **Undo** is the same per-file rule, after a preflight that every
 *   retained pre-image still exists and every file still holds its
 *   post-image. Rollback data the journal evicted disables Undo honestly.
 * - **Recovery** after a restart compensates an interrupted apply or
 *   finishes an interrupted Undo from the durable operation row. It never
 *   re-applies an effect.
 */
import type { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, rmdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { JournalVersion, HygieneMediaPlan, HygieneMediaReceipt, HygieneMediaFileState } from "@schlessera/brain-ui-sdk/protocol";
import { hygieneMediaPlanSchema } from "@schlessera/brain-ui-sdk/schemas";
import { BRAIN_LOCK_KEY, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { GIT_LOCK_KEY } from "@schlessera/brain-ui-sdk/internal";
import { z } from "zod";
import type { TurnJournal } from "../brain/turn-journal.js";
import { journalCheck, journalStatement, JournalStatementRefused } from "../brain/journal-store.js";
import { processAlive, SELF, type WriterGate } from "../brain/writer-gate.js";
import { restoreJournalPath } from "../brain/revert-files.js";

type PlanFile = HygieneMediaPlan["files"][number];
type Row = { id: string; principal_id: string; finding_id: string; fingerprint: string; action: string; source_id: string | null; journal_turn_id: string;
  state: string; pid: number; pid_start: string; requested_at: number; plan: string; versions: string; receipt: string };
const ACTIVE = ["capturing", "applying", "undoing"];
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;

const applyResultSchema = z.looseObject({
  status: z.enum(["applied", "stale", "refused", "interrupted"]), reason: z.string().nullable().optional(),
  refusals: z.array(z.looseObject({ code: z.string() })).optional(), copySha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
const keptSchema = z.looseObject({ status: z.string(), reason: z.string().nullable().optional() });

class MediaEffectUnavailable extends Error {}

/** The current version of a brain file as the journal records one, read without following links; null when absent. */
function currentVersion(brain: string, path: string): JournalVersion | null | "other" {
  const parts = path.split("/"), name = parts.pop()!;
  let dir = openSync(brain, DIRECTORY);
  try {
    for (const part of parts) {
      let next: number;
      try { next = openSync(at(dir, part), DIRECTORY); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; return "other"; }
      closeSync(dir); dir = next;
    }
    const info = lstatSync(at(dir, name), { throwIfNoEntry: false });
    if (!info) return null;
    if (info.isDirectory()) return { kind: "other", mode: info.mode & 0o7777, bytes: 0, ignored: false };
    if (!info.isFile() || info.nlink !== 1) return "other";
    const fd = openSync(at(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let read: number, bytes = 0;
      while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, read)); bytes += read; }
      return { kind: "file", mode: fstatSync(fd).mode & 0o7777, bytes, hash: hash.digest("hex"), ignored: false };
    } finally { closeSync(fd); }
  } finally { closeSync(dir); }
}

const shaOf = (v: JournalVersion | null | "other") => v === null ? null : v === "other" ? "other" : v.kind === "other" ? "directory" : v.hash ?? "other";

export function createMediaEffects(db: Database, options: {
  brainPath: string; journal: TurnJournal; gate: WriterGate; lock: KeyedLock;
  /** The hygiene CLI (`brain hygiene --json …`). */
  cli(args: string[]): Promise<unknown>;
  authorized(principalId: string): boolean;
  now?: () => number;
}) {
  const { brainPath: brain, journal } = options;
  const now = options.now ?? Date.now;
  const runningHere = new Set<string>();
  // Reads use the UI connection the journal file is attached to; every write is an accounted journal write.
  const rowOf = (id: string) => db.query("SELECT * FROM turn_journal_media_operations WHERE id=?").get(id) as Row | null;
  const save = async (row: Row, state: string, receipt: HygieneMediaReceipt, versions?: Record<string, JournalVersion>) => {
    const v = versions ? JSON.stringify(versions) : row.versions;
    await journal.writeOperation([journalStatement("UPDATE turn_journal_media_operations SET state=?,receipt=?,versions=? WHERE id=?", state, JSON.stringify(receipt), v, row.id)]);
    row.state = state; row.receipt = JSON.stringify(receipt); row.versions = v;
  };
  async function exclusive<T>(purpose: string, apply: () => Promise<T>): Promise<T> {
    const hold = await options.gate.acquire("exclusive", purpose, { queueTurns: true });
    try { return await options.lock.withLock(BRAIN_LOCK_KEY, () => options.lock.withLock(GIT_LOCK_KEY, apply)); }
    finally { await hold.release(); }
  }

  /**
   * Put each file back to its pre-image, in reverse plan order, only where it
   * still holds the post-image this effect wrote. A file already at its
   * pre-image needs nothing; anything else is a conflict and is left alone.
   */
  async function restore(files: PlanFile[], versions: Record<string, JournalVersion>, sourceTurnId: string): Promise<HygieneMediaReceipt["files"]> {
    const out: HygieneMediaReceipt["files"] = [];
    for (const f of [...files].reverse()) {
      let state: HygieneMediaFileState;
      try {
        if (f.role === "directory") {
          try { rmdirSync(posix.join(brain, f.path)); state = "restored"; }
          catch (e) { state = (e as NodeJS.ErrnoException).code === "ENOENT" ? "restored" : "left-changed"; }
        } else {
          const current = currentVersion(brain, f.path), sha = shaOf(current);
          if (sha === f.before) state = "unchanged";
          else if (sha !== f.after || current === "other") state = "conflict";
          else {
            const desired = f.before === null ? null : versions[f.path] ?? null;
            if (f.before !== null && (!desired || !journal.hasRetainedVersion(sourceTurnId, desired))) state = "conflict";
            else state = await journal.withRetainedVersion(desired, copy => restoreJournalPath(brain, f.path, current as JournalVersion | null, desired, copy));
          }
        }
      } catch { state = "conflict"; }
      out.unshift({ path: f.path, state });
    }
    return out;
  }

  function undoAvailability(row: Row): HygieneMediaReceipt["undo"] {
    const receipt = JSON.parse(row.receipt) as HygieneMediaReceipt;
    if (row.source_id !== null || !["applied", "kept"].includes(receipt.outcome)) return { available: false, reason: "no-confirmed-effect" };
    if (row.state === "undone" || row.state === "undo-partial") return { available: false, reason: "already-undone" };
    const plan = hygieneMediaPlanSchema.parse(JSON.parse(row.plan)), versions = JSON.parse(row.versions) as Record<string, JournalVersion>;
    for (const f of plan.files) {
      if (f.role === "directory" || f.before === null) continue;
      const v = versions[f.path];
      if (!v || !journal.hasRetainedVersion(row.journal_turn_id, v)) return { available: false, reason: "rollback-evicted" };
    }
    for (const f of plan.files) {
      if (f.role === "directory") continue;
      if (shaOf(currentVersion(brain, f.path)) !== f.after) return { available: false, reason: "changed-since", path: f.path };
    }
    return { available: true };
  }

  function receiptOf(row: Row): HygieneMediaReceipt {
    const receipt = JSON.parse(row.receipt) as HygieneMediaReceipt;
    return { ...receipt, undo: undoAvailability(row) };
  }

  async function admit(id: string, principalId: string, findingId: string, fingerprint: string, action: string, sourceId: string | null, plan: HygieneMediaPlan): Promise<Row> {
    if (!/^[A-Za-z0-9._-]{16,96}$/.test(id)) throw new MediaEffectUnavailable("Invalid media operation identity.");
    const turnId = `media_${id}`;
    const receipt: HygieneMediaReceipt = { journalId: id, action: plan.action, outcome: "pending", files: [], undo: { available: false, reason: "no-confirmed-effect" } };
    await journal.writeOperation([
      journalCheck(`SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM turn_journal_media_operations WHERE state IN (${ACTIVE.map(s => `'${s}'`).join(",")}))`, "Another media effect is in progress."),
      journalStatement("INSERT INTO turn_journal_media_operations (id,principal_id,finding_id,fingerprint,action,source_id,journal_turn_id,state,pid,pid_start,requested_at,plan,versions,receipt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, principalId, findingId, fingerprint, action, sourceId, sourceId ? `media_undo_${id}` : turnId, sourceId ? "undoing" : "capturing", SELF.pid, SELF.start, now(), JSON.stringify(plan), "{}", JSON.stringify(receipt)),
    ]).catch(error => { throw error instanceof JournalStatementRefused ? new MediaEffectUnavailable(error.message) : error; });
    return rowOf(id)!;
  }

  /** Begin a user journal turn covering the plan's files; a refused admission is a capture refusal. */
  async function begin(turnId: string, files: PlanFile[]) {
    let failure: Error | undefined;
    await journal.begin(turnId, { sessionId: null, actor: "user", model: null, profile: "strict", policyHash: null, coveredPaths: files.filter(f => f.role !== "directory").map(f => f.path) }, error => { failure = error; });
    return () => failure;
  }

  /**
   * Undo of Keep a permanent copy also removes the kept entry step 6b wrote,
   * after the copy and config are restored (rev 5 §5.7, ruling 2026-11-03),
   * so the original is pending again rather than reopened as `copy-missing`.
   * An entry already gone (invalidated, hand-moved) needs nothing; any other
   * answer leaves the Undo `partial`.
   */
  async function releaseKept(source: Row): Promise<string | null> {
    let answer: z.infer<typeof keptSchema>;
    try { answer = keptSchema.parse(await options.cli(["unkeep", "--journal", source.id, "--", source.finding_id])); }
    catch { return "kept-entry-unknown"; }
    finally { await journal.observe(); }
    return answer.status === "unkept" || answer.reason === "not-kept" ? null : "kept-entry-unremoved";
  }

  async function compensate(row: Row, plan: HygieneMediaPlan, reason: string): Promise<HygieneMediaReceipt> {
    const versions = JSON.parse(row.versions) as Record<string, JournalVersion>;
    const files = await restore(plan.files, versions, row.journal_turn_id);
    const clean = files.every(f => ["restored", "unchanged"].includes(f.state));
    // A copy whose step 6b receipt was lost may have its entry: a copy never leaves a record behind.
    const kept = clean && plan.action === "keep-copy" ? await releaseKept(row) : null;
    return { journalId: row.id, action: plan.action, outcome: clean && !kept ? "compensated" : "partial", reason: kept ?? reason, files, undo: { available: false, reason: "no-confirmed-effect" } };
  }

  /**
   * Apply one previewed plan. Returns the receipt; nothing is retried, and a
   * refusal before capture or apply writes nothing.
   */
  async function apply(request: { id: string; principalId: string; findingId: string; fingerprint: string; plan: HygieneMediaPlan; destination?: string }): Promise<HygieneMediaReceipt> {
    if (!options.authorized(request.principalId)) throw new MediaEffectUnavailable("Human review authority is required.");
    const existing = rowOf(request.id);
    if (existing) {
      if (existing.principal_id !== request.principalId || existing.finding_id !== request.findingId || existing.plan !== JSON.stringify(request.plan)) throw new MediaEffectUnavailable("Operation identity belongs to another request.");
      return receiptOf(existing);
    }
    const plan = request.plan;
    const row = await admit(request.id, request.principalId, request.findingId, request.fingerprint, plan.action, null, plan);
    runningHere.add(row.id);
    let observed = false;
    const refused = (outcome: "refused" | "stale", reason: string, refusals?: HygieneMediaReceipt["refusals"]): HygieneMediaReceipt =>
      ({ journalId: row.id, action: plan.action, outcome, reason, ...(refusals ? { refusals } : {}), files: plan.files.map(f => ({ path: f.path, state: "unchanged" as const })), undo: { available: false, reason: "no-confirmed-effect" } });
    let receipt: HygieneMediaReceipt;
    try {
      receipt = await exclusive(`media:${row.id}`, async () => {
        if (!options.authorized(request.principalId)) return refused("refused", "authorization-changed");
        let failed: () => Error | undefined;
        try { failed = await begin(row.journal_turn_id, plan.files); observed = true; }
        catch (error) { return refused("refused", (error as { reason?: string }).reason === "journal_capacity" ? "capture-capacity" : "journal-unavailable"); }
        // Capture before mutation: every pre-image the plan names, verified by SHA-256.
        const versions: Record<string, JournalVersion> = {};
        for (const f of plan.files) {
          if (f.role === "directory" || f.before === null) continue;
          let retained: JournalVersion | null;
          try { retained = await journal.retainBefore(row.journal_turn_id, f.path); }
          catch (error) {
            const capacity = (error as { reason?: string }).reason === "journal_capacity" || /bounded recovery copy size/.test(String((error as Error).message));
            return refused("refused", capacity ? "capture-capacity" : "capture-unavailable", capacity ? [{ code: "capture-capacity", path: f.path }] : undefined);
          }
          if (!retained || retained.hash !== f.before || !journal.hasRetainedVersion(row.journal_turn_id, retained)) return refused("stale", "capture-premise-changed", [{ code: "stale", path: f.path }]);
          versions[f.path] = retained;
        }
        if (failed()) return refused("refused", "journal-unavailable");
        // Durable intent, with the retained versions, precedes the first write.
        await save(row, "applying", { ...refused("refused", "applying"), outcome: "pending" }, versions);
        let result: z.infer<typeof applyResultSchema>;
        try {
          result = applyResultSchema.parse(await options.cli(["media", plan.action, request.findingId, "--expect-fingerprint", request.fingerprint,
            ...(plan.destination ? ["--to", plan.destination] : []),
            // A broader change (#2781, rev 4 §7) is applied as it was planned and approved.
            ...(plan.scope === "pattern" && plan.pattern ? ["--pattern", plan.pattern] : []), ...(plan.ignoreAdjust ? ["--ignore-adjust", plan.ignoreAdjust] : []),
            "--expect-premise", plan.premiseDigest, "--journal", row.id, ...(plan.approvalDigest ? ["--expect-approval", plan.approvalDigest] : [])]));
        } catch { await journal.observe(); return compensate(row, plan, "apply-receipt-unknown"); }
        await journal.observe();
        if (result.status === "stale" || result.status === "refused") return refused(result.status, result.reason ?? result.status, result.refusals as HygieneMediaReceipt["refusals"]);
        if (result.status === "interrupted") return compensate(row, plan, result.reason ?? "interrupted");
        const written = plan.files.map(f => ({ path: f.path, state: (f.before === null ? "created" : f.after === null ? "removed" : "changed") as HygieneMediaFileState }));
        if (plan.action !== "keep-copy") return { journalId: row.id, action: plan.action, outcome: "applied", files: written, undo: { available: false } };
        // Step 6b (rev 5 §5.7): record the kept entry only after the copy verified; a refusal removes the copy.
        let kept: z.infer<typeof keptSchema>;
        try {
          kept = keptSchema.parse(await options.cli(["keep-copy", "--expect-fingerprint", request.fingerprint, "--copy", plan.destination!, "--copy-sha256", result.copySha256 ?? "", "--journal", row.id, "--", request.findingId]));
        } catch { kept = { status: "refused", reason: "keep-receipt-unknown" }; }
        if (kept.status !== "kept") { const compensated = await compensate(row, plan, kept.reason ?? "keep-refused"); await journal.observe(); return compensated; }
        return { journalId: row.id, action: plan.action, outcome: "kept", files: written, copySha256: result.copySha256, undo: { available: false } };
      });
    } catch (error) {
      receipt = { ...refused("refused", error instanceof MediaEffectUnavailable ? "authorization-changed" : "operation-unavailable") };
      if (row.state === "applying") receipt = await compensate(row, plan, "operation-unavailable").catch(() => ({ ...receipt, outcome: "partial" as const, reason: "compensation-unavailable" }));
    } finally {
      if (observed) { try { await journal.finish(row.journal_turn_id); } catch { /* the turn stays partial; Undo checks retained data itself */ } }
      runningHere.delete(row.id);
    }
    await save(row, receipt.outcome, receipt);
    return receiptOf(row);
  }

  /** Undo a confirmed effect: preflight every retained pre-image and post-image, then restore per file. */
  async function undo(request: { id: string; principalId: string; sourceId: string }): Promise<HygieneMediaReceipt> {
    if (!options.authorized(request.principalId)) throw new MediaEffectUnavailable("Human review authority is required.");
    const source = rowOf(request.sourceId);
    if (!source || source.principal_id !== request.principalId) throw new MediaEffectUnavailable("Media receipt unavailable.");
    const existing = rowOf(request.id);
    if (existing) {
      if (existing.source_id !== request.sourceId || existing.principal_id !== request.principalId) throw new MediaEffectUnavailable("Operation identity belongs to another request.");
      return receiptOf(existing);
    }
    const plan = hygieneMediaPlanSchema.parse(JSON.parse(source.plan));
    const preflight = undoAvailability(source);
    if (!preflight.available) {
      // Refused before any write: nothing is restored by halves.
      return { journalId: source.id, action: plan.action, outcome: "refused", reason: preflight.reason, files: [], undo: preflight };
    }
    const row = await admit(request.id, request.principalId, source.finding_id, source.fingerprint, `undo-${plan.action}`, source.id, plan);
    runningHere.add(row.id);
    let receipt: HygieneMediaReceipt;
    let observed = false;
    try {
      receipt = await exclusive(`media-undo:${row.id}`, async () => {
        const again = undoAvailability(source);
        if (!again.available || !options.authorized(request.principalId)) return { journalId: row.id, action: plan.action, outcome: "refused", reason: again.reason ?? "authorization-changed", files: [], undo: again };
        await begin(row.journal_turn_id, plan.files); observed = true;
        const files = await restore(plan.files, JSON.parse(source.versions), source.journal_turn_id);
        await journal.observe();
        const clean = files.every(f => ["restored", "unchanged"].includes(f.state));
        const kept = clean && plan.action === "keep-copy" ? await releaseKept(source) : null;
        return { journalId: row.id, action: plan.action, outcome: clean && !kept ? "undone" : "partial", ...(kept ? { reason: kept } : {}), files, undo: { available: false, reason: "already-undone" } };
      });
    } catch {
      receipt = { journalId: row.id, action: plan.action, outcome: "partial", reason: "operation-unavailable", files: [], undo: { available: false } };
    } finally {
      if (observed) { try { await journal.finish(row.journal_turn_id); } catch { /* partial turn */ } }
      runningHere.delete(row.id);
    }
    await save(row, receipt.outcome, receipt);
    if (["undone", "partial"].includes(receipt.outcome)) await save(source, receipt.outcome === "undone" ? "undone" : "undo-partial", JSON.parse(source.receipt));
    return receipt;
  }

  /**
   * After a restart: an interrupted capture wrote nothing and is refused; an
   * interrupted apply is compensated per file; an interrupted Undo finishes by
   * the same per-file rule. Each runs once, under the writer gate.
   */
  async function recover(): Promise<void> {
    const rows = db.query(`SELECT * FROM turn_journal_media_operations WHERE state IN (${ACTIVE.map(s => `'${s}'`).join(",")}) ORDER BY requested_at,rowid`).all() as Row[];
    for (const row of rows) {
      if (runningHere.has(row.id) || (processAlive(row.pid, row.pid_start) && !(row.pid === SELF.pid && row.pid_start === SELF.start))) continue;
      const plan = hygieneMediaPlanSchema.parse(JSON.parse(row.plan));
      let receipt: HygieneMediaReceipt;
      if (row.state === "capturing") {
        receipt = { journalId: row.id, action: plan.action, outcome: "refused", reason: "interrupted-before-effect", files: plan.files.map(f => ({ path: f.path, state: "unchanged" as const })), undo: { available: false, reason: "no-confirmed-effect" } };
      } else {
        const source = row.source_id ? rowOf(row.source_id) : null;
        receipt = await exclusive(`media-recover:${row.id}`, async () => {
          const files = await restore(plan.files, JSON.parse((source ?? row).versions), (source ?? row).journal_turn_id);
          const clean = files.every(f => ["restored", "unchanged"].includes(f.state));
          // A copy's kept entry goes with it, whether an Undo or an apply was interrupted.
          const kept = clean && plan.action === "keep-copy" ? await releaseKept(source ?? row) : null;
          return { journalId: row.id, action: plan.action, outcome: clean && !kept ? (row.source_id ? "undone" : "compensated") : "partial", reason: kept ?? "interrupted", files, undo: { available: false, reason: "no-confirmed-effect" } };
        });
        if (source && ["undone", "partial"].includes(receipt.outcome)) await save(source, receipt.outcome === "undone" ? "undone" : "undo-partial", JSON.parse(source.receipt));
      }
      await save(row, receipt.outcome, receipt);
    }
  }
  return {
    apply, undo, recover,
    receipt(id: string, principalId: string): HygieneMediaReceipt | null {
      const row = rowOf(id);
      return row && row.principal_id === principalId ? receiptOf(row) : null;
    },
  };
}
export type MediaEffects = ReturnType<typeof createMediaEffects>;
