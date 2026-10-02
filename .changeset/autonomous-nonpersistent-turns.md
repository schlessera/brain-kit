---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": patch
---

Add explicit nonpersistent autonomous turns and synchronous escalation capture.
Both backends preserve ordinary session behavior while headless attempts keep
runtime identity and usage in Activity without saving interactive history. This
supplies turn plumbing; autonomous dispatch remains gated on containment,
budgets, admission and system verification.
