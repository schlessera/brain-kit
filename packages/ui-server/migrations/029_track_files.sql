-- Operational replay metadata; original files remain in contained staging.
ALTER TABLE message_sources ADD COLUMN track_files TEXT;
