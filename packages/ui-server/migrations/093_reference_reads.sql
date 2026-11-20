-- Host-only evidence. No source bytes or provider-facing receipts are stored here.
-- Acquisition facts are retained as a snapshot so eviction cannot erase a read.
CREATE TABLE reference_reads (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  acquisition TEXT NOT NULL,
  evidence TEXT NOT NULL,
  response_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivery TEXT NOT NULL DEFAULT 'prepared' CHECK (delivery IN ('prepared', 'observed', 'unknown')),
  observed_at INTEGER,
  UNIQUE (turn_id, tool_call_id)
);
