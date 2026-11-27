---
"@schlessera/brain": patch
---

Internal (#4708): the default embedding model and width, and the other default model identifiers, are declared once, in `llm-defaults.ts`; the duplicate `models.ts` is gone, so the index schema and the embedder can no longer read different values. No identifier, width or export changes.
