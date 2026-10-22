---
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-sdk": patch
---

Keep host GitHub credentials, including the skills installer token, out of maintenance and agent workers. Share the credential names across environment boundaries while preserving the mirror transport and skills installer's dedicated tokens and generic fallback.
