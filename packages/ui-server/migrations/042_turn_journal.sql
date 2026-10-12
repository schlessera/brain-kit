-- Host operational journal state. Raw content objects live beside DB_PATH;
-- this database remains authoritative for retention, ownership and admission.
CREATE TABLE turn_journal_allocation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pages TEXT NOT NULL DEFAULT '[]',
  wal_reserved INTEGER NOT NULL DEFAULT 0
);
INSERT INTO turn_journal_allocation (id) VALUES (1);

CREATE TABLE turn_journal_objects (
  hash TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'present'))
);
CREATE TABLE turn_journal_reservations (
  id TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  pid INTEGER NOT NULL,
  pid_start TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hash TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'copy' CHECK (kind IN ('copy','read'))
);
CREATE TABLE turn_journal_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT,
  actor TEXT NOT NULL,
  model TEXT,
  profile TEXT NOT NULL,
  policy_hash TEXT,
  pid INTEGER NOT NULL DEFAULT 0,
  pid_start TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  state TEXT NOT NULL,
  failure TEXT NOT NULL DEFAULT '                                                                ',
  summary TEXT,
  missing TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX turn_journal_session ON turn_journal_turns (session_id, started_at);
CREATE TABLE turn_journal_manifests (
  turn_id TEXT PRIMARY KEY REFERENCES turn_journal_turns (turn_id),
  data TEXT NOT NULL
);
CREATE TABLE turn_journal_changes (
  turn_id TEXT NOT NULL REFERENCES turn_journal_turns (turn_id),
  sequence INTEGER NOT NULL,
  path TEXT NOT NULL,
  scope TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  class TEXT NOT NULL DEFAULT 'content',
  actor TEXT NOT NULL DEFAULT 'agent',
  overlaps TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (turn_id, sequence, path)
);
CREATE TABLE turn_journal_object_refs (
  turn_id TEXT NOT NULL REFERENCES turn_journal_turns (turn_id),
  hash TEXT NOT NULL REFERENCES turn_journal_objects (hash),
  PRIMARY KEY (turn_id, hash)
);
