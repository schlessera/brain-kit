---
"@schlessera/brain": patch
---

Fixed: vector search silently degrading to FTS-only on a brain whose stored
embedding identity predates provider namespacing.

`index_metadata.embedding_model` is compared against the configured provider's
id. The schema-v3 migration seeds that key with the bare model name from
models.ts (`gemini-embedding-2`) — a guess, not a record of what produced the
vectors — while providers report a namespaced id (`gemini:gemini-embedding-2`).
The two can never compare equal, so `hybridSearch` skipped vector search on
every query and reported "stored vectors were produced by ... run 'brain index
--embeddings' to rebuild them".

The state was self-locking: `brain index --embeddings` read the same mismatch
and refused to re-embed without `--force`, and `--force` bills a full paid
re-embed of the corpus to correct what is only a naming difference.

`embeddingIdentityMatches()` now backs all three comparison sites (search
engine, indexer guard, doctor): exact match, or a bare stored value that equals
the model half of the current id. Two namespaced ids must still match exactly,
so `openai:some-model` is never mistaken for `gemini:some-model`. The indexer
rewrites the metadata to the namespaced form on its next run, so an affected
brain heals itself once — with no re-embedding.
