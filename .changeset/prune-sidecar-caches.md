---
"@schlessera/brain": patch
---

Prune sidecar cache entries nothing can reach any more

`.asset-cache.jsonl` and `.context-cache.jsonl` are tracked, so a deleted asset
left its generated description in the repo indefinitely: the caches are keyed by
content, and deleting a file makes its entry unreachable rather than removing
it. `saveAssetCache`/`saveContextCache` rebuild from the database and would
clear it, but they only run on an `--embeddings` pass — deliberately, since they
exclude placeholder rows and rebuilding on a keyless machine would empty the
cache for everyone.

Pruning by reachability is safe where rebuilding is not: it asks only whether a
key still corresponds to something in the index, which holds regardless of
whether this machine can generate descriptions. It now runs on every `brain
index`, and writes only when something was actually removed, so a no-op run
still produces no git diff — the property `content-hygiene` depends on.

Malformed lines are left alone rather than discarded. Pruning found five stale
entries in the reference brain on its first run.
