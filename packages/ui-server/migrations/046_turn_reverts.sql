-- Revert queues only new turns; shared maintenance an existing turn awaits
-- remains admissible until that turn can release its writer-gate hold.
CREATE TABLE writer_gate_turn_waiters (
  id TEXT PRIMARY KEY,
  brain TEXT NOT NULL,
  pid INTEGER NOT NULL,
  pid_start TEXT NOT NULL,
  queued_at INTEGER NOT NULL
);
CREATE INDEX writer_gate_turn_waiters_brain ON writer_gate_turn_waiters (brain,queued_at);

ALTER TABLE turn_journal_turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'turn';
ALTER TABLE turn_journal_turns ADD COLUMN source_turn_id TEXT;

-- These names deliberately share the journal's allocation owner and cap.
CREATE TABLE turn_journal_revert_operations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  journal_turn_id TEXT NOT NULL REFERENCES turn_journal_turns(turn_id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  action TEXT NOT NULL,
  state TEXT NOT NULL,
  pid INTEGER NOT NULL,
  pid_start TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX turn_journal_reverts_source ON turn_journal_revert_operations(session_id,source_turn_id,requested_at);
CREATE TABLE turn_journal_revert_paths (
  operation_id TEXT NOT NULL REFERENCES turn_journal_revert_operations(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  before_sequence INTEGER,
  after_sequence INTEGER,
  state TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(operation_id,path)
);
