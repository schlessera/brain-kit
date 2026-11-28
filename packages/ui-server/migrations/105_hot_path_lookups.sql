-- Per-turn and per-tick lookups on tables that grow for the life of a host
-- (#5071, epic #4665). Each statement planned as a full scan before.

-- The safety ledger scope (safetyScope, SafetyHistory.scope) matches
-- collections by history owner, and beginSafetyCollection looks owners up by
-- (history_owner_id, generation): every turn, every safety write and every
-- subscribed socket's one-second poll.
CREATE INDEX safety_collections_history_owner ON safety_collections(history_owner_id, generation);

-- sessionTaint joins a record to its legacy governance event.
CREATE INDEX safety_legacy_events_record ON safety_legacy_events(record_id);

-- reconcileInboxBudgets reads the active reservations on every inbox drain.
-- Partial: a plain status index would replace the item and run indexes in
-- the statements that also name those.
CREATE INDEX inbox_reservations_active ON inbox_budget_reservations(item_id) WHERE status = 'active';

-- The budget totals read autonomous root runs by start time on every
-- autonomous admission. A later rebuild of activity_spans must recreate it.
CREATE INDEX activity_spans_root_origin_started ON activity_spans(origin, started_at) WHERE parent_span_id IS NULL;
