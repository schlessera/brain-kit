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
or version promises. The [shipped API specification](../content-index-queries.md)
defines supported results; [the consumer-migration design](../plans/index-query-api.md) retains the
public-reader inventory and approved package/context boundaries.

The supported replacement API follows [contract versioning](contract-versioning.md):
additions ship in minors; before 1.0, breaks require a prior maintainer ruling,
`breaking`, a break-identifying changeset, `CONTRACT:` and a same-commit contract
update, and ship in minors; from 1.0 breaks require a major. Type compatibility
alone does not excuse changing the documented results or error behavior.

## Why SQL cannot remain the supported interface

Two packages currently own graph SQL. UI-server opens a short-lived read-only
connection (`openBrainDb`, `packages/ui-server/src/db/brain-db.ts:74-96`), interprets graph availability ([pre-migration `getGraphMeta`](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/ui-server/src/graph/reader.ts#L437-L471)) and walks raw links for
interactive neighborhoods ([pre-migration `getNeighborhood`](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/ui-server/src/graph/reader.ts#L525-L540)). Core has its own cluster query (`getClusterGraph`, `packages/core/src/lib/graph/queries.ts:181-204`).
Their defaults and responses differ. A wrapper around one existing helper is
not automatically a behavior-preserving replacement for the other.

Voice extracts terms from tags, titles, paths, link text and markdown content,
then degrades an old schema to empty vocabulary while retaining overrides
([pre-migration `buildKeyterms`](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/ui-server/src/voice/keyterm-builder.ts#L390-L437)). The audited pi backend duplicated link walking in its [native-handle graph implementation](https://github.com/schlessera/brain-kit/blob/fe5c75162882cd1f67af2cb808de37094ebea38d/packages/ui-backend-pi/src/brain-access.ts#L280-L367). A module hygiene callback
received a raw database ([pre-#699 hygiene context](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/core/src/lib/module-types.ts#L12-L17)); jobs used it for opportunity metadata ([pre-#699 opportunity query](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/module-jobs/src/pipeline.ts#L151-L170)).
These are separate compatibility obligations, not just the five drawn-graph
endpoints. The current cross-package tests deliberately assert both schema
columns (`REQUIRED_COLUMNS`, `tests/brain-db-contract.test.ts:59-72`) and actual consumers against a CLI-produced index
(`ui-server's readers run`, `tests/brain-db-contract.test.ts:211-254`). Those proofs must be replaced with result and runtime coverage,
not deleted to make a schema change pass.

> **2026-10-01 — Implementation context (pi reader audit above).** Pi's graph
> and listing now use the supported [query results](../content-index-queries.md).
> The linked native-handle implementation is historical. Search/context and
> write helpers use the explicitly unsupported core `/internal` entry; #534
> owns ordinary-export removal. Tool permissions and write locks retain their
> existing ownership, and the direct-SQL promise still binds.

## Ownership and efficient access

The design recommends a concrete core query entry point with materialized
results. UI-server adapts its results to existing HTTP payloads; core does not
import the UI protocol. No storage-provider interface, callback accepting SQL,
daemon or per-query subprocess is added. The current per-request open/close
pattern is retained, with an internal read transaction covering each complete
operation. An operation may finish on the old index snapshot; the next one must
open the replacement. No database handle or live statement escapes a result.

### Historical package/context recommendation

> **2026-10-03 — Superseded recommendation (the paragraph below).** The
> package/context choice was unresolved in the original design. Both branches
> are now selected by the dated rulings below; this paragraph preserves the
> pre-ruling context, not a current prerequisite or an unapproved edge.
>
> The current dependency table excludes a ui-server-to-core edge ([pre-migration `"@schlessera/brain-ui-server"`](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/tests/allowed-edges.ts#L92-L95)).
> An optional, lazily resolved core peer is the recommendation, **not an approved
> edge change**. The decision task must settle that edge and the supported
> replacement for `HygieneContext.db` before dependent implementation. The
> package-export work (#534) and module-authoring work (#537) must consume that
> boundary. An unresolved choice remains visible in GitHub; it does not suspend
> independent core API design or authorize implementation by implication.

## Package access — lazy optional core peer, 2026-10-03

The maintainer selected **A, a lazy optional core peer**, in
[#696's package ruling](https://github.com/schlessera/brain-kit/issues/696#issuecomment-5967816497),
following [the package comparison](https://github.com/schlessera/brain-kit/issues/696#issuecomment-5961235586).
UI-server consumes the supported `@schlessera/brain/queries` entry of
`@schlessera/brain`, with both a `peerDependencies` entry and
`peerDependenciesMeta` marking it optional. Hosts explicitly install compatible
core for graph and index-derived vocabulary; unrelated standalone features boot
without it. Normal conditional exports resolve source, default JS and declarations
from one build (`"./queries"`, `packages/core/package.json:50-54`).

Resolve/cache functions lazily once per app; core owns short-lived native
connections and snapshots per operation. The one-way server-to-core edge is
approved, with no core-to-UI protocol dependency. At the inspected baseline,
server has no core dependency/peer ([pre-migration `"dependencies"`](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/ui-server/package.json#L56-L69);
[pre-migration `"peerDependencies"`](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/ui-server/package.json#L70-L74)) and the allowed
edge row still excludes it ([pre-migration `"@schlessera/brain-ui-server"`](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/tests/allowed-edges.ts#L92-L95)).
#697 implements that migration; approval and this record do not constitute
manifest, packed-install or route-runtime proof.

Check the actual imported package/subpath identity, a documented compatible
range derived from releases shipping the required operations, and those
operations before use. #697 must establish that concrete source-backed range
and verify packed resolution; this ruling chooses no numerical range. Never
substitute a separate PATH CLI, handwritten SQL or a per-query subprocess.
Distinguish absent/skewed/unusable core from index absence/skew returned by a
usable API. Unusable core means sanitized unavailable graph capability and
unavailable/degraded index vocabulary, retaining pronunciation overrides,
providers independent of keyterms and unrelated startup. Degradation is not
persisted as successful vocabulary. With usable core, preserve established
index-specific graph meta/subgraph status/payload mappings and voice
missing-index/old-schema behavior. A failed capability is not a valid empty graph.

The rejected **hard core dependency** would simplify automatic installation
and package resolution, but install/couple core for every server consumer,
including those using neither feature. The optional peer leaves compatible
installation with the host, at the cost of explicit migration, standalone
absence/type checks and more skew handling. Both were viable concrete edges;
neither justified a service or configurable query-provider seam.

> **2026-10-05 — Implementation context (#697).** UI-server now declares the
> optional peer and resolves the entry lazily, once per app
> (`createCoreQueryAccess`, `packages/ui-server/src/core-queries.ts:187-220`). The
> source-backed range is `>=0.40.0 <1.0.0`: the published 0.40.0 manifest is the
> first to export `./queries`, its declarations name all nine operations and its
> query source matches the source the server was migrated against; 0.39.0 has no
> entry. Graph and voice routes keep their mappings as recorded in the
> [integration contract](../integration-contract.md#ui-server-optional-core-peer-breaking-host-migration-697).
> The UI-server citations in this record that predate the migration link the
> pre-migration commit; a frozen copy of those readers under
> `tests/helpers/legacy-ui/` remains the parity and measurement baseline until
> #701. The direct-SQL promise still binds.

## Module context — root-bound queries and db removal, 2026-10-03

The maintainer selected **A, core-supplied root-bound `ctx.queries`**, and
approved raw-db removal in
[#696's context ruling](https://github.com/schlessera/brain-kit/issues/696#issuecomment-5969048668),
following [the context comparison](https://github.com/schlessera/brain-kit/issues/696#issuecomment-5967927247).
Retain `HygieneContext<C>.root` and parsed `config: C`; replace `db` with a
concrete query object constructed by core. Its nine methods are
`readGraphMeta`, `readGraphClusters`, `readGraphNeighborhood`, `readGraphDiscovery`,
`readGraphMaintenance`, `readLinkWalk`, `readVoiceVocabulary`, `listIndexDocuments`
and `findIndexDocuments`. They retain the supported options/results with only
caller `brainPath` omitted; the [design's method/type inventory](../plans/index-query-api.md#supported-operations-and-reachable-types)
is defined against the [shipped specification](../content-index-queries.md).

The captured root is authoritative at runtime, including JavaScript/unsafe
options and later context-root mutation. Each operation retains its own
core-owned read snapshot/native lifetime. There is no persistent handle,
transaction spanning callbacks, consumer-supplied provider, SQL callback or
prepare/execute escape. Keep awaited sync/async callback execution and existing
failed-check reporting (`const found = await check`, `packages/core/src/lib/auditor.ts:1062-1075`).
Typed failure remains distinct from an empty valid result or successful check.
The current raw context stays in source until #699 migrates every callback,
fixture and author guide together; the ruling approves removal in that change,
without an indefinite deprecated raw-db escape.

Jobs keeps complete deterministic non-archived opportunity metadata selection,
null-status exclusion and path ordering. Its former predicate is exact root
`status.md` equality plus nested `%/status.md` matching with ASCII case behavior
(the pre-#699 opportunity query linked above).
Root uppercase and near-names are excluded; nested `STATUS.MD`/`Status.Md`
remain included. Use complete `findIndexDocuments` metadata plus the
module-owned path predicate, not capped listing or a case-sensitive literal
suffix that loses candidates. Source frontmatter, stages, taxonomy, parsed
config/root and the separate jobs operational database retain their ownership.

> **2026-10-05 — Implemented by #699.** The context now carries
> `queries: ContentIndexQueries` instead of `db`
> (`HygieneContext`, `packages/core/src/lib/module-types.ts:14-20`).
> Core binds the resolved root once per audit and freezes the object
> (`bindContentIndexQueries`, `packages/core/src/queries/bound.ts:37-61`).
> Jobs filters the complete `findIndexDocuments` set with the former predicate
> and throws on a failed read
> (`checkOpportunityStages`, `packages/module-jobs/src/pipeline.ts:152-191`).
> `tests/module-hygiene-queries.test.ts` runs both through the real loader
> against CLI-produced indexes. The direct-SQL promise still binds until #701.

The rejected **explicit supported query imports** would reuse the standalone
API with a smaller context, but repeat `brainPath: ctx.root` wiring for every
module. Root-bound methods centralize that binding and simplify author calls,
with an additional concrete method/type surface and required runtime binding
proof. Module trust is unchanged; this is no new extension seam.

## Migration and evidence boundaries

#697 owns the approved peer-install migration for existing graph/vocabulary
hosts; #699 owns raw-db removal and the new module calling convention. Before
1.0, both require their prior ruling, `breaking`, `CONTRACT:`, same-commit
integration-contract and host/module-author migration documentation, and a
**minor changeset naming the break**. From 1.0, breaks require majors. Further
unapproved machine behavior breaks need their own ruling. No release date,
package version, publishing or immediate 1.0 freeze is selected.

#534/#537 must consume all signature-reachable query option/result types and
the new context in their public/module-author inventories. Server declarations
remain usable without mandatory optional-core types for independent consumers.
#697/#700 own normal packed install/source/default/types, standalone-declaration,
identity/range/feature skew and actual graph/voice route checks. #699 owns real
loader/CLI-produced-index proof of nonempty complete selection, config/source
ownership, authoritative root binding against unsafe inputs and context mutation,
index-failure reporting and intended behavioral mutation failures. These are
implementation requirements, not satisfied by this record.

The comparison's isolated strict declaration check demonstrated candidate
typing only. Its SQLite path-predicate probe established the former case
semantics, not the bound context/loader runtime. Neither is an installation-size
or latency receipt; measured cold/warm route behavior belongs to #697/#700.
The direct-SQL table/column/version promises stay binding until #701 meets its
separate retirement prerequisites below.

> **2026-10-06 — Cross-package coverage (#700).**
> `tests/index-query-consumers.test.ts` drives the mounted graph and keyterms
> routes, pi's registered `brain_list`/`brain_graph` tools and the jobs hygiene
> check through the real loader against one CLI-produced index. Each consumer
> keeps its documented envelope in eleven index states, one WAL snapshot per
> response, a checkpointed replacement on the next call and closed connections
> after a native failure. `scripts/check-module-query-package.ts` runs the
> packed jobs check in CI beside the existing core, pi and ui-server package
> probes. The column assertions in `tests/brain-db-contract.test.ts` are
> labelled internal and still bind until #701.

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
