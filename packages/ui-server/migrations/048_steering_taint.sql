-- Capture the source at observation time; replay must not infer later taint.
ALTER TABLE turn_journal_changes ADD COLUMN taint_source_event_id INTEGER;
ALTER TABLE turn_journal_turns ADD COLUMN steering_inventory_missing TEXT NOT NULL DEFAULT '[]';
