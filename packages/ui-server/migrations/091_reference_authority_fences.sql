-- Invalidation survives separate app/cron owners and precedes publication.
-- Empty revision fences every revision of a repository in this sharing domain.
CREATE TABLE reference_authority_fences (
  domain TEXT NOT NULL,
  repository TEXT NOT NULL,
  revision TEXT NOT NULL,
  generation TEXT NOT NULL,
  PRIMARY KEY (domain, repository, revision)
);
