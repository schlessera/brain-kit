---
"@schlessera/brain": patch
---

An index run no longer loads and hashes every chunk to prune a chunk-context cache that does not exist (#4782). Pruning now reads `.brain-cache/contexts.jsonl` first: when the file is missing or holds no entry, no chunk is read; otherwise chunks are streamed and only the cache's own keys are held in memory. Which lines a run removes is unchanged, and the legacy cache migration and the refusal of a linked `.brain-cache` still run first.
