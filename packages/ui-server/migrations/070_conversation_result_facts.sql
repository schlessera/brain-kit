-- Nullable for older task rows; historical data only, never an executable response.
ALTER TABLE conversation_tasks ADD COLUMN result_facts TEXT;
