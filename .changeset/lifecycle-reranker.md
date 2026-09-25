---
"@schlessera/brain": minor
---

The heuristic reranker keeps only lifecycle factors (relevance, draft status and recency) and now also applies in `vector` mode, to every non-empty result set, one result included. The title-match boost and the image-asset boost for "visual" queries are gone: fusion now covers term matching. In vector mode the factors multiply a rank-derived score, `1/(60 + rank)`, instead of the raw similarity, so they move a document a few places without re-sorting the list. With `rerank: "none"`, every mode keeps its retrieval order. `rerank`'s signature is unchanged.
