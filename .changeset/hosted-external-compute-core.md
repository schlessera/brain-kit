---
"@schlessera/brain": minor
---

Report external compute as data and let a host admit jobs for its callers (#3108). `brain config check --json` gains a `compute` summary: each instance's built-in provider, credential variable name, options and limits, and a provider passed as a value by its id only, so a hosting server can use the configuration without running it. The first-party `/internal` entry exports the compute operation set and driver, and the operation set accepts a hosted mode that admits with the host's frozen data-to-provider rules, approval and budget ledger, plus a recheck of the caller's authority under the admission lock.
