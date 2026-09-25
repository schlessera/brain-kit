---
"@schlessera/brain-module-jobs": patch
---

The `research-opportunity` and `interview-scheduled` skills now look up the opportunity directory with `brain config check --json` (`taxonomy.types.opportunity.dir`) before writing, and every path they name goes through that value. A brain that moved its opportunities with `opportunitiesDir` no longer gets new files in `career/opportunities`.
