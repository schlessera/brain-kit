---
"@schlessera/brain-backend-claude": patch
---

Restore the Claude package's Node import by loading Bun FFI only when its native inference guard is selected, while retaining fail-closed native input checks.
