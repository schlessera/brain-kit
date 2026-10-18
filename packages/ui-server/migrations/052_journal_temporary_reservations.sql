ALTER TABLE turn_journal_reservations RENAME TO turn_journal_reservations_previous;
CREATE TABLE turn_journal_reservations (
  id TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  pid INTEGER NOT NULL,
  pid_start TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hash TEXT,
  kind TEXT NOT NULL DEFAULT 'copy' CHECK (kind IN ('copy','read','temporary')),
  CHECK ((kind = 'temporary' AND hash IS NULL) OR (kind != 'temporary' AND hash IS NOT NULL))
);
INSERT INTO turn_journal_reservations SELECT * FROM turn_journal_reservations_previous;
DROP TABLE turn_journal_reservations_previous;
