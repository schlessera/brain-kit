---
"@schlessera/brain": minor
---

A top-level `evals/` directory is no longer indexed. It holds a retrieval query set and its results, and search must not see them: a note that quotes the queries answers them and makes the eval grade itself. Every `isExcludedPath` caller (index, stats, MCP listing, OKF export) agrees on the exclusion. `brain eval` now also checks indexed documents before scoring. A document containing one of the set's queries of four or more words, or three of its queries of any length, is named in `warnings`, and `--strict` makes that a refusal (exit 2).
