---
"@schlessera/brain": minor
"@schlessera/brain-module-jobs": minor
---

The job pipeline now lives in frontmatter. An opportunity's `status.md` records `stage` (`researching` to `offer`, or `closed`), `fit`, `applied`, `next_step` (with its date in `deadline`) and `closed_reason`.
- `brain jobs scaffold` writes `stage: researching`, `tags: [job-search]` and the research-opportunity section set.
- The `research-opportunity` and `interview-scheduled` skills set these fields instead of editing prose and the index table.
- New `brain jobs pipeline` gives the opportunities' `_index.md` a registry spec, with an Active and a Closed table by `stage`, and regenerates it. From then on `brain registry` and `brain maintain` keep it current.
- Two `jobs-stage` audit checks flag an opportunity without a stage and one still researching after 60 days.
- A registry `split` can now be `{ key, tables: { Label: [values] } }`, one table per label.
- `runRegistry` and `registrySpecSchema` are exported from `@schlessera/brain`.
