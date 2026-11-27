-- Lookups on append-only tables read through an index (#4798); each of these
-- tables only grows for the life of the host.
CREATE INDEX dialogue_conversations_owner ON dialogue_conversations(owner_id, closed);
CREATE INDEX dialogue_aliases_owner ON dialogue_aliases(owner_id);
CREATE INDEX inbox_reservations_item ON inbox_budget_reservations(item_id);
CREATE INDEX inbox_resolutions_thread ON inbox_resolutions(thread_id);
CREATE INDEX inbox_interactive_shares_run ON inbox_interactive_shares(run_id);
CREATE INDEX idx_notification_intents_run ON notification_intents(run_id, kind);
-- The table's UNIQUE(thread_id, seq) already indexes these columns.
DROP INDEX inbox_changes_thread;
