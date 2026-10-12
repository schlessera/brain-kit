-- Durable scope receipts share the retained session lifetime; no second file journal.
CREATE TABLE turn_scope (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  ended_at INTEGER
);
CREATE INDEX turn_scope_session ON turn_scope(session_id);
