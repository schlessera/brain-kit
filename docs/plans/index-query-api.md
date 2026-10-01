# Supported content-index query APIs

Design from [#540](https://github.com/schlessera/brain-kit/issues/540), implementing
[the approved SQL-boundary ruling](../decisions/index-query-api.md). This is a
proposed API, not a description of shipped exports. GitHub holds implementation
and decision work; this document carries no work status. The current
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
extraction (`extractFromContent`, `packages/ui-server/src/voice/keyterm-builder.ts:257-272`); pi ([historical native graph](https://github.com/schlessera/brain-kit/blob/fe5c75162882cd1f67af2cb808de37094ebea38d/packages/ui-backend-pi/src/brain-access.ts#L280-L367)); jobs (`checkOpportunityStages`, `packages/module-jobs/src/pipeline.ts:151-170`); raw module context (`HygieneContext`, `packages/core/src/lib/module-types.ts:11-16`).

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

Core implements a concrete `@schlessera/brain/queries` entry point, with source,
built JS and declarations under normal conditional exports. No forced Bun
condition, UI SDK dependency in core, or new package is required. The entry
point loads only query dependencies; importing it never starts config/module
loading, an embedding provider, native vector loading, an agent or the CLI.

The recommended ui-server access is a lazy optional core peer. Resolve the
module once per application and reuse its functions; **do not cache a native
connection**. A deployment declaring that capability installs the peer
explicitly; installing ui-server alone stays supported and other features boot.
Missing peer becomes query capability unavailability, never a fallback to
hand-written SQL or a subprocess per click. Match the imported peer identity,
not a different `brain` binary found on PATH. Version/feature checks precede use.

This edge is not currently allowed (`"@schlessera/brain-ui-server"`, `tests/allowed-edges.ts:86-89`). A maintainer decision must
approve the optional peer and its version/capability behavior, or specify a
concrete alternative. A hard dependency would guarantee the API but install
core for all server consumers; duplicating SQL or a pluggable query provider
would defeat the ruling. If the decision chooses another boundary, update this
proposal and its tasks before dependent implementation. Do not widen the edge
table merely to pass a check. No current package manifest changes in the spike.

Core owns plain result types. UI-server maps them to existing SDK graph payloads
and errors; type/runtime contract checks prove both mappings. This prevents a
core-to-UI cycle. Module callbacks receive a concrete index-query object bound
to their root; it is not a provider seam or consumer-supplied implementation.
The recommended replacement for raw `HygieneContext.db` is `queries`, with only
result methods and no `.sql`, native DB callback or prepare/execute escape.
Its removal is a structural public change requiring an explicit context ruling
coordinated with #537 and #534. The existing field remains until that migration.

## Proposed signatures and result contract

All query calls are synchronous after the module resolves. Options explicitly
name the brain root; a path is resolved under that root, never from ambient
configuration. This is trusted server/library access, not an auth bypass:
HTTP/tool callers retain their existing authentication, authorization and
root-containment checks. Results are detached values; no live iterator escapes.

```ts
type Direction = "in" | "out" | "both";
type QueryCode = "missing_index" | "incompatible_index" | "corrupt_index"
  | "busy_index" | "unavailable_index" | "not_computed" | "not_found" | "invalid_input";
interface Snapshot {
  schemaVersion: number; // observed diagnostic, never a caller's SQL floor
  newestIndexedAt: string | null;
}
type QueryResult<T> =
  | { ok: true; value: T; snapshot: Snapshot }
  | { ok: false; error: { code: QueryCode; retryable: boolean } };
interface Root { brainPath: string }
interface Node {
  id: number; path: string; title: string; type: string;
  inDegree: number; outDegree: number;
  community?: number; pagerank?: number; x?: number; y?: number;
  distance?: number; virtual?: boolean;
}
interface Edge { source: number; target: number }
interface Community { community: number; size: number; label: string | null; topTerms: string[] }
interface GraphMeta {
  available: boolean; reason?: "schema" | "not_computed";
  schemaVersion: number; computedAt: string | null; stale: boolean;
  nodeCount: number; edgeCount: number; communities: Community[];
  defaultRoot: { path: string; virtual: boolean } | null; layoutSkipped?: boolean;
}
interface Subgraph {
  nodes: Node[]; edges: Edge[]; truncated: boolean;
  reachableCount?: number; unreachableCount?: number;
}
interface Maintenance {
  orphans: Node[]; unreachable: Node[];
  brokenLinks: { sourcePath: string; target: string }[];
  stale: (Node & { updated: string })[]; staleDays: number;
}
interface LinkWalk {
  edges: { source: string; target: string; resolved: boolean }[];
  nodes: { path: string; title: string; type: string;
    summary: string | null; updated: string | null }[];
}
interface ListedDocument {
  path: string; title: string; type: string; relevance: string | null;
  status: string | null; tags: string | null;
}
interface DocumentCandidate { path: string; updated: string | null }

function readGraphMeta(opts: Root): QueryResult<GraphMeta>;
function readGraphClusters(opts: Root & {
  community?: number; includeIsolates?: boolean;
}): QueryResult<Subgraph>;
function readGraphNeighborhood(opts: Root & {
  center: string; depth?: number; direction?: Direction;
}): QueryResult<Subgraph>;
function readGraphDiscovery(opts: Root & {
  root?: string; direction?: "out" | "both"; maxDepth?: number;
}): QueryResult<Subgraph>;
function readGraphMaintenance(opts: Root & {
  staleDays?: number; now?: string;
}): QueryResult<Maintenance>;
function readLinkWalk(opts: Root & {
  path: string; depth?: number; direction?: "outgoing" | "incoming" | "both";
}): QueryResult<LinkWalk>;
function readVoiceVocabulary(opts: Root & {
  limit: number;
}): QueryResult<{ terms: string[]; extractorVersion: number }>;
function listIndexDocuments(opts: Root & {
  type?: string; tag?: string; status?: string; relevance?: string; limit?: number;
}): QueryResult<ListedDocument[]>;
function findIndexDocuments(opts: Root & {
  type?: string; excludeStatus?: string; pathSuffix?: string;
}): QueryResult<DocumentCandidate[]>;
```

Every signature-reachable type is supported and documented with the API. Names
above are proposed exports; validation and defaults are part of their contract.
`findIndexDocuments` is a purpose-bounded metadata selection for hygiene: literal
suffix matching (no SQL LIKE wildcard input), ordered by path, complete in one
snapshot, no implicit result cap or pagination losses. Null status remains
excluded when `excludeStatus` is supplied, matching the current jobs predicate.
It exposes no arbitrary column selection or SQL expression. `listIndexDocuments`
keeps pi/MCP listing behavior: default 20, maximum 100,
archived inclusion only when requested, current metadata filters and ordering.
The two functions do not silently share different defaults.

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
as a numeric observed diagnostic. This proposal does not delete/retype it or
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
assertions (`REQUIRED_COLUMNS`, `tests/brain-db-contract.test.ts:49-62`) stay until final retirement. Replacement tests cover:

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
  once the dependency ruling is approved. Retain CLI/MCP envelopes and keyless
  retrieval goldens.

For each runtime guard, break the protected behavior and show the intended
non-vacuous assertion failing: version check, transaction, per-call open/close,
real mount/result mapping and complete hygiene selection. Restore every mutation.
Deleting SQL column tests before behavior coverage exists is not verification.

## Transition boundary

Add supported APIs and their contract documentation while SQL stays supported;
settle the package/context decisions; migrate actual readers and curated helper
imports; establish cross-package runtime/package coverage; then retire the SQL
promise in one explicit breaking-contract change with a migration guide. The
final issue depends on every migration, compatibility coverage and #534's export
cleanup. Reaudit all three public repositories at that point. #537 incorporates
the resolved query context before freezing module authoring.

This plan does not implement those steps, choose a release date, schedule 1.0,
change markdown semantics, or demand arbitrary external SQL compatibility after
the completed transition. The ruling authorizes retirement under these
conditions; it does not authorize a disputed new dependency or silent result
break. Implementation tasks live under #56 and link this design.

Implementation and the unresolved boundary ruling are tracked by
[#695](https://github.com/schlessera/brain-kit/issues/695),
[#696](https://github.com/schlessera/brain-kit/issues/696),
[#697](https://github.com/schlessera/brain-kit/issues/697),
[#698](https://github.com/schlessera/brain-kit/issues/698),
[#699](https://github.com/schlessera/brain-kit/issues/699),
[#700](https://github.com/schlessera/brain-kit/issues/700) and
[#701](https://github.com/schlessera/brain-kit/issues/701), under #56.
