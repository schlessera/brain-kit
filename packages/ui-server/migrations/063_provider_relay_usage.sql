-- Metered brain CLI provider requests through the host relay (#1673): one row
-- per physical upstream attempt, keyed by the relay's own attempt identity so a
-- replayed observation never adds twice. A maintenance run outside any turn has
-- no turn and counts toward its UTC day only.
CREATE TABLE provider_relay_usage (
  attempt_id TEXT PRIMARY KEY, turn_id TEXT, day_start INTEGER NOT NULL, observed_at INTEGER NOT NULL,
  family TEXT NOT NULL, operation TEXT NOT NULL, origin TEXT NOT NULL, model TEXT, outcome TEXT NOT NULL, status INTEGER NOT NULL,
  usage TEXT, cost_usd REAL, pricing_estimate INTEGER, tokens INTEGER
);
CREATE INDEX provider_relay_usage_turn ON provider_relay_usage(turn_id);
CREATE INDEX provider_relay_usage_day ON provider_relay_usage(day_start);
