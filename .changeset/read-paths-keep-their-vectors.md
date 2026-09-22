---
"@schlessera/brain": minor
"@schlessera/brain-backend-pi": patch
---

Reading a brain can no longer destroy its vector index. `initVecSupport` was
both "make vectors readable on this connection" and "migrate the vector
schema", and the migration drops every stored vector — so `brain mcp`, whose
tools all advertise `readOnlyHint: true`, emptied `vec_chunks` on startup
against any brain last indexed before the cosine migration. Recovering meant a
paid `brain index --embeddings --force`.

It is now two functions. `loadVecSupport(db)` is the read path: it loads the
sqlite-vec extension and reports whether `vec_chunks` is there, writing nothing
and taking no width, so a read cannot migrate whatever kind of connection it
holds. `migrateVecSchema(db, dimensions)` is the write path, named for what it
does, and `brain index`, `brain sync`, `brain maintain`, `brain doctor --fix`,
the archiver and the indexer's re-embedding pass still call it.

Two smaller fixes come with the split. Callers that are not about to re-embed
now pass `storedVectorWidth(db, configured)` — the width the index was built
at, from `index_metadata.embedding_dimensions` — instead of the configured
provider's, so a provider swap no longer re-declares the table at a width the
stored vectors are not in. And `sqlite-vec not available` is now printed only
when the extension really failed to load; a read-only connection that could not
write used to report it, sending readers off to reinstall a working dependency.

`initVecSupport` is gone from `@schlessera/brain`'s exports. Out-of-tree callers
that only read vectors want `loadVecSupport`; callers that are about to embed
want `migrateVecSchema`.
