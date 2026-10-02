---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Reject unknown fields at the block and item levels of new `show_block` suggestions calls, including unsupported item `tone`, in both Claude and pi. This is a breaking accepted-input tightening shipped as a pre-1.0 minor. Stored and replayed suggestions still discard unknown fields and render when otherwise valid; malformed payloads keep the generic fallback. Other block kinds retain their existing behavior.
