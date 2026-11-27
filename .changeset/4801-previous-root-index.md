---
"@schlessera/brain-ui-server": patch
---

Finding a session's previous turn for the cache-prefix comparison reads through partial indexes on root spans instead of walking every Activity span backwards (#4801), which on the first turn of every new chat covered the whole table. A root whose session id is only in its attributes is still found through its own index. The runs with open spans, read on every hourly prune and at boot, use a partial index on unfinished spans. The comparison's result is unchanged.
