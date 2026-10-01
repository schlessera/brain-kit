-- Server-owned lifecycle context; model/client effect data never selects it.
CREATE TABLE inbox_action_contexts (
  item_id TEXT PRIMARY KEY REFERENCES inbox_items(id),
  source_item_id TEXT REFERENCES inbox_items(id),
  class_key TEXT NOT NULL,
  evidence_boundary TEXT NOT NULL,
  suppression_until INTEGER NOT NULL,
  reraise_condition TEXT NOT NULL,
  options_json TEXT NOT NULL CHECK (json_valid(options_json))
);
CREATE TRIGGER inbox_action_context_no_update BEFORE UPDATE ON inbox_action_contexts
BEGIN SELECT RAISE(ABORT, 'Immutable Action context'); END;
CREATE TRIGGER inbox_action_context_no_delete BEFORE DELETE ON inbox_action_contexts
BEGIN SELECT RAISE(ABORT, 'Retained Action context'); END;
