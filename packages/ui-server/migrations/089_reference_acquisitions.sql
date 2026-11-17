-- Host acquisition bookkeeping, outside repository content and provider history.
-- A retained sealed root has at most one acquisition identity. This is not
-- evidence that any particular bytes were read by a model.
CREATE TABLE reference_acquisitions (
  root_id TEXT PRIMARY KEY REFERENCES reference_roots(id) ON DELETE CASCADE,
  acquisition_id TEXT NOT NULL UNIQUE,
  brain TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  ref TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  tree_id TEXT NOT NULL,
  native_root_id TEXT NOT NULL,
  native_uuid TEXT NOT NULL,
  native_generation TEXT NOT NULL,
  grant_id TEXT,
  network_bytes INTEGER NOT NULL CHECK (network_bytes >= 0),
  acquired_at INTEGER NOT NULL
);
