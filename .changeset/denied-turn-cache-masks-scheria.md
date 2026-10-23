---
"@schlessera/brain-ui-sdk": minor
---

Denied turns no longer read the committed generated-text caches (#2692). In a hosted or autonomous turn under a provider folder rule, `.context-cache.jsonl` and `.asset-cache.jsonl` read as empty, so cached chunk contexts and asset descriptions of masked documents stay hidden. A cache that is a link or has a second name refuses the launch.
