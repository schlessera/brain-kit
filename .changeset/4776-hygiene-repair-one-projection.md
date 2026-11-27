---
"@schlessera/brain": patch
---

`brain hygiene resolve` and `brain hygiene check` (the repair and check buttons of the hygiene review) build their in-memory projection of the brain once per operation instead of three times, and without the graph precompute that nothing on this path reads (#4776). After a repair writes the document and its receipt, the projection is brought up to date by a targeted index run of those two files, and the detection that passed the post-check is the one the hygiene log is reconciled against; `brain.db` is copied once per operation to read the accepted-edit baselines. Repair outcomes, receipts, tokens and JSON are unchanged. One narrow difference: an edit that another process makes to some other note while the operation runs, from its first index build to the log write, is no longer seen by that operation's post-check; the next detection sees it.
