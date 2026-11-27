-- The budget receipt's session and day scopes read through indexes (#4799);
-- neither table is trimmed, so a scan would grow with every turn ever run.
CREATE INDEX turn_budget_usage_started ON turn_budget_usage(started_at);
CREATE INDEX turn_budget_days_day ON turn_budget_days(day_start);
CREATE INDEX idx_activity_rollups_session ON activity_run_rollups(session_id) WHERE session_id IS NOT NULL;
