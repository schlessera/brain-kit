---
"@schlessera/brain": patch
---

`brain eval` now ranks with the brain's own taxonomy, as `brain search` does. The reranker takes its recency half-lives from the brain's configured types, and eval had been falling back to the core defaults, so it could score an ordering that search never returns. On the fixture corpus two queries move from rank 2 to rank 1.
