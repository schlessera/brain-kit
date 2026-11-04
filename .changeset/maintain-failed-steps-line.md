---
"@schlessera/brain": patch
---

A failed `brain maintain` now ends stderr with one line that names each failed step and the start of its result, for example `brain maintain: FAILED step(s): git (fatal: …)`. The line holds at most about 1,000 characters. A scheduler that keeps only the end of stderr, such as the hosted cron record with its 2,000-character tail, now shows which step failed even after the steps' own diagnostics have filled that tail. Stdout, the `--json` report and exit codes are unchanged, and a successful run writes no such line.
