-- Live work by status and expiry (#4993). The lifecycle sweep's expired-work
-- branch reads it, so its range stops at the sweep time: inbox_items_ready
-- puts wait_until before expires_at, and that branch visited every live
-- item in its statuses, queued staging cleanups included. Those are outside
-- this index, as they are outside the branch.
CREATE INDEX inbox_items_work_expiry ON inbox_items(status, expires_at)
  WHERE deleted_at IS NULL AND queue = 'queue' AND type != 'cleanup_pending';
