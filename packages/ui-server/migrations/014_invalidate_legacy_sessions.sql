-- Advance the legacy v1 cookie epoch once at upgrade so every pre-upgrade
-- cookie stays invalid if the deployment rolls back to the v1 verifier.
INSERT INTO settings (key, value, updated_at)
VALUES ('auth.sessionsEpoch', '1', CAST(strftime('%s', 'now') AS INTEGER) * 1000)
ON CONFLICT(key) DO UPDATE SET
  value = CASE
    WHEN json_valid(value) THEN CASE
      WHEN json_type(value) = 'integer' AND CAST(value AS INTEGER) >= 0
        THEN CAST(CAST(value AS INTEGER) + 1 AS TEXT)
      ELSE '1'
    END
    ELSE '1'
  END,
  updated_at = excluded.updated_at;
