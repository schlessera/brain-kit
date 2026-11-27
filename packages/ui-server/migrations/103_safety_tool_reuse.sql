-- Differently named calls observed under one tool-use ID in a collection
-- (#4513). The host cannot attribute that ID's inputs to either call, so
-- history reports their attribution as unknown. Each row takes a revision of
-- its own, so live readers receive it after the inputs it qualifies.
CREATE TABLE safety_tool_reuse (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES safety_collections(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL,
  sequence TEXT NOT NULL UNIQUE,
  observed_at INTEGER NOT NULL,
  UNIQUE(collection_id, tool_use_id)
);
