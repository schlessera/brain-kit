-- Interactive claims and authoritative filing receipts survive lost replies.
CREATE TABLE inbox_interactive_shares (
  item_id TEXT PRIMARY KEY REFERENCES inbox_items(id),
  staging_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  session_id TEXT UNIQUE,
  run_id TEXT NOT NULL,
  completion_json TEXT CHECK (completion_json IS NULL OR json_valid(completion_json))
);
CREATE TABLE inbox_share_applications (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_interactive_shares(item_id),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  operation_key TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  UNIQUE(item_id, operation_key)
);

ALTER TABLE inbox_intake_receipts ADD COLUMN binary_hashes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(binary_hashes_json));
