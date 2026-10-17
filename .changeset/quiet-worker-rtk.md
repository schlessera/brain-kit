---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Suppress RTK's missing-hook installation warning in Claude workers and Pi bash children, where the host already rewrites shell commands. Preserve command errors and exit status.
