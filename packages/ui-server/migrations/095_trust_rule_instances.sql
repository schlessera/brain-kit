-- Runtime source-grant lifetimes are projection metadata, never policy grants.
-- Existing streams do not survive migration/restart; seed current instances.
ALTER TABLE trust_settings_projection ADD COLUMN rule_instances TEXT NOT NULL DEFAULT '{}';
UPDATE trust_settings_projection SET rule_instances = (
  SELECT coalesce(json_group_object(json_extract(value, '$.id'), trust_settings_projection.revision), '{}')
  FROM json_each(trust_settings_projection.rules)
);
