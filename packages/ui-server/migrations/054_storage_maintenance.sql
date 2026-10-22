-- Host-owned durable identities. No automatic receipt expiry or owner-data purge.
CREATE TABLE storage_maintenance_operations (
  id TEXT PRIMARY KEY,
  brain TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL,
  pid_start TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  receipt TEXT NOT NULL
);
CREATE UNIQUE INDEX storage_maintenance_active ON storage_maintenance_operations(brain)
  WHERE state IN ('waiting','running');
CREATE INDEX storage_maintenance_recent ON storage_maintenance_operations(brain, principal_id, requested_at);
