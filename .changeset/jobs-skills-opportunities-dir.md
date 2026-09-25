---
"@schlessera/brain-module-jobs": patch
---

The `research-opportunity` and `interview-scheduled` skills now resolve the opportunity directory before writing, as `brain jobs scaffold` does: `taxonomy.types.opportunity.dir` from `brain config check --json`, else the module's `opportunitiesDir` from `brain config get`. They stop when the config is invalid or the module is not enabled, and every path they name goes through the resolved directory. A brain that moved its opportunities with `opportunitiesDir` no longer gets new files in `career/opportunities`.
