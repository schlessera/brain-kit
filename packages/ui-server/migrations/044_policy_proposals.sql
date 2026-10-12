-- Policy review receipts are host operational state, never brain.db or a journal store.
CREATE TABLE policy_proposals (
  request_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  review TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (turn_id, request_id)
);
CREATE INDEX policy_proposals_session ON policy_proposals(session_id);
