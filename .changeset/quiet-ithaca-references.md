---
"@schlessera/brain-ui-server": patch
---
Compute retained journal hashes once when a turn ends, avoiding a reference-by-change scan while other workers are held.
