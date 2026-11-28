---
"@schlessera/brain": patch
---

A hygiene repair preview, a repair and `brain hygiene check` no longer prune `.brain-cache/contexts.jsonl` and `.brain-cache/assets.jsonl` (#4875). The repair path builds a private in-memory index of the brain, and that index run used to prune the tracked caches like `brain index` does. A preview could therefore rewrite a tracked file, although it promises to change no source file or sidecar. The projection's index runs now pass the new internal `IndexOptions.pruneCaches: false`. `brain index` still prunes the same entries.
