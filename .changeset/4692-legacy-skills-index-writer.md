---
"@schlessera/brain": patch
---

The legacy "Skills index" writer (`renderIndexBlock`, `readManagedNames`, `upsertIndexBlock`) leaves the package source (#4692). No entry point exported it and `brain skills sync` never called it; the Codex and Gemini emitters keep migrating an existing legacy block exactly as before, using the unchanged marker strings.
