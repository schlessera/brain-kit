-- Host-owned terminal metadata; the backend transcript remains the conversation.
CREATE TABLE turn_failures (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  backend_id TEXT NOT NULL,
  assistant_ordinal INTEGER NOT NULL CHECK (assistant_ordinal >= 0),
  turn_id TEXT NOT NULL,
  prefix_digest TEXT NOT NULL,
  failure_json TEXT NOT NULL,
  PRIMARY KEY (session_id, backend_id, assistant_ordinal, prefix_digest)
);
