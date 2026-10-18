---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Retain native file observations in host-private session storage so resumed Claude and Pi turns refuse stale writes after a backend restart. Interrupted reads and missing legacy observation records require a genuine reread before writing; fully tracked sessions retain the existing never-read behavior.
