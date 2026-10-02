-- Server-observed tool completion receipts survive cooperative yield/crash.
-- They restrict replay; they do not authorize tools or alter content authority.
CREATE TABLE inbox_completed_tool_calls (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_items(id),
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  completed_at INTEGER NOT NULL
);
CREATE INDEX inbox_completed_tool_calls_item ON inbox_completed_tool_calls(item_id);
CREATE TRIGGER inbox_completed_tool_calls_no_update BEFORE UPDATE ON inbox_completed_tool_calls
BEGIN SELECT RAISE(ABORT, 'Append-only autonomous receipt'); END;
CREATE TRIGGER inbox_completed_tool_calls_no_delete BEFORE DELETE ON inbox_completed_tool_calls
BEGIN SELECT RAISE(ABORT, 'Append-only autonomous receipt'); END;
