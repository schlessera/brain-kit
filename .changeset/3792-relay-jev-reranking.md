---
"@schlessera/brain-common": minor
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Hosted search is reranked again. A governed or strict turn worker whose `TYPESAFE_API_KEY` the host withholds now sends the `jev` reranker's request through the host's provider relay, under the new `typesafe` family (`x-brain-provider: typesafe`, `POST /v1/systemone` only). The host adds its key for `https://api.typesafe.ai` and meters each request as operation `reranking`, with an unknown cost rather than zero. `brain search` and `brain_search` in such a worker no longer report `provider_unavailable` and fall back to lifecycle order. A host without the relay keeps that notice, and a credentialed maintenance worker keeps its JeV key as before.
