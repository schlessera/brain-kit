-- A writer retains the literal provider folder roots inherited at admission.
-- NULL marks pre-upgrade/unaccounted writers; it is never evidence of mounted pins.
-- This is derived admission bookkeeping, not an authoritative content index.
ALTER TABLE writer_gate ADD COLUMN folder_topology TEXT;
