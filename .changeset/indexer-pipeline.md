---
"@schlessera/brain": minor
---

Restructure the indexer as an explicit pipeline.

`indexAll` was a single ~990-line function inside a 1,495-line module, with
its eight phases marked only by comment banners and `quiet` re-checked at 24
call sites. It is now a pipeline of phases under `lib/indexer/`, each in its
own module with a stated input and output, composed by a `run.ts` that reads
top to bottom: scan → parse → persist → vector hygiene → assets → embeddings →
caches → graph. Shared state travels in one `IndexRun` context that also
carries `report`/`warn`, so no phase re-derives whether it may log.

Behaviour is unchanged and the public surface is identical — `indexAll`,
`getMarkdownFiles`, `getAssetFiles`, `extractWikiLinks`, `resolveWikiLink` and
`chunkContextKey` all still come from `lib/indexer`. The split did remove one
piece of dead code (`deletedDocIds`, collected on every run and never read) and
gained a regression test for a rule the old shape made easy to break: a run
that refuses to embed because the embedding provider changed must still write
the asset descriptions it just paid for to the sidecar cache.
