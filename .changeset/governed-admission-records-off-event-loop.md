---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits a governed turn's admission records (the policy it was admitted under, provider exposures, masked lineage and its protected-path manifest) on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). Admission still waits for each record before the turn goes on.
