-- Independent host envelopes have no span/rollup or usage rows.
CREATE TABLE activity_turn_lifecycles (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT,
  accepted_at INTEGER NOT NULL,
  ended_at INTEGER,
  record TEXT NOT NULL
);
CREATE INDEX activity_lifecycle_session ON activity_turn_lifecycles(session_id, accepted_at DESC);
