-- Retained text evidence is chat history, independent of native recovery-cache eviction.
CREATE TABLE dialogue_owners (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  session_id TEXT UNIQUE,
  generation INTEGER NOT NULL DEFAULT 1,
  coverage TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE dialogue_conversations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES dialogue_owners(id),
  epoch INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE dialogue_records (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES dialogue_owners(id),
  identity TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(owner_id,identity)
);
CREATE INDEX dialogue_page ON dialogue_records(owner_id,sequence);
CREATE TABLE dialogue_aliases (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES dialogue_owners(id));
