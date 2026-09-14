-- Principal attribution for activity spans and durable run rollups.
--
-- Deliberately NO backfill and no owner default: activity recorded before
-- this migration remains NULL (= unattributed). Rollups snapshot the live
-- principal's label and kind when they are first written because principal
-- rows expire and are pruned while activity_run_rollups are retained.
ALTER TABLE activity_spans ADD COLUMN principal_id TEXT;

ALTER TABLE activity_run_rollups ADD COLUMN principal_id TEXT;
ALTER TABLE activity_run_rollups ADD COLUMN principal_label TEXT;
ALTER TABLE activity_run_rollups ADD COLUMN principal_kind TEXT
  CHECK (principal_kind IN ('owner', 'agent', 'ambient', 'system'));
