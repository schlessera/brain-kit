---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-react": patch
---

Report refused Claude worker-state copy-out as `worker_state_save_refused`, preserving actual turn usage, host cancellation and exhaustion precedence. Show an incomplete-save card with scoped Retry and disclose that retry does not recover unsaved transcript or agent memory.
