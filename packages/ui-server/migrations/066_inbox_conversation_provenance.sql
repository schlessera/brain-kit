-- An item a hosted conversation adds through `inbox_add` (#2816): origin
-- `conversation`, the adding turn in `turn_id`, and in `hidden` the folders
-- that conversation's born-masked lineage (#2726) kept masked from every turn
-- up to and including that one, as the host recorded it. A conversation
-- without a lineage for the adding turn records nothing, so its item never
-- qualifies. SQLite cannot change a CHECK in place, so the table is rebuilt;
-- every row the 065 writer could produce satisfies the new checks.
CREATE TABLE inbox_provenance_next (
  subject TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES inbox_threads(id),
  digest TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('person', 'server', 'autonomous', 'conversation')),
  hidden TEXT CHECK (hidden IS NULL OR json_valid(hidden)),
  run_id TEXT,
  turn_id TEXT,
  derived_from TEXT,
  evidence TEXT,
  recorded_at INTEGER NOT NULL,
  CHECK ((origin = 'autonomous') = (run_id IS NOT NULL)),
  CHECK ((origin = 'conversation') = (turn_id IS NOT NULL)),
  CHECK ((origin IN ('autonomous', 'conversation')) = (hidden IS NOT NULL))
);
INSERT INTO inbox_provenance_next (subject, thread_id, digest, origin, hidden, run_id, derived_from, evidence, recorded_at)
  SELECT subject, thread_id, digest, origin, hidden, run_id, derived_from, evidence, recorded_at FROM inbox_provenance;
DROP TABLE inbox_provenance;
ALTER TABLE inbox_provenance_next RENAME TO inbox_provenance;
CREATE INDEX inbox_provenance_thread ON inbox_provenance(thread_id);
CREATE TRIGGER inbox_provenance_no_update BEFORE UPDATE ON inbox_provenance
BEGIN SELECT RAISE(ABORT, 'Append-only inbox provenance'); END;
CREATE TRIGGER inbox_provenance_no_delete BEFORE DELETE ON inbox_provenance
BEGIN SELECT RAISE(ABORT, 'Append-only inbox provenance'); END;
