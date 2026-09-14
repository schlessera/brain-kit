---
"@schlessera/brain": patch
---

Make embedding runs safe to repeat and cheap to interrupt. Only one
`index --embeddings` run can operate on a database at a time — a second exits
with a retry message before making paid calls — and the lock releases itself if
the process crashes. Markdown backfills are paged rather than loaded whole, so a
large corpus no longer holds every pending chunk in memory, and a changed
embedding dimension is detected instead of writing vectors nothing can read.
