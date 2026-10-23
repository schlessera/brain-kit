---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Enforce governance policy provider folders in hosted interactive and voice turns (#1668). No turn has a proven inference recipient yet, so a provider rule denies every turn: each `folder/**` root reads as an empty read-only directory, `.git` is hidden, and `.brain-index/` is a private, writable index the brain's own CLI builds before the turn from the masked view, so it never holds the masked documents. A provider rule that names a document type, a non-literal glob or a single path refuses turn admission by name instead of staying unenforced. `brain index` without `--embeddings` now runs where only `.brain-index/` is writable.
