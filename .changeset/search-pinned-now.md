---
"@schlessera/brain": minor
---

`hybridSearch` accepts a `now` option (`SearchOptions.now`), and `rerank` accepts one in its config (`RerankerConfig.now`). The heuristic reranker measures recency from that moment instead of the wall clock, so a ranking assertion or an eval run can be pinned to a date. Omitting it keeps today's behaviour. An invalid `Date` throws instead of scoring every result as `NaN`. The CLI and MCP shapes do not change.
