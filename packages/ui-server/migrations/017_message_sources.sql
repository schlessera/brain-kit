-- How each user message was produced (typed, dictated, spoken in a voice
-- conversation), as the client reported it on chat_message. The backends
-- replay transcripts from their own stores and know nothing of it, so the
-- host keeps it and joins it back onto replayed history.
--
-- Keyed by the session, a hash of the message's exact text, and the
-- message's ordinal among identical texts in that session: two "yes"
-- messages can differ in source. Typed messages are stored too, because
-- they hold the ordinals the others are counted against.
CREATE TABLE IF NOT EXISTS message_sources (
  session_id TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, text_hash, ordinal)
);
