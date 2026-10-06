import type { Database } from "bun:sqlite";

import { scheduleFingerprint, sha256Hex } from "./canonical.js";
import { serializeDefinition, type StoredDefinition } from "./definition.js";
import { dropUnstartedItems } from "./queue-items.js";

/**
 * Relationship checks the operational backup runs before export and restore.
 * The image already carries every schedule row; this proves the approved
 * snapshot, approval and receipt links still agree.
 */
export function validateScheduleRelations(db: Database): void {
  const tasks = db.query(`SELECT t.*, p.definition_json AS p_definition, p.fingerprint AS p_fingerprint,
      p.principal_id AS p_principal, p.root_identity AS p_root, p.execution_policy_json AS p_policy,
      p.task_id AS p_task, a.proposal_id AS a_proposal, a.fingerprint AS a_fingerprint, a.consumed_at AS a_consumed
    FROM schedule_tasks t
    LEFT JOIN schedule_proposals p ON p.id = t.proposal_id
    LEFT JOIN schedule_approvals a ON a.id = t.approval_id`).all() as Record<string, unknown>[];
  for (const row of tasks) {
    const definition = JSON.parse(row.definition_json as string) as StoredDefinition;
    if (row.p_task !== row.id || row.a_proposal !== row.proposal_id || row.a_consumed === null ||
        row.p_definition !== row.definition_json || row.p_fingerprint !== row.fingerprint ||
        row.a_fingerprint !== row.fingerprint || row.p_principal !== row.creator_principal_id ||
        row.p_root !== row.root_identity || row.p_policy !== row.execution_policy_json ||
        definition.id !== row.id || sha256Hex(serializeDefinition(definition)) !== row.file_sha256 ||
        scheduleFingerprint({ definition, rootIdentity: row.root_identity as string,
          creatorPrincipalId: row.creator_principal_id as string,
          executionPolicy: JSON.parse(row.execution_policy_json as string) }) !== row.fingerprint)
      throw new Error("inbox_snapshot_relations");
  }
  const orphans = db.query(`SELECT 1 FROM schedule_approvals a LEFT JOIN schedule_tasks t ON t.approval_id = a.id
    WHERE (a.consumed_at IS NULL) != (t.id IS NULL) LIMIT 1`).get();
  if (orphans) throw new Error("inbox_snapshot_relations");
  // Every attempt belongs to an item of its own occurrence, and the occurrence
  // counters cover at least every started attempt.
  const attempts = db.query(`SELECT 1 FROM schedule_attempts a JOIN schedule_occurrence_items l ON l.item_id = a.item_id
    WHERE l.occurrence_id != a.occurrence_id LIMIT 1`).get();
  const counters = db.query(`SELECT 1 FROM schedule_occurrences o
    WHERE o.operations_used < (SELECT COUNT(*) FROM schedule_attempts a WHERE a.occurrence_id = o.id) LIMIT 1`).get();
  if (attempts || counters) throw new Error("inbox_snapshot_relations");
}

/**
 * Restore reconciliation, inside the restore's own transaction. Matching old
 * files and an old image cannot prove that no later cancellation, revocation
 * or effect happened, so every enabled task pauses for verified operator
 * reconciliation and every outstanding occurrence becomes an unknown outcome.
 */
export function pauseRestoredSchedules(db: Database, at: number): void {
  // Instants that arrived while those occurrences were outstanding were busy,
  // up to their expiry at the latest; reconciliation must not replay them.
  db.query(`UPDATE schedule_tasks SET evaluated_through = MAX(evaluated_through, (
      SELECT MAX(MIN(?, o.expires_at - 1)) FROM schedule_occurrences o WHERE o.task_id = schedule_tasks.id
        AND o.state IN ('queued', 'running', 'unwinding', 'waiting_for_action', 'retrying')))
    WHERE EXISTS (SELECT 1 FROM schedule_occurrences o WHERE o.task_id = schedule_tasks.id
      AND o.state IN ('queued', 'running', 'unwinding', 'waiting_for_action', 'retrying'))`).run(at);
  db.query(`UPDATE schedule_occurrences SET state = 'unknown', updated_at = ?
    WHERE state IN ('queued', 'running', 'unwinding', 'waiting_for_action', 'retrying')`).run(at);
  // Attempts whose worker was lost with the old installation end unknown too.
  db.query("UPDATE schedule_attempts SET outcome = 'unknown', ended_at = ? WHERE outcome IS NULL").run(at);
  db.query(`UPDATE schedule_tasks SET state = 'paused', blocked_reason = 'restore_pending', updated_at = ?
    WHERE state IN ('active', 'publishing')`).run(at);
  // Restore has already returned old claims to the Queue. Work for an unknown
  // occurrence must never be claimed again, so its items are dropped here.
  const tasks = db.query("SELECT DISTINCT task_id FROM schedule_occurrences WHERE state = 'unknown'").all() as { task_id: string }[];
  for (const { task_id } of tasks) dropUnstartedItems(db, task_id, at);
}
