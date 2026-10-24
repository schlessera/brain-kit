-- The folders a provider policy's type selectors last translated to, per brain
-- (#2836). Admission translates them in a masked worker; every writer the gate
-- admits afterwards, in any process and after a restart, plans them while the
-- policy hash still matches. One row per brain, replaced on each translation.
-- Derived admission bookkeeping, never permission: a missing, unreadable or
-- other-hash row plans no type folder.
CREATE TABLE provider_type_folders (
  brain TEXT PRIMARY KEY,
  policy_hash TEXT NOT NULL,
  folders TEXT NOT NULL,
  translated_at INTEGER NOT NULL
);
