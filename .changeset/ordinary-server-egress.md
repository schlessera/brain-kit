---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": patch
---

Add a typed per-turn egress connection event and an internal proxy recorder with durable connection/refusal facts and cancellation when recording fails. Ordinary backend activation remains unchanged.

Honor valid zero-byte egress budgets by refusing before credential release or upstream contact.
