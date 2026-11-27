-- Differently named calls observed under one tool-use ID in a collection
-- (#4513). The host cannot attribute that ID's inputs to either call, so
-- history reports their attribution as unknown. A NULL tool_use_id covers
-- every tool-use ID in the collection (the collector or this table ran out
-- of room to track them one by one). Each row takes a revision of its own,
-- so live readers receive it after the inputs it qualifies, and is charged
-- against the same session and brain row/byte ceilings as other history
-- rows through safety_usage.
CREATE TABLE safety_tool_reuse (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES safety_collections(id) ON DELETE CASCADE,
  tool_use_id TEXT,
  sequence TEXT NOT NULL UNIQUE,
  observed_at INTEGER NOT NULL,
  reserved_rows INTEGER NOT NULL,
  reserved_bytes INTEGER NOT NULL
);
CREATE UNIQUE INDEX safety_tool_reuse_key ON safety_tool_reuse(collection_id, COALESCE(tool_use_id, ''));
-- Every history row that holds room against the ceilings.
CREATE VIEW safety_usage AS
  SELECT collection_id, reserved_rows, reserved_bytes FROM safety_records
  UNION ALL SELECT collection_id, reserved_rows, reserved_bytes FROM safety_tool_reuse;
