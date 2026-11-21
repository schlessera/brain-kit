-- Host-owned endpoint packs share journal CAS accounting and turn lifetime pins.
CREATE TABLE journal.turn_journal_code_receipts (
  turn_id TEXT NOT NULL REFERENCES turn_journal_turns(turn_id) ON DELETE CASCADE,
  checkout TEXT NOT NULL,
  receipt TEXT NOT NULL,
  pack_hash TEXT NOT NULL REFERENCES turn_journal_objects(hash),
  PRIMARY KEY (turn_id, checkout)
);

CREATE TABLE journal.turn_journal_code_reverts (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL REFERENCES turn_journal_turns(turn_id) ON DELETE CASCADE,
  checkout TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applying','complete','unknown','failed')),
  result TEXT,
  pid INTEGER NOT NULL,
  pid_start TEXT NOT NULL
);

CREATE TABLE journal.turn_journal_code_failures (
  turn_id TEXT NOT NULL REFERENCES turn_journal_turns(turn_id) ON DELETE CASCADE,
  checkout TEXT NOT NULL,
  cause TEXT NOT NULL,
  PRIMARY KEY (turn_id, checkout)
);
