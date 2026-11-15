-- Corrupt retained bytes remain charged and unavailable until normal expiry
-- removes their last owner and collects them. Never accept them as undo data.
CREATE TABLE journal.turn_journal_object_quarantine (
  hash TEXT PRIMARY KEY REFERENCES turn_journal_objects(hash) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  error_class TEXT NOT NULL,
  message TEXT NOT NULL,
  call_site TEXT NOT NULL
);
