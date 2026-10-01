-- Admission-time pricing/configuration must survive process death. The day and
-- reservation are immutable accounting facts, independent of later config or
-- pricing refreshes. Legacy active rows have no bounds: recovery retains their
-- entire reservation rather than inventing free inference.
ALTER TABLE inbox_budget_reservations ADD COLUMN pricing_json TEXT CHECK (pricing_json IS NULL OR json_valid(pricing_json));
ALTER TABLE inbox_budget_reservations ADD COLUMN runtime_acquired_at INTEGER;
ALTER TABLE inbox_budget_reservations ADD COLUMN observed_billing_mode TEXT CHECK (observed_billing_mode IN ('api', 'subscription'));
CREATE INDEX inbox_reservations_run ON inbox_budget_reservations(run_id) WHERE run_id IS NOT NULL;
CREATE TRIGGER inbox_budget_frozen BEFORE UPDATE ON inbox_budget_reservations
WHEN OLD.status != 'active'
BEGIN SELECT RAISE(ABORT, 'Frozen inbox budget settlement'); END;
