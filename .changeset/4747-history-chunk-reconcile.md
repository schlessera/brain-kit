---
"@schlessera/brain-ui-react": patch
---

A history replay's continuation chunk reconciles only its own messages (#4747), plus the live answer the previous chunk held back as its tail, instead of reconciling the whole replay again. Messages an earlier chunk reconciled keep their objects and ids, so the drawn transcript no longer re-renders once per chunk. The transcript after a replay is the same.
