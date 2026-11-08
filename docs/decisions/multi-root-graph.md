# Multi-root link traversal is not worth a new interface (2026-11-08)

Following the links of several documents takes one `brain_graph` call per
root. The question behind [#3646](https://github.com/schlessera/brain-kit/issues/3646),
part of [#3640](https://github.com/schlessera/brain-kit/issues/3640), is whether
one bounded traversal over several roots would share work, deduplicate returned
nodes and edges, and so give an agent more useful evidence per call and per
returned byte than independent parallel calls.

**Decision: no-go.** Keep independent, parallel `brain_graph` calls. Add no
root array, no new tool and no new result schema. On link graphs shaped like
a brain's projects, the measured shared work and duplicate content are small.
Root-to-result provenance and per-root completeness, which a correct
multi-root result needs, cost back most of the bytes deduplication saves. A
single call also has only one output budget, where several calls have one each.
To reach the coverage of the independent calls, that budget would have to grow
with the number of roots, which undoes the point of a per-result cap. The
two real advantages, one consistent index snapshot across roots and telling a
missing root from an isolated one, are worth much less than the contract they
would need, and the second can be had on the single-root tool (see
[What to revisit](#what-to-revisit)).

This is a decision about local mechanics only. Tokens, provider cost and
real-model usability were **not measured**. No API key or model call was used,
and nothing here infers a provider saving from a byte or call count.

## What was compared

The harness is `experiments/multi-root-graph.test.ts`, with its fixture and
prototype in `experiments/multi-root-graph.ts`. It runs in the experiment tier
([experiment-tier.md](experiment-tier.md)):

```sh
bun run test ./experiments/multi-root-graph.test.ts
```

**Fixture.** The test writes an Odysseus project brain of 172 notes, all dated
`2026-07-12`, and indexes it with the real CLI (`brain index --force --json`),
so link resolution is the shipped indexer's. It includes:

- `raft` and `passage`, which share the neighbour `sail` (and `calypso` two hops
  out);
- cycles (`raft`/`sail`, `passage`/`star-bearings`, `loom`/`suitors`) and a
  self-link on `raft`;
- `loom`, disconnected from every other root;
- `driftwood`, which has no links at all;
- `crew-ledger`, a large neighbourhood of 12 ships and 144 roster pages that
  `raft` also reaches;
- four unresolved links.

The run also covers duplicate and missing roots, both directions, depths 0, 1,
3, 4, 5 and 9, and writes to the index during a traversal.

**Independent calls.** For each scenario the harness calls, in parallel:

- the real core MCP server (`brain mcp` over stdio), whose `brain_graph`
  registration is (`"brain_graph"`, `packages/core/src/mcp-server.ts:381-406`);
- the registered Pi tool (`brainGraphTool`, `packages/ui-backend-pi/src/brain-tools.ts:259-294`);
- in process, (`walkLinks`, `packages/core/src/lib/link-walk.ts:39-124`), under a
  counting proxy that records executed statements and returned rows without
  changing the function.

**Prototype.** (`walkLinksMulti`, `experiments/multi-root-graph.ts:251-424`) is
private. No package exports it and it is not a registered tool. It runs every
root inside one read transaction. Each root uses the `walkLinks` hop loop and
per-root deduplication, with expansions memoised across roots. The union keeps
each edge with the roots that reach it, and the result is cut under global
bounds. A `sequential` strategy, which cuts in root order, stands in for the
naive union.

The harness asserts that, without bounds, each root's attributed edges equal
its own `walkLinks` edges for every direction and for depths 1–5. That shows
the prototype preserves each root's reachability.

## Measurements

One run: Bun 1.4.4, SQLite 3.53.4, fixture SHA-256 `7224b714…a0a17fd`,
source `2ed20c3be`. Elapsed times are the median of five runs on a developer
machine. They are noisy and only their order of magnitude matters. Every
other number is deterministic. The candidate bounds give the whole
multi-root call one Pi tool-result budget (`MAX_OUTPUT_BYTES`, 30 000
characters), at most 8 roots, 500 edges, 500 nodes and 2 000 statements.

| scenario | roots | statements: independent / prototype | duplicates (edges / nodes) | bytes: Pi independent / prototype unbounded / prototype candidate | MCP text / wire bytes | evidence coverage: Pi / fair / sequential |
| --- | --- | --- | --- | --- | --- | --- |
| overlap, depth 1, both | 2 | 6 / 7 | 0 / 1 | 2 143 / 2 397 / 2 397 | 2 171 / 4 774 | 1 / 1 / 1 |
| disjoint, depth 2, both | 2 | 16 / 17 | 0 / 0 | 2 320 / 2 710 / 2 710 | 2 348 / 5 158 | 1 / 1 / 1 |
| hub, depth 2, both | 4 | 56 / 51 | 36 / 21 | 37 770 (1 truncated) / 61 230 / 29 655 | 62 597 / 132 968 | 0.89 / 0.89 / 0.22 |
| outgoing, depth 3 | 2 | 28 / 26 | 8 / 6 | 32 366 (1 truncated) / 47 314 / 29 649 | 46 236 / 98 024 | 1 / 1 / 0.75 |
| incoming, depth 2 | 2 | 8 / 8 | 2 / 2 | 1 842 / 1 767 / 1 767 | 1 870 / 4 132 | 1 / 1 / 1 |

Elapsed time for each scenario was 0.6–3.3 ms for the parallel MCP calls,
0.7–2.0 ms for the parallel Pi calls, and 0.1–1.1 ms in process. In process,
the prototype was never faster than running the single walks one after
another. Its memo and selection outweigh the statements it saves.

What the numbers say:

- **Shared work is small.** The prototype saves at most 9% of statements (hub:
  56 to 51), and with little overlap it costs one extra statement per root, the
  existence check that tells a missing root from an isolated one.
- **Duplicate content is small, and provenance takes most of it back.**
  Deduplicating the hub saves 9% of the independent bytes (62 541 to 56 668).
  With each edge's `roots` and the per-root summaries added, the saving is 2%
  (61 230). When roots barely overlap, the provenanced result is *larger*
  than the independent calls (overlap +12%, disjoint +17%).
- **Within one result budget, coverage depends on the cut.** Both the fair
  prototype and the independent Pi calls lose the same task evidence, the
  hub's last roster page. The prototype returns 21% fewer bytes in doing so,
  but only because it fits four roots into the budget of one call, while the
  Pi calls had four budgets and truncated only the hub. The naive root-order
  cut lets the hub erase `loom`, `raft` and `passage` (coverage 0.22). Any
  shared budget therefore needs the fairness rule below. Even with it, a big
  neighbourhood still takes everything the small ones leave.
- **Tokens, cost and model usability: unavailable.** These byte counts are
  JSON characters, not provider tokens. Whether a model asks for, reads or
  benefits from a multi-root result was not tested.

## What independent calls get wrong today

The comparison found three single-root properties worth recording:

- **Each call has its own snapshot.** The Pi path opens a new read transaction
  per call (`withSnapshot`, `packages/core/src/queries/snapshot.ts:89-119`). A
  write between two calls splits the union: in the harness, `raft`'s result
  still has `sail` as a resolved node, and `passage`'s result, read after the
  deletion, no longer has that edge. The prototype keeps both in one
  transaction, and the existing `walkLinks` seam test passes unchanged on this
  fixture. In practice this is a reindex racing an agent's two reads.
  Each result is still internally coherent. Only the union can be stale.
- **A missing root reads as an isolated one.** The MCP tool and the Pi tool
  (`graph`, `packages/ui-backend-pi/src/brain-access.ts:276-281`) both return
  an empty walk for `notes/absent.md` and for `notes/driftwood.md`.
- **The MCP result has no output bound, and the two adapters clamp depth
  differently.** The Pi adapter cuts at 30 000 characters by whole edges
  (`fitGraph`, `packages/ui-backend-pi/src/brain-tools.ts:64-91`). The MCP
  adapter returns the whole neighbourhood. For the hub that is 62 597
  characters of text and 132 968 bytes on the wire, because the result is sent
  both as structured content and as its JSON text copy. MCP clamps depth to
  `MAX_GRAPH_DEPTH` (5) and Pi to 4 (`readLinkWalk`,
  `packages/core/src/queries/index.ts:72-87`).

These are properties of the single-root tool. A multi-root interface does not
fix them, and each can be fixed without one.

## The design, if this is revisited

The prototype was built to the following rules, and the harness checks each
one. A future proposal should start from them rather than from a plain union.

- **Roots.** Between 1 and a fixed maximum (8 in the prototype). More are
  refused with an error, never silently dropped. Depth and direction apply to
  the whole call and are clamped as the single-root adapter clamps them. A
  repeated path is reported as `duplicate` with `duplicate_of` set to its first
  index and is walked once. An absent path is reported as `missing`, distinct
  from a found root with no edges.
- **Provenance.** `roots[]` is returned in request order with a per-root
  `status`, `reached_edges`, `returned_edges`, `omitted_edges` and `complete`.
  Each edge carries `roots: number[]`, the indices of every root whose walk
  reaches it. Deduplication merges these lists and never drops one, and an
  unresolved edge keeps its raw link text and associations. Every returned
  resolved edge has both endpoint nodes, and an unresolved edge has its
  source node.
- **Global bounds.** Edges, nodes, serialized characters and statements are
  all bounded. The character bound covers the whole result. The envelope is
  reserved with every count at its widest, and a sweep over budgets from 1 500
  to 30 000 characters checks it. A root stopped by the statement bound is
  marked `work_exhausted`, with `reached_edges` as a lower bound.
- **Fairness.** Edges are taken round-robin across roots, each in its own walk
  order. An edge already selected for another root costs nothing more. A root
  stops at its first edge that does not fit, so what it returns is a prefix of
  its walk, apart from shared edges. A large neighbourhood can therefore make
  only itself partial, and gets only the budget the others leave.
- **Partial versus complete.** The top-level `complete` is true only when every
  found root is complete. A partial result is never a silent subset.
- **Snapshot.** Every root walk and the node lookup run in one read
  transaction. Seams between roots and before the node lookup test this
  without relaxing the `walkLinks` seam.
- **Continuation.** No cursor. A cursor into a traversal is only meaningful
  against the snapshot it came from, and the index is disposable and rewritten
  at any time. For an incomplete root, the caller makes a single-root call,
  narrower in depth or direction if needed. A real continuation would need a
  snapshot identity in the contract, which is a further reason against this
  interface.

## What to revisit

Reopen the multi-root question only on new evidence: a real-model trial in
which agents demonstrably need several graph roots in one step, or
provider-reported usage showing that per-call envelope overhead, not graph
content, dominates graph-heavy tasks. Fewer tool calls alone is not that
evidence.

The single-root findings above are separate, cheaper candidates, to be filed
and ruled on separately:

1. Bound the core MCP `brain_graph` result the way the Pi tool already is,
   with `truncated` and `omitted_edges`. This is an additive contract change.
2. Align or document the MCP (5) and Pi (4) depth clamps.
3. Say when a `brain_graph` root does not exist, for example with a warning,
   instead of returning the same empty walk as an isolated document.

None of these has a contract impact until it is filed and built. This
decision changes no production API.
