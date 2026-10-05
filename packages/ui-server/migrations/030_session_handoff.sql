-- Cross-backend handoff (#61): a destination session names its source and
-- the client-minted key that created it. The key is unique, so a repeated
-- handoff returns the existing destination instead of creating another.
-- handoff_from_messages is how many messages the source had when it was
-- handed off, so its forward marker keeps its place as the source continues.
ALTER TABLE sessions ADD COLUMN handoff_from TEXT;
ALTER TABLE sessions ADD COLUMN handoff_id TEXT;
ALTER TABLE sessions ADD COLUMN handoff_from_messages INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_handoff_id ON sessions(handoff_id) WHERE handoff_id IS NOT NULL;
