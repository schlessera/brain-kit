# Supported content-index query APIs

Consumer-migration design from [#540](https://github.com/schlessera/brain-kit/issues/540),
reconciled by [#911](https://github.com/schlessera/brain-kit/issues/911) with
[the approved SQL, package and context boundaries](../decisions/index-query-api.md).
The standalone [query API specification](../content-index-queries.md) describes
shipped operations; the server peer and bound module context below describe
approved migrations, not shipped implementations. GitHub holds open work;
this document carries no work status. The current
[SQL guarantees](../integration-contract.md#braindb-direct-sql-reads) still bind.

## Public-reader inventory — source audit 2026-09-30

The audited brain-kit base is `b5e06d6170e75f6dee50ea44f63b0c89d626e3b6`.
The audit searched database imports/opens, `brain.db` references, SQL calls and
injected `ctx.db` uses throughout package source, then traced each connection.

| Reader or owner | Required reads/results | Compatibility and latency needs |
| --- | --- | --- |
| UI graph reader | `documents` identity/path/title/type/asset type/updated/indexed time; resolved `links`; metrics, communities, distances, layouts; graph provenance. Meta, clusters, neighborhoods, discovery and maintenance. | In-process interactive BFS; current caps/defaults and HTTP shapes; distinguish unavailable, stale and empty. |
| UI voice keyterm builder | Tag names; selected titles; curated path prefixes; distinct unresolved/raw link text; all markdown title/content/type. | Same ranking/filtering/deduplication/limit, UTF-8 terms, pronunciation overrides; retain old-schema degradation and cache behavior. |
| UI brain-db wrapper | Metadata schema check and native connection lifetime. | Baseline schema 3; derived graph floor 8 is feature-specific. Replace centralized SQL gate, not copy it into routes. |
| Pi `BrainAccess.graph` | Raw link traversal, unresolved targets, touched document metadata. | Same `brain_graph` result, directions, depth/cycle handling and snapshot consistency; reuse core's link-walk semantics deliberately. |
| Pi search/context/list and add/update/archive | Opens core handles and calls core-owned search/context/index/ingestion functions; list maps filter results. Only graph embeds its own SQL. | Preserve tool results, keyless behavior and permission/lock paths. Move unavoidable native-handle helpers to unsupported internal entries through #534, or provide result wrappers; never call them the supported SQL replacement. |
| Jobs opportunity hygiene | Non-archived opportunity `status.md` paths and updated dates, then source frontmatter. | Complete deterministic candidate set; no lost rows from pagination/caps; keep module taxonomy/config ownership. |
| Core CLI/MCP, search/context, graph build/labels/precompute/queries, indexer, stats/tags/audit/hygiene/validation/sync | Core-owned SQL on core-owned handles. `walkLinks` already pins one read transaction. | Internal queries stay internal; current CLI/MCP result contracts and retrieval goldens remain binding. Consolidation must preserve profile differences. |
| Core module-authoring/public exports | `HygieneContext.db` and ordinary database-taking exports expose native storage types to callers. | #537 must freeze a query-result context, not accidentally stabilize SQL; #534 curates ordinary exports and unavoidable internal helper entries. |
| Public brain-template | No direct SQL reader at `b78b355444b9ee1e819b85f43582d06b6957e3bd`. README names the disposable index. | No consumer migration invented. Reaudit generated source before retirement. |
| Public brain-hosting-template | No direct SQL reader at `262444c3bbe9c18456afa70a2554ee5046a31101`. Its privilege decision describes ownership of the index. | Shell dependencies may need an approved core peer; generated-host ownership remains in that public repository. Reaudit before retirement. |

Sources: (`openBrainDb`, `packages/ui-server/src/db/brain-db.ts:74-96`); graph meta (`getGraphMeta`, `packages/ui-server/src/graph/reader.ts:437-471`), edges (`DISTINCT_EDGES_SQL`, `packages/ui-server/src/graph/reader.ts:253-258`), neighborhood (`getNeighborhood`, `packages/ui-server/src/graph/reader.ts:525-540`),
discovery (`getDiscovery`, `packages/ui-server/src/graph/reader.ts:542-617`) and maintenance (`getMaintenance`, `packages/ui-server/src/graph/reader.ts:619-673`); voice (`buildKeyterms`, `packages/ui-server/src/voice/keyterm-builder.ts:390-437`) and content
extraction (`extractFromContent`, `packages/ui-server/src/voice/keyterm-builder.ts:257-272`); pi ([historical native graph](https://github.com/schlessera/brain-kit/blob/fe5c75162882cd1f67af2cb808de37094ebea38d/packages/ui-backend-pi/src/brain-access.ts#L280-L367)); jobs ([pre-#699 opportunity query](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/module-jobs/src/pipeline.ts#L151-L170)); raw module context ([pre-#699 hygiene context](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/core/src/lib/module-types.ts#L12-L17)).

> **2026-10-01 — Implementation context (pi inventory above and link-walk
> comparison below).** The native pi graph and listing described by the audit
> have been replaced with supported [query results](../content-index-queries.md).
> The historical graph links preserve the audit evidence. Pi keeps its depth
> cap of four and empty absent-path result; core MCP retains its separate cap
> of five. Remaining search/context and write
> helpers use core's unsupported `/internal` entry; ordinary-export curation
> remains #534's responsibility. The SQL retirement conditions still bind.

The UI operational database (`src/db/client.ts`, sessions/settings/principals/
activity and related callers) is separate authoritative UI state, not `brain.db`.
Jobs' own jobs/scrape-run database is also separate. Their SQLite imports are
not content-index consumers and their storage is outside this transition.
No other first-party content module directly queries the content index in this
audit. Private instances are outside the public audit and never provide public
fixtures or evidence.

Current SQL promises cover more than these query projections: schema metadata,
embedding identity/dimensions, FTS tokenizer fallback and transactional language
rebuild, additive schema history, semi-stable tables, optional graph provenance,
virtual roots, stale derived caches, read-only opens and no outside writes.
The new API does not expose vectors/native extensions, raw FTS tables, arbitrary
metadata keys or SQL. Diagnostic/index state comes through documented results.
The final migration guide explicitly distinguishes existing supported reads
from arbitrary external SQL that will no longer be supported after retirement.

## Ownership and package access

The maintainer selected **A, a lazy optional core peer**, on 2026-10-03 in
[#696's package ruling](https://github.com/schlessera/brain-kit/issues/696#issuecomment-5967816497).
UI-server consumes the concrete `@schlessera/brain/queries` subpath of package
`@schlessera/brain`. Core supplies normal source, default JavaScript and type
exports (`"./queries"`, `packages/core/package.json:45-49`), with no forced
condition, new package or dependency on the UI protocol. Importing the entry
initializes neither config/modules nor providers, vectors, agents or the CLI.

#697 declares `@schlessera/brain` in **both** `peerDependencies` and
`peerDependenciesMeta` with `optional: true`. A host explicitly installs a
compatible core release for graph and index-derived voice vocabulary;
otherwise independent server features boot without it. A peer declaration
alone is insufficient: ordinary peers install by default, while optional
metadata prevents automatic installation, as specified by
[npm](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#peerdependenciesmeta)
and [Bun](https://bun.sh/guides/install/add-peer). This is packaging policy,
not a packed-install or installation-size measurement.

Resolve the module lazily when needed and cache its functions once per app.
Validate the **actual imported package/subpath identity**, its compatible
version range and required callable operations before use. Graph requires the
five `readGraph*` operations below; vocabulary requires `readVoiceVocabulary`.
Core's exported package metadata (`"./package.json"`, `packages/core/package.json:44`)
identifies the same resolved installation; a separate `brain` binary on PATH
cannot establish its identity or capabilities. #697 derives and documents the
concrete range from releases shipping the required query features, verifies
those release manifests/exports and packed behavior, and keeps peer metadata,
edge policy, build order and host guidance consistent. No numeric range is
selected by this design; a guessed version or a wildcard without feature proof
is not compatibility evidence.

Package capability and index state are different checks:

| Condition | Required server behavior |
| --- | --- |
| Core absent, wrong identity, incompatible package version, missing subpath or required operation | Graph query capability is unavailable with sanitized diagnostics. Index vocabulary is unavailable/degraded; pronunciation overrides survive, providers without keyterm use remain independent, and unrelated features still boot. Never persist degradation as successful vocabulary. |
| Usable core returns `missing_index`, `incompatible_index` or another typed index failure | Preserve the established index-specific graph/voice mappings below. Package availability does not imply an available index or a valid empty graph. |
| Usable core returns a valid empty result | Preserve that success; do not conflate it with capability/index failure. |

UI-server owns HTTP/SDK adaptation, pronunciation files, caches and provider
selection. Published server declarations must remain usable by independent
consumers without installing optional core merely to typecheck. #697/#700 prove
normal packed source/default/types resolution, standalone declarations, absence,
identity/version/feature skew and actual mounted routes. No handwritten SQL,
PATH-CLI substitution, query service/provider seam or per-query process fallback.

The inspected source is the pre-migration baseline: no core server dependency
or peer (`"dependencies"`, `packages/ui-server/package.json:56-69`;
`"peerDependencies"`, `packages/ui-server/package.json:70-74`), and no allowed
server-to-core edge (`"@schlessera/brain-ui-server"`, `tests/allowed-edges.ts:92-95`).
The ruling approves the one-way edge; this document does not implement it.
Core owns plain results and imports no UI SDK types. Native snapshots and
connections remain core-owned per operation, never cached with the functions.

A hard dependency was viable and would simplify automatic setup and version
resolution. It was rejected because every server install would bring core and
couple the packages even when neither graph nor vocabulary is used. The chosen
optional peer gives the host explicit installation/version ownership, with the
additional absence/skew, declaration and migration obligations above.

## Core-created module hygiene context

The maintainer selected **A, root-bound `ctx.queries`**, and approved raw-db
removal on 2026-10-03 in
[#696's context ruling](https://github.com/schlessera/brain-kit/issues/696#issuecomment-5969048668).
Retain `HygieneContext<C>.root` and the module's validated, parsed `config: C`;
replace `db` with the concrete query object created by core. The current context
exposed `db` before #699 ([pre-#699 hygiene context](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/core/src/lib/module-types.ts#L12-L17));
#699 migrates the context, every callback/fixture and author guidance together.
It does not leave an indefinite deprecated raw-db escape.

Core captures the authoritative brain root when constructing the context.
Every bound operation uses that captured root: JavaScript/unsafe inputs that
supply `brainPath`, and later changes to `ctx.root`, cannot redirect a query.
Type-level omission alone does not prove this runtime property. Existing module
trust and HTTP/tool authentication/root-containment ownership remain unchanged.

The object exposes exactly the nine supported operations, with existing options,
validation, defaults and detached `QueryResult<T>` values; only caller
`brainPath` is omitted. It is not a consumer-provided implementation, SQL
callback, `.sql`/`.prepare`/`.execute` escape or native handle. It holds neither
a persistent connection nor a transaction spanning callbacks. Each synchronous
operation opens/closes its own core-owned read snapshot. Module callbacks may
return synchronously or asynchronously; core keeps awaiting them and reporting
failed checks (`const found = await check`, `packages/core/src/lib/auditor.ts:1056-1065`).
A typed query failure must propagate into that lifecycle rather than being
converted to an empty candidate list or successful hygiene result.

Explicit supported query imports with `brainPath: ctx.root` were a viable
alternative: they reuse the standalone functions and keep the context smaller.
Root-bound queries were selected to centralize binding and reduce repeated
root wiring in every module. The cost is an additional concrete method/type
surface and required runtime binding proof; no configurable query backend is
introduced.

## Supported operations and reachable types

The standalone signatures and full result shapes are defined by the shipped
[API specification](../content-index-queries.md#types), not a second proposed
API here. The bound context preserves them except for the captured root.
Options below are those beyond `brainPath`; standalone functions still require
that root. Every return is `QueryResult<T>`.

| Method | Bound options | Value type |
| --- | --- | --- |
| `readGraphMeta` | None | `GraphMeta` |
| `readGraphClusters` | `community?: number`, `includeIsolates?: boolean` | `Subgraph` |
| `readGraphNeighborhood` | Required `center: string`; `depth?: number`, `direction?: Direction` | `Subgraph` |
| `readGraphDiscovery` | `root?: string`, `direction?: "out" \| "both"`, `maxDepth?: number` | `Subgraph` |
| `readGraphMaintenance` | `staleDays?: number`, `now?: string` | `Maintenance` |
| `readLinkWalk` | Required `path: string`; `depth?: number`, `direction?: "outgoing" \| "incoming" \| "both"` | `LinkWalk` |
| `readVoiceVocabulary` | Required `limit: number` | `VoiceVocabulary` |
| `listIndexDocuments` | `type?: string`, `tag?: string`, `status?: string`, `relevance?: string`, `limit?: number` | `ListedDocument[]` |
| `findIndexDocuments` | `type?: string`, `excludeStatus?: string`, `pathSuffix?: string` | `DocumentCandidate[]` |

Source: (`readGraphMeta`, `packages/core/src/queries/index.ts:10-12`), through
(`findIndexDocuments`, `packages/core/src/queries/index.ts:131-159`); exported
results (`export type Direction`, `packages/core/src/queries/types.ts:2-109`).
#534's public export inventory and #537's module-author inventory include the
bound context and every signature-reachable option/result type, including
nested results: `QueryResult`, `QueryCode`, `Snapshot`, `Root` (standalone),
`Direction`, `Node`, `Edge`, `Community`, `GraphMeta`, `Subgraph`, `Maintenance`,
`LinkWalk`, `VoiceVocabulary`, `ListedDocument` and `DocumentCandidate`.
Options currently use anonymous structural intersections; their property
shapes and the root-omitted bound forms belong to the inventory too. Any named
bound types introduced by #699 must be supported and inventoried there, rather
than accidentally exporting loader/native bookkeeping. Normal declarations and
external module-author typing must preserve concrete `config: C`, option
validation and result/error discrimination.

### Complete jobs selection and source ownership

The existing jobs callback selects `type = 'opportunity'`, `status != 'archived'`
and `(path = 'status.md' OR path LIKE '%/status.md')`, ordered by path
([pre-#699 opportunity query](https://github.com/schlessera/brain-kit/blob/33af7e2972873286144dbcc93c232c904e3ced47/packages/module-jobs/src/pipeline.ts#L151-L170)).
#699 uses complete `findIndexDocuments` metadata with `type: "opportunity"`
and `excludeStatus: "archived"`, followed by the **module-owned exact former
path predicate**. Null status remains excluded. Preserve these asymmetric cases:

| Path | Selected by the former predicate |
| --- | --- |
| Root `status.md` | Yes |
| Root `STATUS.MD` or `Status.Md` | No |
| Nested `roles/status.md`, `roles/STATUS.MD`, `roles/Status.Md` | Yes |
| Root `notstatus.md` or nested `roles/notstatus.md` | No |

Nested LIKE matching has its established ASCII case behavior; root equality is
exact. `pathSuffix` is a literal, case-sensitive suffix, not a basename/LIKE
predicate. `status.md` alone admits near-names; `/status.md` misses the root and
nested case variants. Neither safely narrows this selection. Do not alter the
suffix contract or use bounded `listIndexDocuments` (default 20, maximum 100).
`findIndexDocuments` returns the complete path-ordered set in one snapshot,
without a cap/pagination loss (`findIndexDocuments`, `packages/core/src/queries/index.ts:131-159`).

Read source frontmatter under the callback root and retain existing stage,
staleness and taxonomy rules. The module's parsed config and separate jobs
operational database remain unchanged. Preserve nullable `DocumentCandidate.updated`
as documented; failures are distinguishable from a valid empty set.

## Approved breaking migrations

[#697](https://github.com/schlessera/brain-kit/issues/697) owns the explicit
peer-install migration for existing graph/index-vocabulary hosts.
[#699](https://github.com/schlessera/brain-kit/issues/699) owns raw `db` removal
and the bound calling convention, migrating every affected callback, fixture
and module-author guide in the same change. Both have prior dated maintainer
rulings above. Under [contract versioning](../decisions/contract-versioning.md),
before 1.0 each break needs `breaking`, `CONTRACT:`, same-commit integration-contract
and author/host migration documentation, and a **minor changeset naming the
break**. From 1.0 breaks require majors. An additional unapproved machine
behavior break still needs its own ruling. These choices select no package
version, numeric peer range, release date, publication or immediate 1.0 freeze.
The direct-SQL promises remain binding until #701's separately verified retirement.

`readVoiceVocabulary` owns extraction SQL and the existing normalization,
proper-noun/content/path scoring, deterministic deduplication and ranking. It
returns at most the requested positive integer limit. Do not retune taxonomy or
stoplists during migration. The UI keeps pronunciation overrides read from
markdown, cache location, logging and provider selection; its cache version is
invalidated when extractor behavior changes. The missing-index error remains
an error through the existing caller; incompatible index degrades to empty
vocabulary plus overrides and is never persisted as a successful cache.

Graph defaults match UI-server: clusters exclude isolates unless requested;
neighborhood depth 1/both capped at 3 and 1,500 nodes; discovery out/depth 8;
maintenance 180 days (1..3650). General subgraphs cap at 5,000 nodes and 20,000
edges using current ranking/tie behavior (`MAX_NODES`, `packages/ui-server/src/graph/reader.ts:33-40`). API integer/direction inputs
are validated; invalid input is explicit rather than SQL coercion. Adapters
retain the current HTTP parameter validation before queries (`createGraphRoutes`, `packages/ui-server/src/routes/graph.ts:53-60`).

Graph nodes are markdown only; edges are distinct resolved document pairs,
exclude self-links and non-markdown endpoints (`DISTINCT_EDGES_SQL`, `packages/ui-server/src/graph/reader.ts:253-258`). ID 0 is the virtual root,
never a persisted document. IDs are identities within a result/index, not stable
identities across a rebuild; consumers retain paths as durable document keys.
Uncomputed graph permits raw neighborhood/link walking with absent analytics,
while clusters/discovery/maintenance refuse `not_computed`. Discovery counts
cover the whole graph, exclude a virtual root, and are omitted when no root
resolved; direction affects an explicit root, not precomputed default distances.
Preserve existing maintenance ordering, unresolved link text and stale cutoff.

Core CLI graph helpers have different defaults, fields and cap behavior
(`getClusterGraph`, `packages/core/src/lib/graph/queries.ts:181-204`). They may share private mechanics, but their public CLI `--json`
shapes/defaults remain unchanged. Pi and MCP link walking default to depth 1/both.
Pi and the supported link-walk query clamp depth to 1..4; core MCP's own cap is 5.
It is a different result from the drawn graph: unresolved text is preserved and cycle/deduplication behavior
stays consistent with the supported tools. Audit the pi/core parity instead of
blindly replacing one with the other (`walkLinks`, `packages/core/src/lib/link-walk.ts:39-56`) and the [historical pi graph](https://github.com/schlessera/brain-kit/blob/fe5c75162882cd1f67af2cb808de37094ebea38d/packages/ui-backend-pi/src/brain-access.ts#L280-L367).

## Index compatibility, errors and lifetime

Core owns feature compatibility tables: supported old layouts and each required
column/table, the maximum understood layout, metadata validation and disposable
schema detection. Minimum schema numbers are internal choices; they are not
caller parameters. Current baseline is 3 (`MIN_BRAIN_SCHEMA_VERSION`, `packages/ui-server/src/db/brain-db.ts:23`) and core writes its one source
(`SCHEMA_VERSION`, `packages/core/src/lib/db.ts:18`). A newer unknown schema must fail `incompatible_index` unless core has
an explicit compatible-layout rule. A high claimed version with missing required
structures is corrupt/incompatible, never trusted because its number is high.
Normal additive old layouts remain usable where the requested feature exists.
No query loads sqlite-vec, migrates, creates tables or writes the content index.

| Condition | API behavior | Existing consumer adaptation |
| --- | --- | --- |
| Missing file | `missing_index`, nonretryable until index exists | Graph meta retains its described unavailable state; subgraphs refuse; voice keeps its current missing-index error. |
| Old/new unsupported or malformed version | `incompatible_index` | Graph legacy `schema` unavailability; voice empty degraded terms with markdown overrides, never cached as healthy. |
| Compatible base, absent graph computation | Meta value with available false/not_computed; derived modes `not_computed`; neighborhood/link walk succeeds | Existing meta 200 and derived-mode 503 behavior. |
| Stale derived graph | Success with stale true and computed/index timestamps in meta; never recompute on read | Preserve stale graph UI; do not claim fresh. |
| Corrupt/unreadable DB or structural mismatch | `corrupt_index` or `unavailable_index`; no raw SQL/native error details | Safe generic existing 500 for unexpected I/O/corruption; sanitized logs. |
| Lock wait exhausted | `busy_index`, retryable true | Safe existing temporary failure mapping; bounded native wait, no retry loop. |
| Requested indexed path absent | `not_found` | Existing graph 404; pi/MCP preserves its own documented absent-path result/error. |
| Invalid options/path escaping root | `invalid_input` | Existing validation/tool error; never read another root. |

Each operation opens read-only, begins one read transaction, checks metadata
and feature structures inside it, obtains all required rows, materializes the
result, ends the transaction and closes in `finally`. Use a bounded 100ms native busy
timeout, with no automatic retries; measure its route impact. SQL/connection errors
become the typed errors above. Resource cleanup covers validation after open,
mid-query failure and success. Compatibility/availability does not masquerade
as a valid empty result. No caller holds a handle, transaction or statement.

The indexer currently opens/writes the existing database; `--force` is not a
promise of atomic file replacement (`indexAll`, `packages/core/src/lib/indexer/run.ts:155-165`). A read transaction provides one
committed SQLite snapshot, not a promise that every stage of a multi-stage index
run is a single publication. Compare graph provenance against newest indexed
data to report stale state. A rename/replacement can happen externally: an
in-flight read may return a complete old snapshot, closes, and the next call
must open the new path. Replacing DB/WAL files unsafely is not an API write path.
Tests use valid checkpointed fixture replacements, plus concurrent WAL commits.
Do not cache compatibility verdicts across opens or leak handle lifetime into
UI caches. Responses from different requests are not one shared snapshot.

Errors contain codes/retryability, without SQL text, credentials, arbitrary
absolute paths or document content. Known graph availability remains a described
state; failures never read as "no links". Current HTTP `schemaVersion` continues
as a numeric observed diagnostic. This design does not delete/retype it or
claim SQL compatibility based on it. No new HTTP/MCP/CLI result is invented.

## Interactive cost and required verification

Preserve in-process graph reads and BFS; no process launch per query. Lazy import
is cached at application scope, and every native connection is short-lived.
Existing work loads adjacency per query; this design adds a transaction and
compatibility checks, not a new graph recomputation. There is no existing numeric
graph latency SLO in the audited contract/source, so this spike does not invent
a measured millisecond claim. Consumer migration records cold and warm p50/p95
for the existing reader and replacement on the same deterministic fixture plus
a generated cap-sized graph, including the real HTTP route. It must demonstrate
no per-request process, bounded returned scenes and no material regression;
an unexplained regression blocks migration until diagnosed. Record host/runtime,
corpus size and methodology so a reviewer can compare. No network/paid models.

Verification must use the actual CLI-produced fixture index, not a handcrafted
schema that copies the reader's assumptions (`ui-server's readers run`, `tests/brain-db-contract.test.ts:201-244`). Existing table
assertions (`REQUIRED_COLUMNS`, `tests/brain-db-contract.test.ts:49-62`) stay until final retirement.

Verification ownership is explicit; documenting a requirement completes none
of these implementation criteria:

| Handoff | Required proof |
| --- | --- |
| #697 / #700 | Normal packed install and source/default/types resolution; independent standalone declarations without core; actual imported peer identity/range/required-operation skew; real mounted graph/voice behavior and cold/warm route measurements; per-operation native lifetime. |
| #699 | Real loader with CLI-produced index; nonempty complete jobs selection including every root/nested/case/near-name and null-status case; parsed config/source ownership; captured-root binding against unsafe input and later context mutation; typed missing/incompatible-index failure reporting; intended selection/binding/failure mutations. |
| #534 / #537 | Public/module-author inventories include every reachable query option/result/bound-context type; normal published declarations and third-party-style module-author typing/lifecycle checks. |
| #701 | All migration/export/consumer proofs and a fresh public-reader audit before retiring SQL promises; preserve internal compatibility tests and existing result/diagnostic fields. |

Replacement tests cover:

- All five graph results, virtual and absent roots, unresolved targets, duplicate
  and self links, asset exclusion, caps, ordering, explicit/default discovery
  counts, stale/uncomputed states and old compatible raw neighborhoods.
- Actual mounted graph/voice consumers after auth, pi link/list adapters and the
  jobs hygiene callback through the real module loader; nonempty terms/edges/
  candidate sets and source overrides. Use the Odysseus world for new fixtures;
  do not expand the unrelated full-corpus migration #625.
- Missing/corrupt indexes, older supported and unsupported versions, an unknown
  newer version, a forged version with missing columns, lock failure and explicit
  errors without leaking native diagnostics.
- A second WAL connection committing between component reads; one response must
  retain its snapshot. Swap valid checkpointed index A for B between calls and
  prove B is read. Force mid-query errors and show closure/no stale handle,
  including Windows-compatible replacement where the runtime supports it.
- Real npm consumer source/built resolution and typechecking under normal
  conditions; optional-core absence and matching/incompatible peer identities,
  under the approved optional-peer boundary. Standalone server declarations must
  typecheck without optional core; package skew and index skew are separate cases.
  Retain CLI/MCP envelopes and keyless retrieval goldens.

For each runtime guard, break the protected behavior and show the intended
non-vacuous assertion failing: version check, transaction, per-call open/close,
real mount/result mapping and complete hygiene selection. Restore every mutation.
Deleting SQL column tests before behavior coverage exists is not verification.

## Transition boundary

Keep the supported API and its contract documentation alongside the still-binding
SQL promises; consume the two approved package/context decisions; migrate actual
readers and curated helper imports; establish cross-package runtime/package coverage; then retire the SQL
promise in one explicit breaking-contract change with a migration guide. The
final issue depends on every migration, compatibility coverage and #534's export
cleanup. Reaudit all three public repositories at that point. #537 incorporates
the resolved query context before freezing module authoring.

This plan does not implement those steps, choose a release date, schedule 1.0,
change markdown semantics, or demand arbitrary external SQL compatibility after
the completed transition. The rulings authorize the recorded one-way peer/context
migrations and SQL retirement under its separate conditions; they do not authorize another
dependency, new provider seam or silent result break. Implementation tasks live
under #56 and link this design.

The scoped API, decision, consumer, compatibility and retirement handoffs are tracked by
[#695](https://github.com/schlessera/brain-kit/issues/695),
[#696](https://github.com/schlessera/brain-kit/issues/696),
[#697](https://github.com/schlessera/brain-kit/issues/697),
[#698](https://github.com/schlessera/brain-kit/issues/698),
[#699](https://github.com/schlessera/brain-kit/issues/699),
[#700](https://github.com/schlessera/brain-kit/issues/700) and
[#701](https://github.com/schlessera/brain-kit/issues/701), under #56.
