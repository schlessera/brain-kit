/** Schedule ledger steps; SQL stays ordered around the app's file/Git work (#3003). */
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { isUsablePrincipal, resolvePrincipal, type Principal } from "../db/principals.js";
import { procedureCaller, type SqliteWriter, type WireError, type WriteProcedures } from "../db/write-worker.js";
import { canonicalJson, scheduleFingerprint, sha256Hex } from "./canonical.js";
import type { StoredDefinition } from "./definition.js";
import { ScheduleError, type ScheduleErrorCode } from "./errors.js";
import { dropUnstartedItems } from "./queue-items.js";
import { parseInstant, SCHEDULE_FRESHNESS_MS } from "./time.js";
import type { ApprovalRow, ExecutionPolicy, ProposalRow, TaskRow } from "./service.js";

export const url = import.meta.url;
interface Root { path: string; identity: string }

function revive(error: WireError): Error | undefined {
  if (error.name === "ScheduleError")
    return new ScheduleError(error.fields.code as ScheduleErrorCode, error.message, error.fields.status as number);
  return undefined;
}

export function setup(db: Database, root: Root): WriteProcedures {
  // Production reads its clock inside the worker's transaction. Tests can
  // supply the service's injected clock without sending a closure to a worker.
  let suppliedNow: number | undefined;
  const now = () => suppliedNow ?? Date.now();
  const rootInfo = () => root;
  const newId = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
  const isOperator = (principal: Principal) => principal.kind === "owner" || principal.kind === "ambient";
  function usable(id: string): Principal | null {
    const current = resolvePrincipal(db, id);
    return current && isUsablePrincipal(current, now()) ? current : null;
  }
  function caller(principal: Principal): Principal {
    const current = usable(principal.id);
    if (!current) throw new ScheduleError("unauthorized", "This credential is no longer usable.", 401);
    return current;
  }
  function restorePending(): boolean {
    const bound = db.query("SELECT root_path FROM schedule_root WHERE id = 1").get() as { root_path: string } | null;
    return bound?.root_path !== root.path || Boolean(db.query("SELECT 1 FROM inbox_recovery_state WHERE status = 'pending'").get());
  }
  function assertWritable(): void {
    if (restorePending()) throw new ScheduleError("unsupported_capability", "Schedule storage awaits restore reconciliation.");
  }
  const taskRow = (id: string) => db.query("SELECT * FROM schedule_tasks WHERE id = ?").get(id) as TaskRow | null;
  function authorized(row: TaskRow): boolean {
    if (!usable(row.creator_principal_id)) return false;
    const approval = db.query("SELECT approver_principal_id, approver_kind FROM schedule_approvals WHERE id = ?")
      .get(row.approval_id) as { approver_principal_id: string; approver_kind: string } | null;
    const approver = approval ? usable(approval.approver_principal_id) : null;
    return Boolean(approver && isOperator(approver) && approver.kind === approval!.approver_kind);
  }
  function finished(row: TaskRow, at: number): boolean {
    const { when } = JSON.parse(row.definition_json) as StoredDefinition;
    if (when.kind === "at") return parseInstant(when.at)! + SCHEDULE_FRESHNESS_MS <= at ||
      Boolean(db.query("SELECT 1 FROM schedule_occurrences WHERE task_id = ? LIMIT 1").get(row.id));
    return when.endAt !== null && parseInstant(when.endAt)! <= at;
  }
  const procedures = {
    propose(actor: Principal, row: ProposalRow) {
      const key = row.request_key;
      return db.transaction(() => {
        caller(actor);
        const raced = db.query("SELECT * FROM schedule_proposals WHERE principal_id = ? AND request_key = ?").get(actor.id, key) as ProposalRow | null;
        if (raced) return raced;
        db.query(`INSERT INTO schedule_proposals (id, task_id, principal_id, request_key, input_hash, definition_json,
          zone_source, execution_policy_json, root_identity, fingerprint, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.task_id, actor.id, key, row.input_hash,
          row.definition_json, row.zone_source, row.execution_policy_json, row.root_identity, row.fingerprint, row.created_at, row.expires_at);
        return null;
      }).immediate();
    },
    approve(actor: Principal, proposal: ProposalRow, fingerprint: string, policy: ExecutionPolicy) {
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
    },
    publish(actor: Principal, proposal: ProposalRow, approval: ApprovalRow, policy: ExecutionPolicy, definition: StoredDefinition, text: string) {
      return db.transaction(() => {
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
    },
    quarantine(id: string) {
      return db.transaction(() => {
          db.query(`UPDATE schedule_tasks SET publication = 'quarantined', updated_at = ?,
            state = CASE WHEN state = 'publishing' THEN 'paused' ELSE state END,
            blocked_reason = CASE WHEN state = 'publishing' THEN 'definition_drift' ELSE blocked_reason END
            WHERE id = ? AND publication = 'pending'`).run(now(), id);
        }).immediate();
      },
      activate(id: string) {
      return db.transaction(() => {
          const result = db.query(`UPDATE schedule_tasks SET publication = 'published', updated_at = ?,
            state = CASE WHEN state = 'publishing' THEN 'active' ELSE state END
            WHERE id = ? AND publication = 'pending'`).run(now(), id);
          return result.changes > 0 && taskRow(id)!.state === "active";
        }).immediate();
      },
      retireAgain(id: string) {
        db.query("UPDATE schedule_tasks SET retirement = 'pending', updated_at = ? WHERE id = ? AND state = 'cancelled'").run(now(), id);
      },
      retired(id: string) {
        db.query("UPDATE schedule_tasks SET retirement = 'retired', updated_at = ? WHERE id = ? AND retirement = 'pending'").run(now(), id);
      },
      pauseDrifted(id: string) {
        db.query("UPDATE schedule_tasks SET state = 'paused', blocked_reason = 'definition_drift', updated_at = ? WHERE id = ? AND state = 'active'").run(now(), id);
      },
      cancel(actor: Principal, row: TaskRow, key: string) {
      return db.transaction(() => {
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
    },
    adoptRestoredRoot() {
      const info = rootInfo();
      return db.transaction(() => {
        const bound = db.query("SELECT root_path FROM schedule_root WHERE id = 1").get() as { root_path: string } | null;
        if (bound?.root_path === info.path) return;
        const restored = db.query("SELECT status, brain_root FROM inbox_recovery_state WHERE id = 1").get() as
          { status: string; brain_root: string } | null;
        if (restored?.status !== "ready" || restored.brain_root !== info.path)
          throw new ScheduleError("unsupported_capability", "Schedule storage belongs to another brain root; no restore named this one.");
        db.query("UPDATE schedule_root SET root_path = ? WHERE id = 1").run(info.path);
      }).immediate();
    },
    reopen(actor: Principal, row: TaskRow, key: string, before: TaskRow, drifted: boolean,
      policyResult: { value: ExecutionPolicy } | { error: WireError }) {
      const policy = "error" in policyResult ? revive(policyResult.error) ?? new Error(policyResult.error.message) : policyResult.value;
      const replay = () => {
        const receipt = db.query("SELECT task_id FROM schedule_reconciliations WHERE principal_id = ? AND request_key = ?")
          .get(actor.id, key) as { task_id: string } | null;
        if (receipt && receipt.task_id !== row.id) throw new ScheduleError("key_conflict", "This key was already used to reconcile a different task.");
        return receipt !== null;
      };
      return db.transaction(() => {
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
          if (!authorized(current)) throw new ScheduleError("unauthorized", "The schedule's creator or approving operator is no longer usable.");
          if (policy instanceof Error) throw policy;
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
    },
  };
  return Object.fromEntries(Object.entries(procedures).map(([name, procedure]) => [name,
    (clock: number | undefined, ...args: unknown[]) => {
      suppliedNow = clock;
      return Reflect.apply(procedure, procedures, args);
    }]));
}

/** Each call posts at once and settles only after this ledger step commits. */
export function scheduleWrites(db: Database, root: Root, writer?: SqliteWriter) {
  return procedureCaller(db, { url, setup }, root, writer, revive);
}
