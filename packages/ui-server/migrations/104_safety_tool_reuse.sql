-- The tool-use IDs under which a turn's own collector observed differently
-- named calls (#4513), as a JSON array written by the collection's end: at
-- most 8 IDs, or ["*"] when it could not track them one by one. NULL: the
-- turn was never checked (it predates this column, or ended any other way),
-- and reads as before: no ID is reported unknown.
ALTER TABLE safety_collections ADD COLUMN tool_reuse TEXT;
