---
"@schlessera/brain-module-jobs": patch
---

Internal: the jobs module formats a salary range and reads stored tags in one place each (#4717). Output is byte-identical on the pinned runtime, and number grouping is now pinned to `en-US` (including the stored `salary_raw` the Remote OK adapter builds) instead of following the runtime's default locale. One display difference: a stored `tags` value that is not a JSON array of strings, which the module's own writers never produce, no longer prints a `Tags:` line in the review list, detail view or interactive card; the `--json` projection already treated it as an empty list.
