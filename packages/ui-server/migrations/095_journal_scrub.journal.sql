-- Commit a conservative byte charge before moving any orphan. Interrupted
-- moves keep their charge and are reconciled by the next maintenance pass.
CREATE TABLE journal.turn_journal_scrub_quarantine (
  hash TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  state TEXT NOT NULL CHECK (state IN ('reserved','quarantined'))
);
