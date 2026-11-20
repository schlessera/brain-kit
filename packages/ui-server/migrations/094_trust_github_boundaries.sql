-- Current approved-owner evidence, derived only from a proved Settings
-- publication. It is never a second source of policy or runtime permission.
CREATE TABLE trust_settings_github_boundaries (
  brain_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  selector TEXT NOT NULL,
  identity TEXT NOT NULL,
  proof TEXT NOT NULL,
  PRIMARY KEY (brain_id, rule_id)
);
