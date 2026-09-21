-- Blocks the surface classified out of an assistant message's text (D42).
-- Keyed by the session and a hash of the text part's normalised content, so
-- the same part keys the same blocks whether it arrived as streamed deltas or
-- replayed from the backend's transcript, and history renders as the live
-- turn did without a second classification pass.
CREATE TABLE IF NOT EXISTS message_blocks (
  session_id TEXT NOT NULL,
  part_hash TEXT NOT NULL,
  blocks TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, part_hash)
);
