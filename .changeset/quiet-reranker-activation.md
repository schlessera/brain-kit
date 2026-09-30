---
"@schlessera/brain": minor
---

BREAKING: model search reranking now requires `reranker.enabled: true` in canonical brain config. Omitted or false keeps judgment off even with credentials, a custom provider, `--rerank jev` or `BRAIN_RERANK_MODE=jev`. Add the boolean to retain former credential-triggered ordering; turning it off preserves provider settings. Direct `hybridSearch` injection also requires `rerankerEnabled: true`. Explicit disabled model requests warn and use local heuristic results, while eval refuses to score flag/environment fallback. Dry-run previews remain available while disabled or keyless and send nothing.
