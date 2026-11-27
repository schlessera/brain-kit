---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
---

The Claude backend's pinned session request shape is now read and written through the prompt-context store's own accessor instead of a second private reader and writer (#4826). The two keys and their bytes on disk are unchanged. A refusal now carries the store's message: a missing or append-less context says it has no retained append, an aliased directory says "Session prompt storage must not contain directory aliases", and an oversized file says "Invalid session prompt storage file".
