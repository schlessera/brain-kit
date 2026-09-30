# Metadata stays outside chunk embedding prefixes

**2026-09-30.** The [maintainer's ruling on #428](https://github.com/schlessera/brain-kit/issues/428#issuecomment-5906752102)
selected option C: do not prepend type, status, tags, updated or deadline to
every chunk's embedding text. Keep independently editable metadata in the
existing search paths. This preserves the current representation; it adds
no configuration option or runtime behavior.

## Embedding input follows the chunk's text

A Markdown chunk is embedded as `[title] [heading]`, a newline, its optional
context and then its content. Title, heading and context remain part of the
input; the ruling does not remove them
(`chunkTextForEmbedding`, `packages/core/src/lib/chunker.ts:449-456`).

Incremental indexing matches old chunks by title, heading and content,
retaining their context and vector when they match
(`const reusable =`, `packages/core/src/lib/indexer/persist.ts:215-225`).
For a force rebuild, carried-vector reuse hashes the exact formatted input,
including context, and applies only within the matching provider and
dimensions
(`embeddingTextKey`, `packages/core/src/lib/indexer/vectors.ts:57-59`),
(`carryMarkdownVectors`, `packages/core/src/lib/indexer/vectors.ts:73-97`).

A metadata prefix would make a routine status, tag or date edit change the
embedding input of every chunk in the document. Reusing those old vectors
would then misrepresent their input; regenerating them would turn an
otherwise unchanged document into paid embedding work. Keeping these fields
separate avoids that coupling. This is an invalidation and maintenance
tradeoff, not a measured claim that prefixes cannot improve retrieval.

## Metadata already has search paths

Type, status, tag, update-date and deadline filters operate on stored
document fields
(`buildFilters`, `packages/core/src/lib/search-engine.ts:128-175`).
The document-level keyword lane searches title, summary, tags and aliases
with BM25 weights, alongside the separate chunk lane
(`const byDocument =`, `packages/core/src/lib/search-engine.ts:432-443`).
When enabled, the judgment reranker receives type and tags as candidate
fields, and status, relevance and updated as lifecycle attributes
(`toRerankCandidate`, `packages/core/src/lib/search-engine.ts:1130-1142`),
(`lifecycleAttributes`, `packages/core/src/lib/search-engine.ts:1145-1151`).
These paths can use current metadata without serializing it into every
chunk's vector input. Stored vector filter columns are also synchronized
with type and archived status
(`syncVectorFilters`, `packages/core/src/lib/indexer/vectors.ts:142-159`).

The decision does not strip metadata words from prose or context. Uncached
context falls back to the frontmatter summary for a single-chunk document
or a run without enrichment, and generated context can also use the summary
(`generateChunkContexts`, `packages/core/src/lib/indexer/contexts.ts:36-87`).
It does not promise that every metadata edit leaves context or vector
eligibility unchanged; [type eligibility](embedding-eligibility.md) remains
a separate policy.

## Rejected alternatives and reconsideration

Both an all-fields prefix and a smaller prefix of selected metadata fields
introduce the same coupling for whichever fields they contain. Removing the
existing title, heading or context would instead change the established
representation, and stripping matching words from content would change what
the document says. Neither is part of this ruling.

Reconsider a prefix only with new evidence of a retrieval problem that
filters, keyword retrieval and ranking do not adequately address. A proposed
change must show its retrieval benefit alongside document-wide invalidation
and embedding cost, and obtain a new maintainer ruling. #428 authorizes no
paid experiment or full re-embed.
