# Embedding eligibility belongs to the document type

**2026-09-30.** The [maintainer's ruling on #429](https://github.com/schlessera/brain-kit/issues/429#issuecomment-5906802435)
lets a type remain in keyword search while opting out of chunk-context
generation and vectors. It also approves changing the existing nullable
`health.embeddingCoverage` value to measure eligible chunks before 1.0,
under the [contract versioning policy](contract-versioning.md).

## One boolean, evaluated from the current taxonomy

`TypeSpec.embed` is an optional, runtime-validated boolean. `false` opts out;
`true` and an absent effective value opt in. Leaving the field optional lets
an omitted value in a later configuration layer preserve an earlier type
policy. The default applies when no layer sets it
(`embedsType`, `packages/core/src/lib/embedding-policy.ts:4-6`).

This is a vector policy, not a content exclusion. Documents, chunks, FTS,
links, audit findings and ordinary inventory counts remain. Markdown and
image/PDF vectors use the same policy. Asset descriptions can still enrich
FTS according to the existing asset-description configuration; suppressing
those descriptions would change keyword search as a side effect.

Eligibility is checked before chunk-context generation, embedding-provider
selection, cache lookup and carried-vector reuse. A persisted context or
cached embedding cannot make an opted-out type eligible again. Caches need
not be purged: they are derived accelerators, not policy state. Vector writes
also recheck the stored document's type after asynchronous provider work,
so a document retyped during that work cannot receive a newly forbidden
vector.

## Configuration changes take effect without file edits

Switching a type to `embed: false` removes its stored vectors on the next
ordinary index, including unchanged files and a run without embeddings.
The indexer loads an existing vector store without migrating its width to
perform this reconciliation
(`dropIneligibleVectors`, `packages/core/src/lib/indexer/vectors.ts:118-130`).
The Markdown files remain the source of truth; the current configuration
determines how their disposable index is rebuilt.

Switching back to `true` makes existing chunks eligible for the next
embedding-enabled index. An ordinary index does not generate vectors.
Retained contexts and caches may be reused only after eligibility passes.
This gives both directions a predictable effect without requiring a force
rebuild or touching every document's bytes.

## Coverage measures work that the policy asks for

Coverage is eligible chunks with a vector divided by eligible chunks. Both
counts use the current taxonomy. Stale vectors for an opted-out type count
toward the total vector inventory but cannot inflate coverage. The total
`chunks` and `embeddings` fields retain their inventory meanings
(`embeddingEligibilitySql`, `packages/core/src/lib/embedding-policy.ts:9-15`).

Zero eligible chunks means `null`, not zero, one, or a division result. An
unreadable vector store remains unknown. A keyless brain without embeddings
keeps its existing unmeasured semantics. A null value does not trigger the
coverage-floor warning
(`const embeddingCoverage =`, `packages/core/src/lib/stats.ts:287-290`).

This changes the meaning of the existing ratio without adding a second
ratio or changing its JSON shape. Consumers use that supplied nullable value
and describe its denominator as eligible chunks; they cannot reconstruct it
from the total inventory counts. Opting out can improve coverage without
creating a vector. Historical stats snapshots preserve their recorded values;
they are not recomputed under later configuration. The migration note lives
in the [integration contract](../integration-contract/cli.md#embedding-eligibility-and-coverage-semantics).

## Alternatives rejected

- **Path rules or partial embedding within a type.** The approved boundary is
  the document type. Additional policy languages would introduce precedence
  and validation questions without an approved use case.
- **Removing opted-out documents from indexing.** That would lose the keyword,
  link and audit uses which make the opt-out useful.
- **Keeping total chunks as the denominator.** A deliberately excluded type
  would create a coverage warning which generating more allowed vectors
  cannot resolve.
- **Adding a second coverage ratio.** Two measures of coverage would leave
  consumers choosing between incompatible denominators. The ruling changes
  the existing value and documents the migration instead.
- **Purging all caches or regenerating all assets.** Applying eligibility
  before reuse prevents forbidden vectors without discarding derived work
  for eligible content or paying for unchanged asset descriptions again.

The runtime evidence uses real temporary SQLite/FTS/vector stores with
recording, keyless completion and embedding providers. It covers unchanged
file toggles, repeated force rebuilds with populated caches, multimodal and
text-fallback assets, concurrent retyping, mixed coverage and unmeasured
states. Removing selection or reconciliation produces provider calls or
stored vectors for opted-out content; using total counts produces a wrong
ratio. These behavioural mutations protect the boundaries above.
