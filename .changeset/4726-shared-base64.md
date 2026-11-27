---
"@schlessera/brain-ui-react": patch
---

Internal: the voice clients, push registration, draft uploads and attachment sizing convert between bytes and base64 through one helper module (#4726). The bytes and strings produced are unchanged.
