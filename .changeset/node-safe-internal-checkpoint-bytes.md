---
"@schlessera/brain-ui-sdk": patch
---

Keep the packed `@schlessera/brain-ui-sdk/internal` entry loadable under Node: `REFERENCE_POOL_CHECKPOINT_BYTES` now comes from the runtime-neutral manager protocol module instead of the reference pool, whose import chain reaches `bun:sqlite`.
