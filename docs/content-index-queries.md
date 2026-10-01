# Content-index query results

`@schlessera/brain/queries` provides nine synchronous operations over a brain's
existing disposable `brain.db`. Bun resolves TypeScript source; ordinary `types`
and `default` conditions resolve the same build's declarations and JavaScript.
The entry does not initialize config, modules, providers, vectors, agents or the
CLI. It is a concrete core implementation, with no SQL/handle/provider escape.
See the [integration contract](integration-contract.md#content-index-query-api)
and [boundary decision](decisions/index-query-api.md).

```ts
import { readGraphNeighborhood } from "@schlessera/brain/queries";
const result = readGraphNeighborhood({
  brainPath: "/path/to/odysseus-brain", center: "notes/ithaca.md",
});
if (result.ok) console.log(result.value.nodes);
else console.log(result.error.code);
```

A caller supplies its trusted brain root explicitly, absolute or relative to its
own working directory. HTTP/tool adapters still own authentication and root
selection. Document keys are root-relative slash paths: `./notes/ithaca.md` is
normalized; empty, absolute, drive-prefixed, backslash, empty-segment, control
character and `..` paths are invalid. The API reads indexed keys, not source files;
a missing indexed path is `not_found`. IDs identify nodes in this index/result,
not across rebuilding; retain document paths as durable keys.

## Operations

| Operation | Options beyond required `brainPath` | Result and defaults |
| --- | --- | --- |
| `readGraphMeta` | None | `GraphMeta`; available, uncomputed or pre-graph schema state, counts, provenance, communities and root. |
| `readGraphClusters` | `community?: number`, `includeIsolates?: boolean` | `Subgraph`; all communities, isolates excluded by default. |
| `readGraphNeighborhood` | Required `center: string`; `depth?: number`, `direction?: Direction` | `Subgraph`; depth 1, both directions; depth clamped 1..3, at most 1,500 nodes. Raw links work before graph computation. |
| `readGraphDiscovery` | `root?: string`, `direction?: "out" \| "both"`, `maxDepth?: number` | `Subgraph`; default precomputed root, out direction, depth 8 clamped 1..8. |
| `readGraphMaintenance` | `staleDays?: number`, `now?: string` | `Maintenance`; stale age 180 days clamped 1..3650; optional real UTC ISO instant (`YYYY-MM-DDTHH:mm:ss[.sss]Z`) makes the date-prefix cutoff deterministic, otherwise current time. |
| `readLinkWalk` | Required `path: string`; `depth?: number`, `direction?: "outgoing" \| "incoming" \| "both"` | `LinkWalk`; depth 1, both directions; depth clamped 1..4. Unresolved raw link text, cycle/deduplication and touched-node behavior match `brain_graph`. |
| `readVoiceVocabulary` | Required positive integer `limit: number` | `VoiceVocabulary`; at most that many ranked terms; extractor version 2, matching current tag/title/path/link/content scoring and stoplists. No pronunciation file or cache access. |
| `listIndexDocuments` | `type?: string`, `tag?: string`, `status?: string`, `relevance?: string`, `limit?: number` | `ListedDocument[]`; limit 20 clamped 1..100, updated descending, current listing filter/tag behavior; archived only when `status: "archived"`. Null status is excluded by the default non-archived predicate. |
| `findIndexDocuments` | `type?: string`, `excludeStatus?: string`, `pathSuffix?: string` | `DocumentCandidate[]`; complete path-ordered metadata selection, no cap. Literal suffix including `%`, `_` and an optional leading slash, never a LIKE pattern. Supplied exclusion also excludes null status. |

All numbers must be safe integers before clamping. Enum/boolean inputs are
validated, and supplied filter/suffix strings must be nonempty without control
characters. Suffixes cannot contain backslashes or `..` path segments. An empty
successful array describes a valid index with no matching rows; failures always
have the error envelope. Results and arrays are detached and may be changed by
the caller without affecting the index or future queries.

Drawn graph nodes are markdown only. Edges are distinct resolved document pairs,
without self-links or non-markdown endpoints. General scenes cap at 5,000 nodes
and 20,000 edges, retaining highest PageRank and the existing reader's tie order;
virtual root ID 0 survives caps. Cluster order is PageRank descending then ID.
Maintenance retains current per-list 5,000-row caps and ordering. Neighborhood
BFS retains traversal order and reports truncation at its own cap. Uncomputed
layouts may provide analytics where already present; old pre-graph layouts omit
them. Derived cluster/discovery/maintenance results require graph computation.

Discovery reach counts cover the whole graph, independent of scene depth/caps,
and exclude the virtual root. Counts are absent if no default root resolved.
An explicit root uses its requested direction; default-root distances are the
precomputed walk and ignore direction. Core CLI graph defaults/envelopes stay
independent. Vocabulary does not retune taxonomy or store overrides/cache state;
UI consumers retain those responsibilities during their separate migration.

## Types

Every operation returns `QueryResult<T>` for its documented result. The following
signature-reachable types are exported from the same entry:

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


interface VoiceVocabulary { terms: string[]; extractorVersion: number }
```

The supported signatures are:

```ts
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
}): QueryResult<VoiceVocabulary>;
function listIndexDocuments(opts: Root & {
  type?: string; tag?: string; status?: string; relevance?: string; limit?: number;
}): QueryResult<ListedDocument[]>;
function findIndexDocuments(opts: Root & {
  type?: string; excludeStatus?: string; pathSuffix?: string;
}): QueryResult<DocumentCandidate[]>;
``` Unknown extra options do not
select new SQL or behavior. These functions and reachable types are supported
under the same contract-versioning policy as other named machine surfaces.

## Compatibility, snapshots and failures

Core accepts base layouts 3 through its current written schema (15), checking
metadata and every table/column needed for the requested feature inside its
read transaction. A pre-8 index may provide raw graph meta/neighborhood and link
walks; derived graph modes require layout 8 or later. Claimed graph layouts must
actually contain all graph projections, including layout/root/community columns.
Other features need only their own metadata/document/link/tag projections. A
version number cannot authorize an absent required structure. No compatibility
verdict, result or native connection is cached across calls.

Each operation validates before opening, opens read-only, sets a 100ms native
busy timeout, pins one transaction for compatibility/provenance/result reads,
materializes results, ends the transaction and finalizes statements/closes the
connection on success or failure. It never migrates, creates tables, loads a
vector extension or recomputes a graph. `newestIndexedAt` is the newest indexed
document timestamp, or null for a valid empty index. Graph meta marks derived
results stale when their computation predates that timestamp; reading does not
repair them. A transaction pins one committed snapshot, without promising the
indexer's multi-stage work is published atomically.

A concurrent WAL commit cannot mix compatibility, timestamps and result rows
within one call. A valid checkpointed file replacement may leave an in-flight
call on the old complete snapshot; the next call opens the replacement. Calls
are independent snapshots. Unsafe external replacement of live DB/WAL files is
outside this read API.

| Error code | Meaning | Retryable |
| --- | --- | --- |
| `missing_index` | `brain.db` does not exist. No file is created. | false |
| `incompatible_index` | Missing/malformed version, unsupported old/new version, or requested derived feature predates graph support. | false |
| `corrupt_index` | Non-SQLite/corrupt file, required structure absent, or structural SQL failure. | false |
| `busy_index` | Native busy/locked wait exhausted. No automatic retry. | true |
| `unavailable_index` | Other I/O/open/connection failure, including a directory at the index path. | false |
| `not_computed` | Compatible derived graph feature has no computation provenance. | false |
| `not_found` | Required center/root/link path is absent from the index. | false |
| `invalid_input` | Invalid root, path or operation option. | false |

Errors contain only code/retryability, with no native message, SQL, absolute
input path or document content. Meta success may describe `available: false`
with `reason: "schema"` or `"not_computed"` and genuine counts; a missing,
incompatible or corrupt index uses the error envelope. Existing HTTP/MCP/CLI
adapters and their degradation/error mapping remain unchanged in this addition.
The [direct-SQL guarantees](integration-contract.md#braindb-direct-sql-reads)
remain binding until the separately tracked consumer transition and retirement.
