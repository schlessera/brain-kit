-- Only the latest failed request retains its original images and options.
-- Starting another input consumes that eligibility. Receipts survive a lost
-- WebSocket acknowledgement so reconnects query delivery instead of resending.
CREATE TABLE retry_requests (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  failure_message TEXT NOT NULL
);
CREATE TABLE retry_receipts (
  request_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'refused'))
);
