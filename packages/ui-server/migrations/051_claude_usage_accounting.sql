-- Turn-local completed responses and a high-water mark for unstreamed usage.
-- Old sessions acquire an unknown opening baseline, never a historical repair.
CREATE TABLE claude_session_usage (
  session_id TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  PRIMARY KEY (session_id, backend_id)
);
CREATE TABLE claude_usage_turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  backend_id TEXT NOT NULL
);
