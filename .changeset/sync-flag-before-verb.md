---
"@schlessera/brain": patch
---

`brain sync --json assess` and `brain sync --human` now work. `brain sync` picked the first argument as its verb before looking at flags, so an output-mode flag written before the verb failed with `Unknown sync verb: --json`, and `brain sync --json` never reached the coding agent.
