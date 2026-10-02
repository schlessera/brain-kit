---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Add authenticated `brain queue add` intake with explicit replay keys and scoped
principal-cookie transport. Shares now create durable untrusted triage work,
deduplicate normalized content, preserve server-owned provenance, and reconcile
failed staging/database writes. Queueing does not file content or enable
autonomous execution.
