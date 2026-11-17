-- Canonical authority keys do not reconstruct the endpoint used to acquire a
-- legacy source. Keep it with the worktree after source/grant cache cleanup.
ALTER TABLE reference_worktrees ADD COLUMN repository_url TEXT;
UPDATE reference_worktrees SET repository_url = (
  SELECT s.url FROM reference_sources s
  WHERE s.domain = reference_worktrees.domain
    AND s.repository = reference_worktrees.repository
    AND s.revision = reference_worktrees.revision
);
