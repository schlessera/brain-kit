/**
 * The one host service behind every schedule consumer (Store B).
 *
 * Proposal, verified operator approval and publication are separate stages.
 * The ledger owns the approved immutable snapshot, receipts and control state;
 * the Markdown file under context/scheduled-tasks/ is published only after the
 * ledger journals it, and is checked against the approved bytes on every read.
 * Nothing here dispatches work: `due` is a read-only computation, and
 * execution stays with the Queue runtime (#915), gated by #689.
 */
import type { Database } from "bun:sqlite";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";

import { isUsablePrincipal, resolvePrincipal, type Principal } from "../db/principals.js";
import { dropUnstartedItems } from "./queue-items.js";
import { canonicalJson, scheduleFingerprint, sha256Hex } from "./canonical.js";
import {
  DEFINITIONS_DIR,
  RETIRED_DIR,
  materializeDefinition,
  normalizeDefinitionInput,
  parseDefinitionFile,
  publicDefinition,
  SCHEDULE_ID,
  ScheduleValidationError,
  serializeDefinition,
  type ScheduleDefinition,
  type StoredDefinition,
  type ZoneSource,
} from "./definition.js";
import { assertTargetContained, createScheduleFiles, ScheduleContainmentError, TEMPORARY_REAP_AGE_MS, ScheduleFileConflictError, type ScheduleFiles } from "./files.js";
import { isoInstant, latestCronInstant, nextCronInstant, parseCron, parseInstant, SCHEDULE_FRESHNESS_MS } from "./time.js";

export const PROPOSAL_TTL_MS = 15 * 60_000;
export const CURSOR_TTL_MS = 15 * 60_000;
export const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CURSOR_BYTES = 1024;
/** Envelope fields plus the largest signed cursor, budgeted before any row. */
const ENVELOPE_RESERVE = 256 + MAX_CURSOR_BYTES;
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;

export type ScheduleErrorCode =
  | "invalid_request" | "invalid_cursor" | "unauthorized" | "not_found" | "key_conflict"
  | "approval_required" | "approval_expired" | "definition_conflict" | "server_unavailable"
  | "unsupported_capability";
const STATUS: Record<ScheduleErrorCode, number> = {
  invalid_request: 400, invalid_cursor: 400, unauthorized: 403, not_found: 404, key_conflict: 409,
  approval_required: 409, approval_expired: 409, definition_conflict: 409, server_unavailable: 503,
  unsupported_capability: 503,
};

export class ScheduleError extends Error {
  readonly status: number;
  constructor(readonly code: ScheduleErrorCode, message: string, status?: number) {
    super(message);
    this.status = status ?? STATUS[code];
  }
}

export interface ExecutionPolicy {
  backendId: string;
  profileId: string | null;
  inferenceOrigins: string[];
}
export type TaskState = "publishing" | "active" | "paused" | "cancelled" | "completed" | "failed" | "expired";
export type OccurrenceState = "queued" | "running" | "unwinding" | "waiting_for_action" | "retrying"
  | "completed" | "failed" | "cancelled" | "expired" | "unknown";
export type BlockedReason = "dispatch_disabled" | "budget_disabled" | "capacity" | "authority_unusable"
  | "definition_drift" | "backend_unavailable" | "unknown_effect" | "occurrence_limit" | "restore_pending";
export const TASK_STATES: readonly TaskState[] = ["publishing", "active", "paused", "cancelled", "completed", "failed", "expired"];
export const OUTSTANDING_STATES: readonly OccurrenceState[] = ["queued", "running", "unwinding", "waiting_for_action", "retrying"];

export interface ScheduleOccurrence {
  id: string; taskId: string; dueAt: string; expiresAt: string; state: OccurrenceState;
  operationsUsed: number; maxOperations: number; runIds: string[];
  result: { state: "available" | "pruned" | "unavailable"; text: string | null };
}
export interface ScheduleTask {
  id: string; definition: ScheduleDefinition; creatorPrincipalId: string; createdAt: string;
  zoneSource: ZoneSource; state: TaskState; executionAvailable: boolean; blockedReason: BlockedReason | null;
  nextDueAt: string | null; lastOccurrence: ScheduleOccurrence | null; compensationPending: boolean;
}
export interface ScheduleProposal {
  id: string; taskId: string; key: string; definition: ScheduleDefinition; zoneSource: ZoneSource;
  executionPolicy: ExecutionPolicy; fingerprint: string; expiresAt: string; approvalState: "pending" | "approved";
}
export interface DueCandidate {
  taskId: string; occurrenceId: string; dueAt: string; expiresAt: string;
  admittable: boolean; blockedReason: BlockedReason | null;
}

interface ProposalRow {
  id: string; task_id: string; principal_id: string; request_key: string; input_hash: string;
  definition_json: string; zone_source: ZoneSource; execution_policy_json: string; root_identity: string;
  fingerprint: string; created_at: number; expires_at: number;
}
interface ApprovalRow {
  id: string; proposal_id: string; approver_principal_id: string; approver_kind: string;
  fingerprint: string; approved_at: number; consumed_at: number | null;
}
export interface TaskRow {
  id: string; proposal_id: string; approval_id: string; creator_principal_id: string; root_identity: string;
  definition_json: string; execution_policy_json: string; fingerprint: string; file_sha256: string;
  zone_source: ZoneSource; created_at: number; state: TaskState; blocked_reason: BlockedReason | null;
  publication: "pending" | "published" | "quarantined"; retirement: "none" | "pending" | "retired";
  cancelled_at: number | null; evaluated_through: number; updated_at: number;
}
export interface OccurrenceRow {
  id: string; task_id: string; due_at: number; expires_at: number; state: OccurrenceState;
  operations_used: number; max_operations: number; run_ids_json: string; attempt_deadline_at: number | null;
  result_state: "available" | "pruned" | "unavailable"; result_text: string | null;
}

export interface ScheduleServiceOptions {
  brainRoot: string;
  now?: () => number;
  /** Host-selected backend/profile/inference audience; null refuses proposals honestly. */
  executionPolicy: () => ExecutionPolicy | null | Promise<ExecutionPolicy | null>;
  /** True only when a Queue dispatcher is wired (#915) and enabled (#689). */
  dispatchAvailable?: () => boolean;
  /** Whether Git would ignore a brain-relative path (an ignored definition would miss the content backup). */
  gitIgnored?: (relativePath: string) => boolean;
}

export function occurrenceId(taskId: string, dueAt: number): string {
  return `occ_${sha256Hex(`${taskId}\n${dueAt}`).slice(0, 40)}`;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

function isOperator(principal: Principal): boolean {
  return principal.kind === "owner" || principal.kind === "ambient";
}

/** Git's own answer; outside a repository nothing is ignored. */
export function gitCheckIgnored(root: string): (relativePath: string) => boolean {
  return (relativePath) => {
    try {
      const result = Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", "--no-index", "--", relativePath],
        { stdout: "ignore", stderr: "ignore" });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  };
}

export function createScheduleService(db: Database, options: ScheduleServiceOptions) {
  const now = options.now ?? Date.now;
  const dispatchAvailable = options.dispatchAvailable ?? (() => false);
  let root: { path: string; identity: string; secret: Buffer; matches: boolean } | null = null;
  let files: ScheduleFiles | null = null;
  const gitIgnored = () => options.gitIgnored ?? gitCheckIgnored(rootInfo().path);

  function rootInfo() {
    if (root) return root;
    let path: string;
    try { path = realpathSync(options.brainRoot); }
    catch { throw new ScheduleError("server_unavailable", "Schedule storage is unavailable."); }
    const row = db.transaction(() => {
      const existing = db.query("SELECT * FROM schedule_root WHERE id = 1").get() as
        { root_identity: string; root_path: string; cursor_secret: string } | null;
      if (existing) return existing;
      const created = { root_identity: newId("root"), root_path: path, cursor_secret: randomBytes(32).toString("hex") };
      db.query("INSERT INTO schedule_root (id, root_identity, root_path, cursor_secret, created_at) VALUES (1, ?, ?, ?, ?)")
        .run(created.root_identity, created.root_path, created.cursor_secret, now());
      return created;
    }).immediate();
    root = { path, identity: row.root_identity, secret: Buffer.from(row.cursor_secret, "hex"), matches: row.root_path === path };
    files = createScheduleFiles(path);
    return root;
  }
  function fileStore(): ScheduleFiles {
    rootInfo();
    return files!;
  }

  /** An ignored definition would silently miss the content backup. */
  function ignored(taskId: string): boolean {
    return gitIgnored()(`${DEFINITIONS_DIR}/${taskId}.md`) || gitIgnored()(`${RETIRED_DIR}/${taskId}.md`);
  }
  /** Active and retired definitions must both stay in the content backup. */
  function assertNotIgnored(taskId: string): void {
    if (ignored(taskId))
      throw new ScheduleError("unsupported_capability", "Git ignores a schedule definition directory, so content backup would omit it.");
  }

  function restorePending(): boolean {
    const info = rootInfo();
    if (!info.matches) {
      // Another process's reconciliation may have bound the ledger to this root.
      const bound = db.query("SELECT root_path FROM schedule_root WHERE id = 1").get() as { root_path: string } | null;
      if (bound?.root_path !== info.path) return true;
      info.matches = true;
    }
    return Boolean(db.query("SELECT 1 FROM inbox_recovery_state WHERE status = 'pending'").get());
  }
  function assertWritable(): void {
    if (restorePending()) throw new ScheduleError("unsupported_capability", "Schedule storage awaits restore reconciliation.");
  }

  function usable(principalId: string): Principal | null {
    const current = resolvePrincipal(db, principalId);
    return current && isUsablePrincipal(current, now()) ? current : null;
  }
  /** Revalidate the request principal against current state; revocation may race a request. */
  function caller(principal: Principal): Principal {
    const current = usable(principal.id);
    if (!current) throw new ScheduleError("unauthorized", "This credential is no longer usable.", 401);
    return current;
  }
  function canSee(principal: Principal, creatorId: string): boolean {
    return isOperator(principal) || principal.id === creatorId;
  }

  async function currentPolicy(): Promise<ExecutionPolicy> {
    let policy: ExecutionPolicy | null;
    try { policy = await options.executionPolicy(); }
    catch { throw new ScheduleError("server_unavailable", "The host execution policy is unavailable."); }
    if (!policy) throw new ScheduleError("unsupported_capability", "This host has no approved schedule execution policy.");
    const id = (value: unknown) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 128;
    if (!id(policy.backendId) || (policy.profileId !== null && !id(policy.profileId)) ||
        !Array.isArray(policy.inferenceOrigins) || policy.inferenceOrigins.length > 16)
      throw new ScheduleError("unsupported_capability", "The host execution policy is not reviewable.");
    return { backendId: policy.backendId, profileId: policy.profileId, inferenceOrigins: [...policy.inferenceOrigins] };
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  function proposalView(row: ProposalRow): ScheduleProposal {
    const approved = db.query("SELECT 1 FROM schedule_approvals WHERE proposal_id = ?").get(row.id);
    return {
      id: row.id, taskId: row.task_id, key: row.request_key,
      definition: publicDefinition(JSON.parse(row.definition_json) as StoredDefinition),
      zoneSource: row.zone_source, executionPolicy: JSON.parse(row.execution_policy_json) as ExecutionPolicy,
      fingerprint: row.fingerprint, expiresAt: isoInstant(row.expires_at), approvalState: approved ? "approved" : "pending",
    };
  }

  function occurrenceView(row: OccurrenceRow): ScheduleOccurrence {
    return {
      id: row.id, taskId: row.task_id, dueAt: isoInstant(row.due_at), expiresAt: isoInstant(row.expires_at),
      state: row.state, operationsUsed: row.operations_used, maxOperations: row.max_operations,
      runIds: JSON.parse(row.run_ids_json) as string[],
      result: { state: row.result_state, text: row.result_state === "available" ? row.result_text : null },
    };
  }

  function definitionOf(row: TaskRow): StoredDefinition {
    return JSON.parse(row.definition_json) as StoredDefinition;
  }

  /** Compare the active file with the approved bytes. Never repairs anything. */
  async function fileDrifted(row: TaskRow): Promise<boolean> {
    if (row.state !== "active" && row.state !== "paused") return false;
    if (row.publication !== "published") return row.publication === "quarantined";
    try {
      const bytes = await fileStore().readActive(row.id);
      if (!bytes || sha256Hex(bytes) !== row.file_sha256) return true;
      const parsed = parseDefinitionFile(bytes.toString("utf8"));
      return canonicalJson(parsed) !== canonicalJson(definitionOf(row));
    } catch {
      return true;
    }
  }

  /** The earliest unconsumed due instant this task could still produce. */
  function consumedThrough(row: TaskRow): number {
    const last = db.query("SELECT MAX(due_at) AS due FROM schedule_occurrences WHERE task_id = ?").get(row.id) as { due: number | null };
    return Math.max(row.evaluated_through, last.due ?? Number.NEGATIVE_INFINITY);
  }

  function nextDue(row: TaskRow, at: number): number | null {
    if (row.state !== "active" && row.state !== "paused") return null;
    const { when } = definitionOf(row);
    if (when.kind === "at") {
      const due = parseInstant(when.at)!;
      return due > at && due > consumedThrough(row) ? due : null;
    }
    const after = Math.max(at, consumedThrough(row));
    const next = nextCronInstant(parseCron(when.cron), when.timeZone, after);
    const end = when.endAt === null ? null : parseInstant(when.endAt)!;
    return next !== null && (end === null || next < end) ? next : null;
  }

  function latestDue(row: TaskRow, at: number): number | null {
    const { when } = definitionOf(row);
    const lower = Math.max(at - SCHEDULE_FRESHNESS_MS + 1, row.created_at, consumedThrough(row) + 1);
    if (when.kind === "at") {
      const due = parseInstant(when.at)!;
      return due >= lower && due <= at ? due : null;
    }
    if (when.endAt !== null && at >= parseInstant(when.endAt)!) return null;
    return latestCronInstant(parseCron(when.cron), when.timeZone, lower, at);
  }

  function blockedReason(row: TaskRow, drifted: boolean): BlockedReason | null {
    if (!["active", "paused"].includes(row.state)) return null;
    if (drifted) return "definition_drift";
    if (row.blocked_reason) return row.blocked_reason;
    if (restorePending()) return "restore_pending";
    if (!usable(row.creator_principal_id)) return "authority_unusable";
    if (!dispatchAvailable()) return "dispatch_disabled";
    return null;
  }

  async function taskView(row: TaskRow): Promise<ScheduleTask> {
    const at = now();
    const drifted = await fileDrifted(row);
    const reason = blockedReason(row, drifted);
    const last = db.query("SELECT * FROM schedule_occurrences WHERE task_id = ? ORDER BY due_at DESC LIMIT 1").get(row.id) as OccurrenceRow | null;
    const next = nextDue(row, at);
    return {
      id: row.id, definition: publicDefinition(definitionOf(row)), creatorPrincipalId: row.creator_principal_id,
      createdAt: isoInstant(row.created_at), zoneSource: row.zone_source, state: row.state,
      executionAvailable: row.state === "active" && reason === null,
      blockedReason: reason, nextDueAt: next === null ? null : isoInstant(next),
      lastOccurrence: last ? occurrenceView(last) : null,
      compensationPending: row.retirement === "pending" || (row.state === "publishing" && row.publication === "pending"),
    };
  }

  function taskRow(id: string): TaskRow | null {
    return db.query("SELECT * FROM schedule_tasks WHERE id = ?").get(id) as TaskRow | null;
  }

  // -------------------------------------------------------------------------
  // Signed cursors
  // -------------------------------------------------------------------------

  function signCursor(payload: Record<string, unknown>): string {
    const body = Buffer.from(canonicalJson(payload)).toString("base64url");
    const mac = createHmac("sha256", rootInfo().secret).update(body).digest("base64url");
    return `${body}.${mac}`;
  }
  function readCursor(cursor: string, expected: Record<string, unknown>): Record<string, unknown> {
    const invalid = () => new ScheduleError("invalid_cursor", "The cursor is invalid, expired or belongs to another query.");
    if (cursor.length === 0 || Buffer.byteLength(cursor) > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
    const [body, mac] = cursor.split(".") as [string, string];
    const wanted = createHmac("sha256", rootInfo().secret).update(body).digest();
    const given = Buffer.from(mac, "base64url");
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) throw invalid();
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>; }
    catch { throw invalid(); }
    for (const [key, value] of Object.entries(expected)) if (canonicalJson(payload[key] ?? null) !== canonicalJson(value)) throw invalid();
    if (typeof payload.exp !== "number" || payload.exp <= now()) throw invalid();
    return payload;
  }

  function pageLimit(value: unknown): number {
    if (value === undefined) return DEFAULT_PAGE;
    if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > MAX_PAGE)
      throw new ScheduleError("invalid_request", `limit must be an integer from 1 to ${MAX_PAGE}.`);
    return Number(value);
  }

  /** Fill a page up to the limit and the response byte budget; one entry always fits. */
  function page<T>(rows: T[], limit: number, envelopeBytes: number): { items: T[]; more: boolean } {
    const items: T[] = [];
    let size = envelopeBytes;
    for (const row of rows) {
      if (items.length === limit) return { items, more: true };
      const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (items.length > 0 && size + bytes > MAX_RESPONSE_BYTES) return { items, more: true };
      items.push(row);
      size += bytes;
    }
    return { items, more: false };
  }

  // -------------------------------------------------------------------------
  // Publication and retirement journals
  // -------------------------------------------------------------------------

  /** Finish a journaled publication. Returns true when this call activated the task. */
  async function completePublication(id: string): Promise<boolean> {
    const row = taskRow(id);
    if (!row || row.publication !== "pending") return false;
    // A restored or moved root never receives files from an old journal.
    if (restorePending()) return false;
    const definition = definitionOf(row);
    const text = serializeDefinition(definition);
    if (sha256Hex(text) !== row.file_sha256) throw new ScheduleError("server_unavailable", "Schedule snapshot is inconsistent.");
    assertNotIgnored(id);
    try {
      await fileStore().publish(id, text);
    } catch (error) {
      if (error instanceof ScheduleFileConflictError || error instanceof ScheduleContainmentError) {
        // Never overwrite: quarantine the task and expose the drift.
        db.transaction(() => {
          db.query(`UPDATE schedule_tasks SET publication = 'quarantined', updated_at = ?,
            state = CASE WHEN state = 'publishing' THEN 'paused' ELSE state END,
            blocked_reason = CASE WHEN state = 'publishing' THEN 'definition_drift' ELSE blocked_reason END
            WHERE id = ? AND publication = 'pending'`).run(now(), id);
        }).immediate();
        throw new ScheduleError("definition_conflict", "A different definition file occupies this schedule's path.");
      }
      throw new ScheduleError("server_unavailable", "Schedule storage is unavailable; retry with the same key.");
    }
    const activated = db.transaction(() => {
      const result = db.query(`UPDATE schedule_tasks SET publication = 'published', updated_at = ?,
        state = CASE WHEN state = 'publishing' THEN 'active' ELSE state END
        WHERE id = ? AND publication = 'pending'`).run(now(), id);
      return result.changes > 0 && taskRow(id)!.state === "active";
    }).immediate();
    // A cancellation that won the race retires the file this call just wrote,
    // even when another publisher's retirement already completed before it.
    if (taskRow(id)?.state === "cancelled") {
      db.query("UPDATE schedule_tasks SET retirement = 'pending', updated_at = ? WHERE id = ? AND state = 'cancelled'").run(now(), id);
      await completeRetirement(id);
    }
    return activated;
  }

  async function completeRetirement(id: string): Promise<void> {
    const row = taskRow(id);
    if (!row || row.retirement !== "pending" || row.publication === "pending" || restorePending()) return;
    // Never move a retained definition somewhere the content backup omits.
    if (ignored(id)) return;
    let done = false;
    try { done = await fileStore().retire(id, serializeDefinition(definitionOf(row))); }
    catch { return; } // The journal stays pending; status reports compensationPending.
    if (done) db.query("UPDATE schedule_tasks SET retirement = 'retired', updated_at = ? WHERE id = ? AND retirement = 'pending'").run(now(), id);
  }

  /** Boot/retry reconciliation of every journal. Never dispatches work. */
  async function reconcile(): Promise<void> {
    if (restorePending()) return;
    const publishing = db.query("SELECT id FROM schedule_tasks WHERE publication = 'pending' ORDER BY created_at").all() as { id: string }[];
    for (const { id } of publishing) {
      await fileStore().reapTemporaries(id, now() - TEMPORARY_REAP_AGE_MS).catch(() => {});
      await completePublication(id).catch(() => {});
    }
    const retiring = db.query("SELECT id FROM schedule_tasks WHERE retirement = 'pending' ORDER BY created_at").all() as { id: string }[];
    for (const { id } of retiring) await completeRetirement(id);
    const active = db.query("SELECT * FROM schedule_tasks WHERE state = 'active' ORDER BY created_at").all() as TaskRow[];
    for (const row of active) {
      if (await fileDrifted(row)) {
        db.query("UPDATE schedule_tasks SET state = 'paused', blocked_reason = 'definition_drift', updated_at = ? WHERE id = ? AND state = 'active'")
          .run(now(), row.id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  async function propose(principal: Principal, body: unknown): Promise<{ status: 200 | 201; proposal: ScheduleProposal }> {
    const actor = caller(principal);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScheduleError("invalid_request", "Expected a JSON object.");
    const { key, definition: rawDefinition, clientTimeZone, ...extra } = body as Record<string, unknown>;
    if (Object.keys(extra).length > 0) throw new ScheduleError("invalid_request", "Unknown proposal field.");
    if (typeof key !== "string" || !SCHEDULE_ID.test(key)) throw new ScheduleError("invalid_request", "key must be a 1–128 character key.");
    if (clientTimeZone !== undefined && typeof clientTimeZone !== "string") throw new ScheduleError("invalid_request", "clientTimeZone must be a string.");
    let input;
    try { input = normalizeDefinitionInput(rawDefinition); }
    catch (error) {
      if (error instanceof ScheduleValidationError) throw new ScheduleError("invalid_request", error.message);
      throw error;
    }
    const inputHash = sha256Hex(canonicalJson({ definition: input, clientTimeZone: clientTimeZone ?? null }));
    // A matched receipt answers before any clock-dependent validation.
    const replay = db.query("SELECT * FROM schedule_proposals WHERE principal_id = ? AND request_key = ?").get(actor.id, key) as ProposalRow | null;
    if (replay) {
      if (replay.input_hash !== inputHash) throw new ScheduleError("key_conflict", "This key was already used for a different schedule.");
      const view = proposalView(replay);
      if (view.approvalState === "pending" && replay.expires_at <= now())
        throw new ScheduleError("approval_expired", "This proposal expired before approval; propose again with a new key.");
      return { status: 200, proposal: view };
    }
    assertWritable();
    const policy = await currentPolicy();
    const taskId = newId("task");
    let materialized;
    try { materialized = materializeDefinition(input, { id: taskId, now: now(), clientTimeZone }); }
    catch (error) {
      if (error instanceof ScheduleValidationError) throw new ScheduleError("invalid_request", error.message);
      throw error;
    }
    for (const target of materialized.definition.scope.targets) {
      try { await assertTargetContained(rootInfo().path, target); }
      catch (error) {
        if (error instanceof ScheduleContainmentError) throw new ScheduleError("invalid_request", "A target path passes through a symlink.");
        throw new ScheduleError("server_unavailable", "Schedule storage is unavailable.");
      }
    }
    assertNotIgnored(taskId);
    const { identity } = rootInfo();
    const fingerprint = scheduleFingerprint({ definition: materialized.definition, rootIdentity: identity,
      creatorPrincipalId: actor.id, executionPolicy: policy });
    const id = newId("proposal"), at = now();
    const created = db.transaction(() => {
      caller(actor);
      const raced = db.query("SELECT * FROM schedule_proposals WHERE principal_id = ? AND request_key = ?").get(actor.id, key) as ProposalRow | null;
      if (raced) return raced;
      db.query(`INSERT INTO schedule_proposals (id, task_id, principal_id, request_key, input_hash, definition_json,
        zone_source, execution_policy_json, root_identity, fingerprint, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, taskId, actor.id, key, inputHash,
        canonicalJson(materialized.definition), materialized.zoneSource, canonicalJson(policy), identity, fingerprint, at, at + PROPOSAL_TTL_MS);
      return null;
    }).immediate();
    if (created) {
      if (created.input_hash !== inputHash) throw new ScheduleError("key_conflict", "This key was already used for a different schedule.");
      return { status: 200, proposal: proposalView(created) };
    }
    return { status: 201, proposal: proposalView(db.query("SELECT * FROM schedule_proposals WHERE id = ?").get(id) as ProposalRow) };
  }

  async function approve(principal: Principal, proposalId: string, body: unknown): Promise<{ approvalId: string }> {
    const actor = caller(principal);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScheduleError("invalid_request", "Expected a JSON object.");
    const { fingerprint, decision, ...extra } = body as Record<string, unknown>;
    if (Object.keys(extra).length > 0 || decision !== "approve" || typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint))
      throw new ScheduleError("invalid_request", "Approval needs {fingerprint, decision: \"approve\"}.");
    const proposal = SCHEDULE_ID.test(proposalId)
      ? db.query("SELECT * FROM schedule_proposals WHERE id = ?").get(proposalId) as ProposalRow | null : null;
    if (!proposal || !canSee(actor, proposal.principal_id)) throw new ScheduleError("not_found", "No such schedule proposal.");
    // Normal authentication is not operator approval: delegated agent
    // credentials can propose and query, never approve.
    if (!isOperator(actor)) throw new ScheduleError("unauthorized", "Only the operator can approve a schedule.");
    if (proposal.fingerprint !== fingerprint) throw new ScheduleError("definition_conflict", "The fingerprint does not match this proposal.");
    const policy = await currentPolicy();
    return db.transaction(() => {
      caller(actor);
      const existing = db.query("SELECT * FROM schedule_approvals WHERE proposal_id = ?").get(proposal.id) as ApprovalRow | null;
      if (existing) return { approvalId: existing.id };
      if (proposal.expires_at <= now()) throw new ScheduleError("approval_expired", "This proposal expired; propose again with a new key.");
      assertWritable();
      if (proposal.root_identity !== rootInfo().identity) throw new ScheduleError("definition_conflict", "The proposal belongs to another brain root.");
      if (!usable(proposal.principal_id)) throw new ScheduleError("unauthorized", "The schedule's creator is no longer usable.");
      if (canonicalJson(policy) !== proposal.execution_policy_json)
        throw new ScheduleError("definition_conflict", "The host execution policy changed since this proposal.");
      const id = newId("approval");
      db.query(`INSERT INTO schedule_approvals (id, proposal_id, approver_principal_id, approver_kind, channel,
        fingerprint, nonce, approved_at) VALUES (?, ?, ?, ?, 'http', ?, ?, ?)`)
        .run(id, proposal.id, actor.id, actor.kind, fingerprint, randomBytes(16).toString("hex"), now());
      return { approvalId: id };
    }).immediate();
  }

  async function publish(principal: Principal, body: unknown): Promise<{ status: 200 | 201; created: boolean; task: ScheduleTask }> {
    const actor = caller(principal);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScheduleError("invalid_request", "Expected a JSON object.");
    const { proposalId, approvalId, ...extra } = body as Record<string, unknown>;
    if (Object.keys(extra).length > 0 || typeof proposalId !== "string" || !SCHEDULE_ID.test(proposalId) ||
        (approvalId !== undefined && (typeof approvalId !== "string" || !SCHEDULE_ID.test(approvalId))))
      throw new ScheduleError("invalid_request", "Publication needs {proposalId, approvalId?}.");
    const proposal = db.query("SELECT * FROM schedule_proposals WHERE id = ?").get(proposalId) as ProposalRow | null;
    if (!proposal || proposal.principal_id !== actor.id) throw new ScheduleError("not_found", "No such schedule proposal.");
    // The creation receipt is read before consumed-token or past-date checks.
    const existing = db.query("SELECT * FROM schedule_tasks WHERE proposal_id = ?").get(proposal.id) as TaskRow | null;
    if (existing) {
      if (approvalId !== undefined && existing.approval_id !== approvalId) throw new ScheduleError("definition_conflict", "This proposal was published with a different approval.");
      // Finish an interrupted journal; the receipt itself was created earlier.
      if (existing.publication === "pending") await completePublication(existing.id);
      if (existing.retirement === "pending") await completeRetirement(existing.id);
      // Success only once the ledger and the file agree.
      const current = taskRow(existing.id)!;
      if (current.publication === "quarantined")
        throw new ScheduleError("definition_conflict", "A different definition file occupies this schedule's path.");
      if (current.publication === "pending") {
        if (restorePending()) throw new ScheduleError("unsupported_capability", "Schedule storage awaits restore reconciliation.");
        throw new ScheduleError("server_unavailable", "Schedule storage is unavailable; retry with the same key.");
      }
      return { status: 200, created: false, task: await taskView(current) };
    }
    const approval = db.query("SELECT * FROM schedule_approvals WHERE proposal_id = ?").get(proposal.id) as ApprovalRow | null;
    if (!approval) throw new ScheduleError("approval_required", `Review the stored schedule proposal ${proposal.id} before creation.`);
    if (approvalId !== undefined && approval.id !== approvalId) throw new ScheduleError("definition_conflict", "The approval does not belong to this proposal.");
    const definition = JSON.parse(proposal.definition_json) as StoredDefinition;
    const text = serializeDefinition(definition);
    const policy = await currentPolicy();
    assertWritable();
    assertNotIgnored(proposal.task_id);
    const taskId = db.transaction(() => {
      const at = now();
      caller(actor);
      const raced = db.query("SELECT id FROM schedule_tasks WHERE proposal_id = ?").get(proposal.id) as { id: string } | null;
      if (raced) return null;
      if (proposal.expires_at <= at) throw new ScheduleError("approval_expired", "This approval expired before publication; propose again with a new key.");
      assertWritable();
      const approver = usable(approval.approver_principal_id);
      if (!approver || !isOperator(approver) || approver.kind !== approval.approver_kind)
        throw new ScheduleError("unauthorized", "The approving operator is no longer usable.");
      if (approval.fingerprint !== proposal.fingerprint || proposal.root_identity !== rootInfo().identity)
        throw new ScheduleError("definition_conflict", "The approval no longer matches this proposal.");
      if (canonicalJson(policy) !== proposal.execution_policy_json)
        throw new ScheduleError("definition_conflict", "The host execution policy changed since approval.");
      const recomputed = scheduleFingerprint({ definition, rootIdentity: proposal.root_identity,
        creatorPrincipalId: proposal.principal_id, executionPolicy: JSON.parse(proposal.execution_policy_json) });
      if (recomputed !== proposal.fingerprint) throw new ScheduleError("definition_conflict", "The stored proposal does not match its fingerprint.");
      // First-publication timing is rechecked; replay above never reaches here.
      if (definition.when.kind === "at" && parseInstant(definition.when.at)! <= at)
        throw new ScheduleError("invalid_request", "The one-off time has passed; propose a new future time.");
      if (definition.when.kind === "cron" && definition.when.endAt !== null && parseInstant(definition.when.endAt)! <= at)
        throw new ScheduleError("invalid_request", "The recurrence end has passed; propose a new schedule.");
      db.query("UPDATE schedule_approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(at, approval.id);
      db.query(`INSERT INTO schedule_tasks (id, proposal_id, approval_id, creator_principal_id, root_identity,
        definition_json, execution_policy_json, fingerprint, file_sha256, zone_source, created_at, state,
        blocked_reason, publication, retirement, cancelled_at, evaluated_through, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'publishing', NULL, 'pending', 'none', NULL, ?, ?)`)
        .run(proposal.task_id, proposal.id, approval.id, proposal.principal_id, proposal.root_identity,
          proposal.definition_json, proposal.execution_policy_json, proposal.fingerprint, sha256Hex(text),
          proposal.zone_source, at, at, at);
      return proposal.task_id;
    }).immediate();
    if (taskId === null) return publish(principal, body);
    await completePublication(taskId);
    return { status: 201, created: true, task: await taskView(taskRow(taskId)!) };
  }

  async function list(principal: Principal, query: Record<string, string | undefined>) {
    const actor = caller(principal);
    const { limit: rawLimit, cursor, state, id, ...extra } = query;
    if (Object.keys(extra).length > 0) throw new ScheduleError("invalid_request", "Unknown list query parameter.");
    const limit = pageLimit(rawLimit);
    if (state !== undefined && !TASK_STATES.includes(state as TaskState)) throw new ScheduleError("invalid_request", "Unknown task state.");
    if (id !== undefined && !SCHEDULE_ID.test(id)) throw new ScheduleError("invalid_request", "Invalid task id.");
    const filters = { state: state ?? null, id: id ?? null };
    const scope = { op: "list", root: rootInfo().identity, actor: actor.id, filters };
    let cutoff = now(), after: [number, string] | null = null;
    if (cursor !== undefined) {
      const payload = readCursor(cursor, scope);
      cutoff = payload.cutoff as number;
      after = payload.after as [number, string];
    }
    const rows = db.query(`SELECT * FROM schedule_tasks WHERE created_at <= ?
      AND (? IS NULL OR state = ?) AND (? IS NULL OR id = ?)
      AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at, id`).all(cutoff, filters.state, filters.state, filters.id, filters.id,
        after?.[0] ?? null, after?.[0] ?? null, after?.[0] ?? null, after?.[1] ?? null) as TaskRow[];
    const visible = rows.filter((row) => canSee(actor, row.creator_principal_id));
    const views: ScheduleTask[] = [];
    for (const row of visible.slice(0, limit + 1)) views.push(await taskView(row));
    const { items, more } = page(views, limit, ENVELOPE_RESERVE);
    const last = items.at(-1);
    const lastRow = last ? visible.find((row) => row.id === last.id)! : null;
    const nextCursor = more && lastRow
      ? signCursor({ ...scope, cutoff, after: [lastRow.created_at, lastRow.id], exp: now() + CURSOR_TTL_MS })
      : null;
    return { ok: true as const, tasks: items, nextCursor };
  }

  async function due(principal: Principal, query: Record<string, string | undefined>) {
    const actor = caller(principal);
    const { limit: rawLimit, cursor, ...extra } = query;
    if (Object.keys(extra).length > 0) throw new ScheduleError("invalid_request", "Unknown due query parameter.");
    const limit = pageLimit(rawLimit);
    const scope = { op: "due", root: rootInfo().identity, actor: actor.id };
    let evaluatedAt = now(), after: [number, string] | null = null;
    if (cursor !== undefined) {
      const payload = readCursor(cursor, scope);
      evaluatedAt = payload.evaluatedAt as number;
      after = payload.after as [number, string];
    }
    // Read-only: no claim, cursor advance, counter change or model work.
    const rows = (db.query("SELECT * FROM schedule_tasks WHERE state IN ('active', 'paused') ORDER BY created_at, id").all() as TaskRow[])
      .filter((row) => canSee(actor, row.creator_principal_id));
    const candidates: { dueAt: number; row: TaskRow }[] = [];
    for (const row of rows) {
      const outstanding = db.query(`SELECT 1 FROM schedule_occurrences WHERE task_id = ? AND state IN
        ('queued', 'running', 'unwinding', 'waiting_for_action', 'retrying')`).get(row.id);
      if (outstanding) continue;
      const dueAt = latestDue(row, evaluatedAt);
      if (dueAt !== null) candidates.push({ dueAt, row });
    }
    candidates.sort((a, b) => a.dueAt - b.dueAt || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
    const remaining = after ? candidates.filter((c) => c.dueAt > after![0] || (c.dueAt === after![0] && c.row.id > after![1])) : candidates;
    const views: (DueCandidate & { _row: TaskRow })[] = [];
    for (const { dueAt, row } of remaining.slice(0, limit + 1)) {
      const reason = blockedReason(row, await fileDrifted(row));
      views.push({ taskId: row.id, occurrenceId: occurrenceId(row.id, dueAt), dueAt: isoInstant(dueAt),
        expiresAt: isoInstant(dueAt + SCHEDULE_FRESHNESS_MS), admittable: row.state === "active" && reason === null,
        blockedReason: reason, _row: row });
    }
    const { items, more } = page(views.map(({ _row: _ignored, ...view }) => view), limit, ENVELOPE_RESERVE);
    const last = items.at(-1);
    const nextCursor = more && last
      ? signCursor({ ...scope, evaluatedAt, after: [Date.parse(last.dueAt), last.taskId], exp: now() + CURSOR_TTL_MS })
      : null;
    return { ok: true as const, due: items, evaluatedAt: isoInstant(evaluatedAt), nextCursor };
  }

  async function cancel(principal: Principal, taskId: string, body: unknown) {
    const actor = caller(principal);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScheduleError("invalid_request", "Expected a JSON object.");
    const { key, ...extra } = body as Record<string, unknown>;
    if (Object.keys(extra).length > 0 || typeof key !== "string" || !SCHEDULE_ID.test(key))
      throw new ScheduleError("invalid_request", "Cancellation needs {key}.");
    const row = SCHEDULE_ID.test(taskId) ? taskRow(taskId) : null;
    if (!row || !canSee(actor, row.creator_principal_id)) throw new ScheduleError("not_found", "No such scheduled task.");
    const changed = db.transaction(() => {
      caller(actor);
      const receipt = db.query("SELECT task_id FROM schedule_cancel_receipts WHERE principal_id = ? AND request_key = ?")
        .get(actor.id, key) as { task_id: string } | null;
      if (receipt) {
        if (receipt.task_id !== row.id) throw new ScheduleError("key_conflict", "This key was already used to cancel a different task.");
        return false;
      }
      const current = taskRow(row.id)!;
      const at = now();
      // Future/unstarted only: terminal one-offs and earlier cancellations stay as they are.
      const cancellable = ["publishing", "active", "paused"].includes(current.state);
      if (cancellable) {
        db.query(`UPDATE schedule_tasks SET state = 'cancelled', blocked_reason = NULL, cancelled_at = ?,
          retirement = 'pending', updated_at = ? WHERE id = ?`).run(at, at, row.id);
        // Unstarted and stale-Action work is invalidated in the same transaction.
        // A started attempt keeps its bounded snapshot; this is not a live stop.
        db.query(`UPDATE schedule_occurrences SET state = 'cancelled', updated_at = ?
          WHERE task_id = ? AND state IN ('queued', 'retrying', 'waiting_for_action')`).run(at, row.id);
        // Their unclaimed Queue items go with them. A claim that has not
        // started yet is refused by admission's start check instead.
        dropUnstartedItems(db, row.id, at);
      }
      db.query("INSERT INTO schedule_cancel_receipts (principal_id, request_key, task_id, changed, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(actor.id, key, row.id, cancellable ? 1 : 0, at);
      return cancellable;
    }).immediate();
    await completeRetirement(row.id);
    const running = (db.query(`SELECT * FROM schedule_occurrences WHERE task_id = ? AND state IN ('running', 'unwinding')
      ORDER BY due_at`).all(row.id) as OccurrenceRow[]).map(occurrenceView);
    return { ok: true as const, changed, task: await taskView(taskRow(row.id)!), runningOccurrences: running };
  }

  /**
   * Bind the ledger to the brain root a completed restore named. The restore
   * command recorded that canonical directory itself, so this is the
   * operator's own statement rather than a claimed matching fingerprint. The
   * root identity, and with it every approval fingerprint, is unchanged.
   */
  function adoptRestoredRoot(): void {
    const info = rootInfo();
    if (info.matches) return;
    db.transaction(() => {
      const restored = db.query("SELECT status, brain_root FROM inbox_recovery_state WHERE id = 1").get() as
        { status: string; brain_root: string } | null;
      if (restored?.status !== "ready" || restored.brain_root !== info.path)
        throw new ScheduleError("unsupported_capability", "Schedule storage belongs to another brain root; no restore named this one.");
      db.query("UPDATE schedule_root SET root_path = ? WHERE id = 1").run(info.path);
    }).immediate();
    info.matches = true;
  }

  /** The one-off or ended recurrence has nothing left to run. */
  function finished(row: TaskRow, at: number): boolean {
    const { when } = definitionOf(row);
    if (when.kind === "at") {
      const due = parseInstant(when.at)!;
      return due + SCHEDULE_FRESHNESS_MS <= at ||
        Boolean(db.query("SELECT 1 FROM schedule_occurrences WHERE task_id = ? LIMIT 1").get(row.id));
    }
    return when.endAt !== null && parseInstant(when.endAt)! <= at;
  }

  /**
   * Verified operator reconciliation of a task paused by a restore or by an
   * unknown effect. The operator states that the uncertainty was investigated;
   * the host still requires the approved file bytes, a usable creator and the
   * approved execution policy. Unknown occurrences keep their outcome and are
   * never replayed: their due instants stay consumed.
   */
  async function reopen(principal: Principal, taskId: string, body: unknown) {
    const actor = caller(principal);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ScheduleError("invalid_request", "Expected a JSON object.");
    const { key, decision, ...extra } = body as Record<string, unknown>;
    if (Object.keys(extra).length > 0 || decision !== "reopen" || typeof key !== "string" || !SCHEDULE_ID.test(key))
      throw new ScheduleError("invalid_request", "Reconciliation needs {key, decision: \"reopen\"}.");
    const row = SCHEDULE_ID.test(taskId) ? taskRow(taskId) : null;
    if (!row || !canSee(actor, row.creator_principal_id)) throw new ScheduleError("not_found", "No such scheduled task.");
    if (!isOperator(actor)) throw new ScheduleError("unauthorized", "Only the operator can reconcile a schedule.");
    const replay = () => {
      const receipt = db.query("SELECT task_id FROM schedule_reconciliations WHERE principal_id = ? AND request_key = ?")
        .get(actor.id, key) as { task_id: string } | null;
      if (receipt && receipt.task_id !== row.id) throw new ScheduleError("key_conflict", "This key was already used to reconcile a different task.");
      return receipt !== null;
    };
    // A matched receipt answers first, like every other schedule receipt.
    if (replay()) return { ok: true as const, changed: false, task: await taskView(taskRow(row.id)!) };
    if (db.query("SELECT 1 FROM inbox_recovery_state WHERE status = 'pending'").get())
      throw new ScheduleError("unsupported_capability", "The operational restore has not finished.");
    adoptRestoredRoot();
    // Journals frozen by the restore can finish now; this never dispatches.
    await reconcile();
    const policy = await currentPolicy();
    const before = taskRow(row.id)!;
    const drifted = await fileDrifted(before);
    const changed = db.transaction(() => {
      const at = now();
      caller(actor);
      if (replay()) return false;
      const current = taskRow(row.id)!;
      const reason = current.state === "paused" ? current.blocked_reason : null;
      const resolvable = reason === "restore_pending" || reason === "unknown_effect";
      if (resolvable) {
        if (drifted || current.updated_at !== before.updated_at || current.publication !== "published")
          throw new ScheduleError("definition_conflict", "The definition file does not match the approved snapshot; cancel and create a new schedule.");
        if (current.root_identity !== rootInfo().identity)
          throw new ScheduleError("definition_conflict", "The task belongs to another brain root.");
        if (!usable(current.creator_principal_id)) throw new ScheduleError("unauthorized", "The schedule's creator is no longer usable.");
        if (canonicalJson(policy) !== current.execution_policy_json)
          throw new ScheduleError("definition_conflict", "The host execution policy changed since approval; cancel and create a new schedule.");
        if (db.query(`SELECT 1 FROM schedule_occurrences WHERE task_id = ? AND state IN
          ('queued', 'running', 'unwinding', 'waiting_for_action', 'retrying')`).get(current.id))
          throw new ScheduleError("definition_conflict", "The task still has outstanding work.");
        db.query("UPDATE schedule_tasks SET state = ?, blocked_reason = NULL, updated_at = ? WHERE id = ?")
          .run(finished(current, at) ? "expired" : "active", at, current.id);
      }
      db.query(`INSERT INTO schedule_reconciliations (principal_id, request_key, task_id, approver_kind, resolved_reason, changed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(actor.id, key, row.id, actor.kind, resolvable ? reason : null, resolvable ? 1 : 0, at);
      return resolvable;
    }).immediate();
    return { ok: true as const, changed, task: await taskView(taskRow(row.id)!) };
  }

  /** Admission internals (admission.ts). No route reaches these. */
  const internal = {
    taskRow,
    definitionOf,
    restorePending,
    usable: (principalId: string) => usable(principalId) !== null,
    latestDue,
    finished,
    occurrenceView,
    /** Why work cannot start on this task now, checking its file first. */
    async refusal(row: TaskRow): Promise<BlockedReason | null> {
      if (row.state !== "active" || row.publication !== "published") return row.blocked_reason ?? "dispatch_disabled";
      return blockedReason(row, await fileDrifted(row));
    },
  };

  const ready = Promise.resolve().then(() => { rootInfo(); return reconcile(); });
  // Operations wait for boot reconciliation, so one instance never races its
  // own journal recovery. Other processes may still race; journals tolerate it.
  const gated = <A extends unknown[], R>(operation: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => { await ready.catch(() => {}); return operation(...args); };

  return {
    ready,
    propose: gated(propose), approve: gated(approve), publish: gated(publish),
    list: gated(list), due: gated(due), cancel: gated(cancel), reopen: gated(reopen), reconcile, internal,
  };
}

export type ScheduleService = ReturnType<typeof createScheduleService>;
