-- Media review effects (#2781): one row per Delete, Move, Persist here or
-- Keep a permanent copy, and per Undo of one. Charged by the journal's
-- existing allocation owner, like attachment removal. The row records the
-- planned files and their retained pre-images before the first write, so a
-- restart compensates from it and never re-applies.
CREATE TABLE journal.turn_journal_media_operations (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, finding_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  action TEXT NOT NULL, source_id TEXT, journal_turn_id TEXT NOT NULL, state TEXT NOT NULL,
  pid INTEGER NOT NULL, pid_start TEXT NOT NULL, requested_at INTEGER NOT NULL,
  plan TEXT NOT NULL, versions TEXT NOT NULL, receipt TEXT NOT NULL
);
-- Admission refuses a second active operation (a check in the same write).
CREATE INDEX journal.turn_journal_media_state ON turn_journal_media_operations(state);
