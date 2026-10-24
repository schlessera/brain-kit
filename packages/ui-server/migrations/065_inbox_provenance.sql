-- Trusted host provenance of what an autonomous turn's origin thread can show
-- it (#2741, maintainer ruling C). Host code writes one row per item or
-- checkpoint, in the transaction that writes it; no model or client field
-- reaches it. `origin` says who produced the text: a person through
-- authenticated intake outside any turn, the server from no brain content or
-- model output, or an autonomous run, whose admitted provider masks `hidden`
-- holds. `derived_from` names the subject a copy inherits its origin from.
-- `digest` binds the row to the text it describes, and `evidence` binds an
-- arrival to the staged bytes queued work reads. A provider-masked autonomous
-- turn is refused a thread with any item or checkpoint lacking a matching,
-- compatible row.
CREATE TABLE inbox_provenance (
  subject TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES inbox_threads(id),
  digest TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('person', 'server', 'autonomous')),
  hidden TEXT CHECK (hidden IS NULL OR json_valid(hidden)),
  run_id TEXT,
  derived_from TEXT,
  evidence TEXT,
  recorded_at INTEGER NOT NULL,
  CHECK ((origin = 'autonomous') = (hidden IS NOT NULL AND run_id IS NOT NULL))
);
CREATE INDEX inbox_provenance_thread ON inbox_provenance(thread_id);
CREATE TRIGGER inbox_provenance_no_update BEFORE UPDATE ON inbox_provenance
BEGIN SELECT RAISE(ABORT, 'Append-only inbox provenance'); END;
CREATE TRIGGER inbox_provenance_no_delete BEFORE DELETE ON inbox_provenance
BEGIN SELECT RAISE(ABORT, 'Append-only inbox provenance'); END;

-- An autonomous run's admitted provider exclusions and the provenance that
-- qualified its origin thread for them: JSON `{ policyHash, masked, subjects }`.
-- The run's own items and checkpoints take `masked` as their `hidden`.
ALTER TABLE inbox_budget_reservations ADD COLUMN provider_admission TEXT CHECK (provider_admission IS NULL OR json_valid(provider_admission));
