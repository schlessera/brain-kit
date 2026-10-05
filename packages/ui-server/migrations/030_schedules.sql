-- Scheduled-task operational ledger (Store B, docs/decisions/scheduled-tasks.md).
-- Definition files under context/scheduled-tasks/ are content; everything that
-- carries authority or control state lives here. No FK to principals: pruning
-- or revocation must not erase creator/approver attribution.

-- Host-owned identity of the canonical brain root this database serves, plus
-- the key that signs pagination cursors.
CREATE TABLE schedule_root (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  root_identity TEXT NOT NULL,
  root_path TEXT NOT NULL,
  cursor_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- A proposal stores no authoritative definition and enables nothing. It binds
-- the creator's request key to one materialized definition and fingerprint.
CREATE TABLE schedule_proposals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  zone_source TEXT NOT NULL CHECK (zone_source IN ('explicit', 'client', 'utc_fallback')),
  execution_policy_json TEXT NOT NULL CHECK (json_valid(execution_policy_json)),
  root_identity TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE (principal_id, request_key)
);
CREATE TRIGGER schedule_proposals_immutable BEFORE UPDATE ON schedule_proposals
BEGIN SELECT RAISE(ABORT, 'Schedule proposals are immutable'); END;

-- A verified operator decision on one exact proposal/fingerprint. Consumed once.
CREATE TABLE schedule_approvals (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES schedule_proposals(id),
  approver_principal_id TEXT NOT NULL,
  approver_kind TEXT NOT NULL CHECK (approver_kind IN ('owner', 'ambient')),
  channel TEXT NOT NULL CHECK (channel IN ('http')),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  nonce TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE TRIGGER schedule_approvals_immutable BEFORE UPDATE ON schedule_approvals
WHEN NEW.id != OLD.id OR NEW.proposal_id != OLD.proposal_id
  OR NEW.approver_principal_id != OLD.approver_principal_id OR NEW.approver_kind != OLD.approver_kind
  OR NEW.channel != OLD.channel OR NEW.fingerprint != OLD.fingerprint OR NEW.nonce != OLD.nonce
  OR NEW.approved_at != OLD.approved_at OR OLD.consumed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Schedule approvals are immutable'); END;

-- The approved immutable snapshot, its publication/retirement journals and
-- control state. A row is the creation receipt for its proposal.
CREATE TABLE schedule_tasks (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES schedule_proposals(id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES schedule_approvals(id),
  creator_principal_id TEXT NOT NULL,
  root_identity TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  execution_policy_json TEXT NOT NULL CHECK (json_valid(execution_policy_json)),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  zone_source TEXT NOT NULL CHECK (zone_source IN ('explicit', 'client', 'utc_fallback')),
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('publishing', 'active', 'paused', 'cancelled', 'completed', 'failed', 'expired')),
  blocked_reason TEXT CHECK (blocked_reason IS NULL OR blocked_reason IN ('definition_drift', 'unknown_effect', 'restore_pending')),
  publication TEXT NOT NULL CHECK (publication IN ('pending', 'published', 'quarantined')),
  retirement TEXT NOT NULL CHECK (retirement IN ('none', 'pending', 'retired')),
  cancelled_at INTEGER,
  evaluated_through INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((state = 'paused') = (blocked_reason IS NOT NULL)),
  CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (retirement = 'none' OR state = 'cancelled'),
  CHECK (state != 'publishing' OR publication = 'pending')
);
CREATE INDEX schedule_tasks_listing ON schedule_tasks(created_at, id);
CREATE TRIGGER schedule_tasks_snapshot_immutable BEFORE UPDATE ON schedule_tasks
WHEN NEW.id != OLD.id OR NEW.proposal_id != OLD.proposal_id OR NEW.approval_id != OLD.approval_id
  OR NEW.creator_principal_id != OLD.creator_principal_id OR NEW.root_identity != OLD.root_identity
  OR NEW.definition_json != OLD.definition_json OR NEW.execution_policy_json != OLD.execution_policy_json
  OR NEW.fingerprint != OLD.fingerprint OR NEW.file_sha256 != OLD.file_sha256
  OR NEW.zone_source != OLD.zone_source OR NEW.created_at != OLD.created_at
  OR (OLD.state = 'cancelled' AND NEW.state != 'cancelled')
  OR NEW.evaluated_through < OLD.evaluated_through
BEGIN SELECT RAISE(ABORT, 'Approved schedule snapshots are immutable and cancellation is final'); END;

-- Cancel receipts bind one caller key to one task.
CREATE TABLE schedule_cancel_receipts (
  principal_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES schedule_tasks(id),
  changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, request_key)
);
CREATE TRIGGER schedule_cancel_receipts_immutable BEFORE UPDATE ON schedule_cancel_receipts
BEGIN SELECT RAISE(ABORT, 'Schedule cancel receipts are immutable'); END;

-- Occurrences: deterministic identity from task plus original due instant.
-- At most one outstanding occurrence per task, guarded by the database.
CREATE TABLE schedule_occurrences (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES schedule_tasks(id),
  due_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'unwinding', 'waiting_for_action', 'retrying',
    'completed', 'failed', 'cancelled', 'expired', 'unknown')),
  operations_used INTEGER NOT NULL DEFAULT 0,
  max_operations INTEGER NOT NULL CHECK (max_operations BETWEEN 1 AND 3),
  run_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(run_ids_json) AND json_array_length(run_ids_json) <= 3),
  attempt_deadline_at INTEGER,
  result_state TEXT NOT NULL DEFAULT 'unavailable' CHECK (result_state IN ('available', 'pruned', 'unavailable')),
  result_text TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (task_id, due_at),
  CHECK (operations_used BETWEEN 0 AND max_operations),
  CHECK (expires_at = due_at + 86400000),
  CHECK ((result_state = 'available') = (result_text IS NOT NULL))
);
CREATE UNIQUE INDEX schedule_one_outstanding ON schedule_occurrences(task_id)
  WHERE state IN ('queued', 'running', 'unwinding', 'waiting_for_action', 'retrying');
CREATE TRIGGER schedule_occurrences_identity_immutable BEFORE UPDATE ON schedule_occurrences
WHEN NEW.id != OLD.id OR NEW.task_id != OLD.task_id OR NEW.due_at != OLD.due_at
  OR NEW.expires_at != OLD.expires_at OR NEW.max_operations != OLD.max_operations
  OR NEW.operations_used < OLD.operations_used
BEGIN SELECT RAISE(ABORT, 'Occurrence identity and counters cannot move backwards'); END;
