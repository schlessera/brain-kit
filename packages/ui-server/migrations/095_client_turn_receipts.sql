-- Bound at host acceptance, independent of backend/session ownership.
-- A NULL receipt means no report was accepted. Removing the lifecycle removes it.
CREATE TABLE activity_turn_clients (
  turn_id TEXT PRIMARY KEY REFERENCES activity_turn_lifecycles(turn_id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  receipt TEXT
);
