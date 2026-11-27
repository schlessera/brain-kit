---
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Internal: compatibility re-exports left by earlier file splits are removed (#4686). No package entry point exported them and behaviour is unchanged; the SDK's cleanup-reconciler and worker-state ledger tests move to the SDK package.
