---
"@schlessera/brain-backend-pi": patch
---

Route Pi SDK agent state to each worker's existing bounded private directory before initialization, preserving read-only HOME, copied credentials and session resume.

Reuse stable prepared global npm resources read-only instead of reinstalling them for each turn. Missing or mismatched configured packages report a setup error while parent settings and credentials remain private.
