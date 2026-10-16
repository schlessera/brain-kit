-- Charged by the existing journal allocation owner. Admission is bounded; receipts never trigger replay.
CREATE TABLE turn_journal_storage_operations (
  id TEXT PRIMARY KEY, brain TEXT NOT NULL, principal_id TEXT NOT NULL,
  action TEXT NOT NULL, source_id TEXT, selection TEXT NOT NULL, fingerprint TEXT NOT NULL,
  journal_turn_id TEXT NOT NULL, state TEXT NOT NULL, pid INTEGER NOT NULL, pid_start TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0, requested_at INTEGER NOT NULL,
  receipt TEXT NOT NULL, private_versions TEXT NOT NULL
);
CREATE UNIQUE INDEX turn_journal_storage_active ON turn_journal_storage_operations(brain) WHERE state IN ('waiting','running');
