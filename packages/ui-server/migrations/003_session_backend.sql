-- Which AgentBackend owns a session's transcript (e.g. "claude" | "pi").
-- One backend is active per deployment in v1, but the column is added now so a
-- later per-session-backend change needs no migration. Populated on session
-- creation from the active backend id.
ALTER TABLE sessions ADD COLUMN backend_id TEXT;
