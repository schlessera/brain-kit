-- Server-owned intake receipts also journal filesystem compensation. No FK to
-- principals: revocation/pruning must not erase the arrival's attribution.
CREATE TABLE inbox_intake_receipts (
  staging_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('share', 'cli')),
  principal_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reconcile_after INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('preparing', 'committed', 'cleanup')),
  item_id TEXT REFERENCES inbox_items(id),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  CHECK ((state = 'committed' AND item_id IS NOT NULL AND result_json IS NOT NULL)
    OR (state != 'committed' AND item_id IS NULL AND result_json IS NULL))
);
CREATE UNIQUE INDEX inbox_intake_committed_key ON inbox_intake_receipts(dedup_key)
  WHERE state = 'committed';
CREATE INDEX inbox_intake_compensation ON inbox_intake_receipts(state, reconcile_after);
CREATE TRIGGER inbox_intake_provenance_immutable BEFORE UPDATE ON inbox_intake_receipts
WHEN NEW.staging_id != OLD.staging_id OR NEW.source != OLD.source
  OR NEW.principal_id != OLD.principal_id OR NEW.dedup_key != OLD.dedup_key
  OR NEW.content_hash != OLD.content_hash OR NEW.created_at != OLD.created_at
  OR OLD.state = 'committed'
BEGIN SELECT RAISE(ABORT, 'Intake provenance is immutable'); END;
