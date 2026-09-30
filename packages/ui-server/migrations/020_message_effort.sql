-- One-message effort provenance belongs beside message source metadata,
-- not in the backend's saved session defaults.
ALTER TABLE message_sources ADD COLUMN thinking_level TEXT;
ALTER TABLE message_sources ADD COLUMN effective_thinking_level TEXT;
ALTER TABLE message_sources ADD COLUMN turn_id TEXT;
CREATE INDEX message_sources_turn ON message_sources (session_id, turn_id);
