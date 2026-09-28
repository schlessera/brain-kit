---
"@schlessera/brain": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---

Search can order results by relevance judgment. A new `Reranker` seam (`defineReranker`, `RerankCandidate`, `Ranked`, and `runRerankerContract` in `@schlessera/brain/testing`) has one built-in, `jev`: one TypeSafe System One Choice over the candidates per search, with each candidate's title, type, tags, summary, matched excerpt and lifecycle fields (status, relevance, updated) as evidence. It is the default rerank mode when `TYPESAFE_API_KEY` is set; without the key, search keeps the `heuristic` ordering. Measured with `brain eval` on a 1,133-document brain, hybrid hit@1 went from 0.407 (heuristic) and 0.556 (none) to 0.741 on 27 hand-written queries.

`rerank` accepts `none | heuristic | jev` on `brain search`, `brain eval`, the MCP `brain_search` tool and `BRAIN_RERANK_MODE`. `heuristic` and `none` keep their meaning. The MCP input's default of `heuristic` is gone: an omitted `rerank` now follows the brain's `reranker.provider`. `jev` does not apply the lifecycle multipliers after its order. Applied there, they undid most of its gain.

A new `reranker` config block sets `provider`, `model` (pinned to `jev-1.13.0`), `apiKeyEnv`, `exclude` (paths never sent, which keep their retrieval rank), `timeoutMs`, `depth` and an opt-in `skipMargin`. A reranker that fails, times out, or returns anything but a permutation leaves the retrieval order and says so in `warnings`. `brain search --rerank-dry-run` prints the outbound request and sends nothing. `brain eval` records `meta.reranker` and refuses a `--rerank jev` it cannot run. `brain doctor` gains a `reranker` check. `TYPESAFE_API_KEY` is forwarded to brain subprocesses and cron jobs.

The helpers a search fanning out over several sources needs to rerank the union are exported: `partitionForRerank`, `mergeWithheld`, `assertPermutation`, `buildPathMatcher`, `candidateKey`, `selectReranker` and `rerankSetup`.
