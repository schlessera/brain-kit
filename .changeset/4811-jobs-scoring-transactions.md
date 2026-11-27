---
"@schlessera/brain-module-jobs": patch
---

Scoring and job deletion are now all or nothing (#4811). `scoreNewJobs` and `rescoreAllJobs` (what the settings form's "Rescore now" runs) apply their updates in one transaction, so a pass that fails part-way leaves every row with its previous score instead of a mix, and they read their candidates in pages of 500 by id instead of loading every job description at once. `deleteJob` removes the search row, the duplicate references and the job in one transaction, so a failure can no longer leave a job that search does not find. Scores on success and every `--json` shape are unchanged.
