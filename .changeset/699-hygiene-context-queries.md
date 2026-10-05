---
"@schlessera/brain": minor
"@schlessera/brain-module-jobs": minor
---

Breaking: module hygiene checks no longer receive a raw `ctx.db` connection to `brain.db`. `HygieneContext` is now `{ queries, root, config }`, where `queries` is a frozen `ContentIndexQueries` object core binds to the brain root: the nine `@schlessera/brain/queries` operations, called with the same options minus `brainPath`. A check that read SQL must call the matching query and throw on `ok: false`; the audit reports that as a failed `module-hygiene` check. The jobs `jobs-stage` check now uses `findIndexDocuments`, with the same selection, and fails visibly when the index is missing or incompatible instead of reading SQL.
