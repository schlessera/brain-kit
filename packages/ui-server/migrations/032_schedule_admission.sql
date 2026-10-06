-- Occurrence admission through the Queue (Execution A, Budget A) and verified
-- operator reconciliation (Store B), docs/decisions/scheduled-tasks.md. The
-- admission code is not wired to a production tick here (#915, gated by #689).

-- Every Queue item created for an occurrence: the first one and any later
-- continuation. The occurrence's operation counter spans all of them.
CREATE TABLE schedule_occurrence_items (
  item_id TEXT PRIMARY KEY REFERENCES inbox_items(id),
  occurrence_id TEXT NOT NULL REFERENCES schedule_occurrences(id),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  created_at INTEGER NOT NULL,
  UNIQUE (occurrence_id, sequence)
);
CREATE TRIGGER schedule_occurrence_items_immutable BEFORE UPDATE ON schedule_occurrence_items
BEGIN SELECT RAISE(ABORT, 'Occurrence item links are immutable'); END;

-- One row per started model-bearing operation, keyed by its Queue run. The
-- host-owned deadline is fixed at start; an ended attempt never changes.
CREATE TABLE schedule_attempts (
  run_id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL REFERENCES schedule_occurrences(id),
  item_id TEXT NOT NULL REFERENCES schedule_occurrence_items(item_id),
  started_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success', 'error', 'timeout', 'cancelled', 'interrupted', 'unknown')),
  CHECK (deadline_at > started_at),
  CHECK ((outcome IS NULL) = (ended_at IS NULL))
);
CREATE INDEX schedule_attempts_occurrence ON schedule_attempts(occurrence_id);
CREATE TRIGGER schedule_attempts_immutable BEFORE UPDATE ON schedule_attempts
WHEN NEW.run_id != OLD.run_id OR NEW.occurrence_id != OLD.occurrence_id OR NEW.item_id != OLD.item_id
  OR NEW.started_at != OLD.started_at OR NEW.deadline_at != OLD.deadline_at OR OLD.outcome IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Schedule attempts are immutable once ended'); END;

-- A verified operator's decision to reopen a paused task after a restore or
-- an unknown effect. The receipt binds one caller key to one task.
CREATE TABLE schedule_reconciliations (
  principal_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES schedule_tasks(id),
  approver_kind TEXT NOT NULL CHECK (approver_kind IN ('owner', 'ambient')),
  resolved_reason TEXT CHECK (resolved_reason IS NULL OR resolved_reason IN ('restore_pending', 'unknown_effect')),
  changed INTEGER NOT NULL CHECK (changed IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK ((changed = 1) = (resolved_reason IS NOT NULL)),
  PRIMARY KEY (principal_id, request_key)
);
CREATE TRIGGER schedule_reconciliations_immutable BEFORE UPDATE ON schedule_reconciliations
BEGIN SELECT RAISE(ABORT, 'Schedule reconciliation receipts are immutable'); END;
