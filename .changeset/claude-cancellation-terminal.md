---
"@schlessera/brain-backend-claude": patch
---

Preserve accepted host cancellation when Claude releases a delayed SDK result. Cancelled terminals retain reported usage, clear error-only details, and wait for worker cleanup before emission.
