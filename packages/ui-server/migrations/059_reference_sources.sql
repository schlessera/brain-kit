-- Reference-source catalog (#2429). Disposable app bookkeeping over native
-- pool roots: the manager's intents remain the authority for storage, and
-- startup releases any owned source root this catalog does not account for.
CREATE TABLE reference_views (
  domain    TEXT PRIMARY KEY NOT NULL,   -- 'public' or 'private:<principal id>'
  view_id   TEXT NOT NULL UNIQUE,        -- native pool view identity
  host_path TEXT                         -- manager-reported view directory once published
);
CREATE TABLE reference_sources (
  domain        TEXT NOT NULL,
  repository    TEXT NOT NULL,           -- canonical repository
  revision      TEXT NOT NULL,           -- branch or tag name
  url           TEXT NOT NULL,           -- fetched location
  name          TEXT NOT NULL,           -- published entry in the view
  root_id       TEXT,                    -- current published pool root
  commit_id     TEXT,
  ref           TEXT,                    -- resolved full ref
  grant_id      TEXT,                    -- private authority at last acquisition
  refreshed_at  INTEGER,                 -- last successful refresh
  validated_at  INTEGER,                 -- last successful authority check of commit_id
  last_error    TEXT,
  last_failed_at INTEGER,
  last_used_at  INTEGER NOT NULL,
  PRIMARY KEY (domain, repository, revision)
);
CREATE TABLE reference_roots (
  id         TEXT PRIMARY KEY NOT NULL,  -- pool identity
  domain     TEXT NOT NULL,
  repository TEXT NOT NULL,
  revision   TEXT NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('staging', 'published', 'superseded')),
  created_at INTEGER NOT NULL
);
