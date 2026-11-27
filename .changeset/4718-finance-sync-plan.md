---
"@schlessera/brain-module-finance": patch
---

Internal: `brain finance sync` and the ledger hygiene check now read one plan of the files sync would rewrite, instead of two copies of the same loop, so they cannot disagree about which files are stale (#4718). The only observable difference: every file's next content is computed before the first write, so a ledger whose generated-region markers are malformed now stops the sync before any file is written, where earlier ledgers used to be rewritten first.
