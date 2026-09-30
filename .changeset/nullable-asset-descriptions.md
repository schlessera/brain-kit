---
"@schlessera/brain": minor
---

BREAKING: `Enrichment.describeAsset` now returns `Promise<string | null>`.
No vision capability or empty/whitespace completion output returns `null`
instead of an asset title; callers must handle `null`, and custom enrichment
implementations should return it when no description was produced. The shipped
completion contract suite now asserts these results and zero calls for no vision.

Undescribed images and PDFs keep searchable placeholders, stay out of description
caches and embeddings, and retry on later indexing runs without file changes.
Real non-empty descriptions may equal the title. Historical cache strings remain
untouched; regenerate a known bad entry with `brain index --forget-cache <path>`
followed by `brain index --embeddings` to reset both sidecar and database state.
