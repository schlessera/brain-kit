-- A restored operational image is visible before its staging bytes. No runtime
-- or inference acquisition may use it until reconciliation commits atomically.
CREATE TABLE inbox_recovery_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot_checksum TEXT NOT NULL,
  brain_root TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready')),
  restored_at INTEGER
);
