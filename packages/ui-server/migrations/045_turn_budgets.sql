-- Operational completed-inference receipts, retained alongside Activity rollups.
CREATE TABLE turn_budget_usage (
  turn_id TEXT PRIMARY KEY, session_id TEXT, started_at INTEGER NOT NULL,
  cost_usd REAL, cost_lower_bound REAL, pricing_estimate INTEGER, tokens INTEGER, observed_at INTEGER NOT NULL, receipt TEXT
);
CREATE INDEX turn_budget_usage_session ON turn_budget_usage(session_id);
CREATE TABLE turn_budget_days (
  turn_id TEXT NOT NULL, day_start INTEGER NOT NULL, cost_usd REAL, cost_lower_bound REAL, tokens INTEGER,
  PRIMARY KEY(turn_id, day_start)
);
CREATE TABLE turn_budget_warnings (
  scope TEXT NOT NULL, identity TEXT NOT NULL, unit TEXT NOT NULL, threshold REAL NOT NULL,
  PRIMARY KEY(scope, identity, unit, threshold)
);
