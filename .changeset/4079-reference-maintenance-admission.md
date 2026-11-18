---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
---

A turn's first `reference_source` call is no longer refused by the turn's own maintenance commands (#4079). Every maintenance command reserves the whole default 256 MiB maintenance budget, so a reference Git command that started while the turn's scratch check ran, or a boot-time `brain scratch prune`, was refused at once. The tool then answered the generic `unavailable` with no retry guidance. Now each reference Git command waits up to 30 seconds for the budget to free, and a request still refused after that answers `busy` with "nothing ran, retry" guidance, never `unavailable`. An awaited scratch check waits up to 3 seconds the same way, so a short reference command no longer leaves `.brain/scratch/` read-only for the turn. A longer holder, such as an index, still leaves it read-only after that wait. The synchronous scratch check and the bind-time revalidation of lapsed sources still refuse at once. Neither wait adds an allowance: both stay inside the existing budget.
