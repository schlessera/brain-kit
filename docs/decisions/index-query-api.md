# The content index has query results, not a public SQL layout

**Maintainer ruling: 2026-09-28, [#343 question 7](https://github.com/schlessera/brain-kit/issues/343#issuecomment-5865990404).**
The design spike is [#540](https://github.com/schlessera/brain-kit/issues/540),
under the [1.0 stability epic](https://github.com/schlessera/brain-kit/issues/56).

## The ruling

Before 1.0, replace supported direct reads of `brain.db` with deliberately
supported query APIs. Core owns SQL and storage compatibility; callers depend
on documented results and behavior. Keep internal schema versions to detect
incompatible indexes. Markdown remains authoritative and the index remains
rebuildable. The ruling neither schedules 1.0 nor freezes a new API immediately.

The existing [direct-SQL contract](../integration-contract.md#braindb-direct-sql-reads)
remains binding until replacements and consumer transitions are implemented.
Recording this ruling does not withdraw its table, column, metadata, read-only
or version promises. The proposed API and complete public-reader inventory are
in [the query design](../plans/index-query-api.md).

The supported replacement API follows [contract versioning](contract-versioning.md):
additions ship in minors; before 1.0, breaks require a prior maintainer ruling,
`breaking`, a break-identifying changeset, `CONTRACT:` and a same-commit contract
update, and ship in minors; from 1.0 breaks require a major. Type compatibility
alone does not excuse changing the documented results or error behavior.

## Why SQL cannot remain the supported interface

Two packages currently own graph SQL. UI-server opens a short-lived read-only
connection (`openBrainDb`, `packages/ui-server/src/db/brain-db.ts:74-96`), interprets graph availability (`getGraphMeta`, `packages/ui-server/src/graph/reader.ts:437-471`) and walks raw links for
interactive neighborhoods (`getNeighborhood`, `packages/ui-server/src/graph/reader.ts:525-540`). Core has its own cluster query (`getClusterGraph`, `packages/core/src/lib/graph/queries.ts:181-204`).
Their defaults and responses differ. A wrapper around one existing helper is
not automatically a behavior-preserving replacement for the other.

Voice extracts terms from tags, titles, paths, link text and markdown content,
then degrades an old schema to empty vocabulary while retaining overrides
(`buildKeyterms`, `packages/ui-server/src/voice/keyterm-builder.ts:390-437`). The pi backend duplicates link walking (`async graph`, `packages/ui-backend-pi/src/brain-access.ts:280-367`). A module hygiene callback
receives a raw database (`HygieneContext`, `packages/core/src/lib/module-types.ts:11-16`); jobs uses it for opportunity metadata (`checkOpportunityStages`, `packages/module-jobs/src/pipeline.ts:151-170`).
These are separate compatibility obligations, not just the five drawn-graph
endpoints. The current cross-package tests deliberately assert both schema
columns (`REQUIRED_COLUMNS`, `tests/brain-db-contract.test.ts:49-62`) and actual consumers against a CLI-produced index
(`ui-server's readers run`, `tests/brain-db-contract.test.ts:201-244`). Those proofs must be replaced with result and runtime coverage,
not deleted to make a schema change pass.

## Ownership and efficient access

The design recommends a concrete core query entry point with materialized
results. UI-server adapts its results to existing HTTP payloads; core does not
import the UI protocol. No storage-provider interface, callback accepting SQL,
daemon or per-query subprocess is added. The current per-request open/close
pattern is retained, with an internal read transaction covering each complete
operation. An operation may finish on the old index snapshot; the next one must
open the replacement. No database handle or live statement escapes a result.

The current dependency table excludes a ui-server-to-core edge (`"@schlessera/brain-ui-server"`, `tests/allowed-edges.ts:81-84`).
An optional, lazily resolved core peer is the recommendation, **not an approved
edge change**. The decision task must settle that edge and the supported
replacement for `HygieneContext.db` before dependent implementation. The
package-export work (#534) and module-authoring work (#537) must consume that
boundary. An unresolved choice remains visible in GitHub; it does not suspend
independent core API design or authorize implementation by implication.

## Conditions for retiring the SQL promise

Retirement is one explicit pre-1.0 breaking-contract change, after the API ships,
all inventoried public consumers move, raw supported database exposure is
reconciled, package-consumer checks pass, and real-index result, skew and
replacement tests protect the replacements. Migration documentation explains
how a direct reader moves and that arbitrary external SQL is thereafter
unsupported. Only then may the SQL guarantee and its obsolete table-shape
assertions be replaced. Keep internal schema and compatibility tests.

Internal does not mean accepting unknown database layouts: validate metadata
and the structures needed by each feature, reject unsupported newer layouts,
and distinguish missing/corrupt/unavailable from an empty valid result. Do not
migrate or recreate a database during a query. A version identifier returned by
an existing supported HTTP payload remains a diagnostic field with its existing
contract; internalizing SQL does not remove that field. Callers must not use it
to reproduce core's SQL compatibility policy.

## Alternatives

- **Freeze table layouts.** Rejected by the maintainer: it exposes both storage
  layout and query results, making harmless internal changes public breaks.
- **Withdraw SQL guarantees immediately.** Rejected: graph, voice, pi and module
  consumers would retain the same SQL without a dependable replacement.
- **Shell out for every graph interaction.** Rejected for the design: existing
  neighborhood/discovery work is explicitly interactive and in-process. Measure
  actual route latency; a design document is not a performance receipt.
- **Introduce a query service or storage seam.** Rejected: no second storage
  implementation or daemon is required. The dependency choice can be made
  explicitly without a new extensibility boundary.
- **Expose raw handles behind a new name.** Rejected as a public replacement:
  callers would still own SQL and handle lifetime. Unavoidable first-party
  implementation helpers belong in explicitly unsupported internal entries
  under #534, with version/feature checks owned by core.
