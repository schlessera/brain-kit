-- Frozen effective-cost accounting on run rollups (computed in rollupRunInTx).
--
-- effective_cost_usd: what the run actually cost — 0 for subscription-billed
-- work regardless of tokens, priced per-model usage for api-billed. NULL =
-- unknown, 0 = genuinely free (never conflated). billing_mode is the
-- 'subscription' | 'api' classification behind that number; pricing_estimate
-- is 1 when the price came from estimated rates (snapshot data, or an
-- OpenRouter routing variant priced at its base rate).
--
-- Deliberately NO backfill: pre-feature rows carry no billing attrs and their
-- span detail may already be pruned, so any classification would be a guess.
-- They stay NULL (= unknown) by decision — every surface renders unknown,
-- never $0.
ALTER TABLE activity_run_rollups ADD COLUMN effective_cost_usd REAL;
ALTER TABLE activity_run_rollups ADD COLUMN billing_mode TEXT;
ALTER TABLE activity_run_rollups ADD COLUMN pricing_estimate INTEGER;
