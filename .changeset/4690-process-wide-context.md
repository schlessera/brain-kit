---
"@schlessera/brain": patch
---

`@schlessera/brain/internal` no longer exports `getContext` (#4690). `initContext` returns the context and no longer also stores it in module-level state; nothing read that state, and a host that initialises several brains now has no getter that answers with whichever was initialised last. The internal entry carries no compatibility promise; pass the context `initContext` returns instead.
