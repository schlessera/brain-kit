# Multi-query search is not worth a new interface (2026-11-08)

Research often needs several independent searches. Agents can already run
them as parallel `brain_search` calls. The question behind
[#3645](https://github.com/schlessera/brain-kit/issues/3645), part of
[#3640](https://github.com/schlessera/brain-kit/issues/3640), is whether one
bounded call that takes several named queries would give an agent the same
evidence with less envelope, fewer repeated results and a stated bound.

**Decision: no-go.** Keep independent, parallel `brain_search` calls. Add no
query array, no new tool and no new result schema. The two candidate savings
are small, and they are not savings on every workload:

- **The envelope saving is about 100 characters a query.** An MCP
  `brain_search` response costs 95 characters of JSON-RPC and content framing
  around its JSON. A repeated degraded-lane warning adds 81 more.
- **Deduplication only helps when queries overlap heavily.** It can fold only
  a document's query-independent fields. Snippet, rank and score belong to the
  query, so every association stays. Folding saves 3% on a four-query project
  overview and 11% when four wide queries share most of their hits. On
  disjoint or filtered queries the per-hit rank and the call's structure make
  the answer 6–7% *larger* than the parallel calls.

Neither saving changes the request count. Parallel calls in one assistant
message already cost the same two provider requests as one batch. A shared
output budget then costs coverage. Under the 24,000-character default the
#3641 contract set, the wide task lost 2 of 7 useful hits. Parallel calls
returned all 7, because over MCP they have no aggregate bound and in Pi each
call gets its own 30,000-character budget. In Pi the prototype's JSON is
also 69% larger than the text answers Pi's `brain_search` gives today.

The comparison did find two real gaps. Both are properties of the
single-query tool, and both can be closed there (see [What to revisit](#what-to-revisit)):

- `brain_search` takes no path scope. Filtering its results afterwards
  returned 2 of the 5 documents a pushed-down scope finds.
- Pi passes any `limit` through, where MCP caps it at 50.

This is a decision about local mechanics only. Tokens, provider cost and
real-model usability were **not measured**. No API key or model call was used,
and nothing here infers a provider saving from a byte or call count. Only the
full-text lane is qualified. The vector lane and the judgment reranker never
ran.

## What was compared

The harness is `experiments/multi-query-search.test.ts`. Its workload is in
`experiments/multi-query-search/workload.ts`, and its private prototype is in
`experiments/multi-query-search/prototype.ts`. It runs in the experiment tier
([experiment-tier.md](experiment-tier.md)) and reuses the plain measurement
helpers of the bounded-read spike (`experiments/bounded-read/measure.ts`)
unchanged.

**Workload.** The core fixture corpus plus the generated documents of the
bounded-read spike (`experiments/bounded-read/scenarios.ts`): twenty harbour
notes, a raft build log, a crew ledger, a passage log and others. All are
written from fixed text, with the pinned date `2026-07-12`, and indexed with
the real CLI (`brain index --force --json`). Each task is the set of named
searches one research step needs. It also lists, per query, the documents
that answer it:

| Task | Queries | Shape |
| --- | --- | --- |
| `project-overview` | `raft status`, `sail repairs status`, `current focus`, `timber` | overlapping: status-style searches over the same projects |
| `disjoint` | `knee rehab`, `star bearings`, `safe beach` (limit 5) | three unrelated topics |
| `filtered` | `raft` as `type: project`, `raft` as `type: journal`, `timber` updated since `2026-07-12` sorted by `updated`, `raft` with a deadline from `2026-07-12` sorted by `deadline` | one topic under different per-query filters and sorts |
| `heavy-overlap` | `harbour water`, `safe beach`, `timber`, `Ithaca` (limit 20) | a survey of every harbour; the useful hits include each list's tail |

Separate calls cover a malformed date, an unknown sort, a repeated query and a
question the corpus cannot answer. Three scoped queries cover an include
folder, an include folder with an excluded file, and an excluded folder.

**Independent calls.** Each task runs as sequential and as parallel calls
through:

- the real core MCP server (`brain mcp` over stdio, keyless), whose
  registration is (`"brain_search"`, `packages/core/src/mcp-server.ts:217-279`).
  A recording wrapper on the client transport logs every JSON-RPC message;
- Pi's real agent loop (`runAgentLoop` with pi-ai's faux provider), executing
  the curated tool (`brainSearchTool`, `packages/ui-backend-pi/src/brain-tools.ts:103-164`)
  from `createBrainTools`. Arms: all calls in one assistant message (Pi's
  default parallel execution) and one call per message. The faux provider is
  **scripted**. Its tool choices and request counts show runtime mechanics,
  not that a model would choose or fill any tool, and they are not provider
  savings.

**Prototype.** `searchManyPrototype` is private. No package exports it and it
is not a registered tool. Each query runs the ranking `brain_search` runs: the
reranker selection and option mapping of
(`searchDocuments`, `packages/core/src/lib/ops/read.ts:59-106`) over
(`hybridSearch`, `packages/core/src/lib/search-engine.ts:821-977`). A path
scope goes into the candidate pool through `SearchOptions.paths`, the way
context assembly pushes it (`scopedPaths`, `packages/core/src/lib/context-assembler.ts:575-578`).
All queries run in one read transaction. For MCP the response is modelled
with the framing the server's structured tools use, and its latency is
in-process.

The harness asserts that every prototype query returns exactly the rows,
order, scores and snippets of `searchDocuments` for the same input. It also
checks order and score against the served MCP tool to 1e-6, and order against
the Pi tool's text answer. Recency ranking reads the clock, so the in-process
prototype tests pin it to `2026-07-12` (`setSystemTime`). The MCP and Pi arms
run on the wall clock, as the shipped surfaces do.

## Measurements

One run: Bun 1.4.4, SQLite 3.53.4, `@modelcontextprotocol/sdk` 1.30.1,
`@earendil-works/pi-ai`/`pi-agent-core` 0.99.2, source `8843b7bd7`.
Characters are UTF-16 code units. The workload has almost no non-ASCII text,
so UTF-8 bytes are within 1% of them. Elapsed times are the median of five
warm runs on one developer machine. They are noisy and support no ranking.
Scores carry wall-clock recency, so a payload can differ by a few characters
between runs.

### MCP stdio

| Task | Queries | Hits / distinct paths | Parallel payload | Parallel responses on the wire | Envelope per call | Repeated warning chars | Repeated document-field chars | Prototype, no dedupe | Prototype, deduped | Prototype, default cap | Useful hits: parallel · default cap | Latency ms (seq / par / prototype) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| project-overview | 4 | 35 / 27 | 19,181 | 40,289 | 95 | 243 | 1,863 | 19,664 | 18,675 | 18,690 | 5/5 · 5/5 | 10.3 / 7.9 / 4.7 |
| disjoint | 3 | 15 / 14 | 8,898 | 18,735 | 95 | 162 | 245 | 9,213 | 9,399 | 9,394 | 3/3 · 3/3 | 5.0 / 4.2 / 3.0 |
| filtered | 4 | 13 / 12 | 7,048 | 15,050 | 96 | 243 | 243 | 7,342 | 7,522 | 7,519 | 4/4 · 4/4 | 6.0 / 4.8 / 3.7 |
| heavy-overlap | 4 | 69 / 30 | 34,592 | 72,148 | 96 | 243 | 5,519 | 35,406 | 30,885 | 23,055 (19 hits omitted) | 7/7 · 5/7 | 14.1 / 12.3 / 7.1 |

"Payload" is the JSON text of the results. "Repeated document-field chars" is
the title, type, relevance, status, summary, dates and tags of every path
after its first appearance in the task: the most deduplication can fold. No
two queries returned an identical row, because snippets and scores differ per
query. The prototype's caps are those of the default fill below, with a
roomy 40,000-character budget in the two uncapped columns.

What the numbers say:

- **Parallel calls already overlap.** They still send one JSON-RPC request
  per query and save wall time, nothing else. The server sends each result
  twice, as text and as `structuredContent`
  (`structuredResult`, `packages/core/src/mcp-server.ts:164-167`), so the wire
  is about twice the payload either way.
- **The envelope is 95 characters a call**, and the keyless degraded-lane
  warning (81 characters) rides on every result. A batch carries both once:
  about 530 characters for four queries.
- **Deduplication is smaller than the repeats suggest.** The prototype adds a
  `rank` to every hit and a per-query header (`id`, `status`, `returned`,
  `omitted`, `limit_reached`). Folded, the overview saves 506 characters (2.6%)
  against parallel calls and the wide survey 3,707 (10.7%). Disjoint and
  filtered tasks grow by 501 and 474 characters (5.6% and 6.7%). Without
  folding, every task is larger than the parallel calls.
- **A shared budget loses evidence.** At the default 24,000 characters the wide
  survey kept 50 of 69 hits and lost 2 of its 7 useful hits. Parallel MCP calls have no aggregate bound and returned 34,592
  characters, all of it. One call can only match them if its budget grows
  with the number of queries, which undoes the point of the cap.
- **Latency.** The in-process prototype is a few milliseconds faster than
  parallel stdio calls because it skips the stdio hop, not because it shares
  work. Nothing here is shared: each query runs its own full-text pass, ranked
  and cut by its own limit.

### Pi agent loop (scripted provider)

| Task | All calls in one message | One call per message | Prototype call | Max concurrent `brain_search` | Warning chars repeated in the answers | Useful hits: parallel · prototype |
| --- | --- | --- | --- | --- | --- | --- |
| project-overview | 2 requests, 11,040 result chars, 13,222 transcript, Σ context 16,826 | 5, 11,040, 14,210, Σ 45,029 | 2, 18,689, 21,451, Σ 25,055 | 4 | 471 | 5/5 · 5/5 |
| disjoint | 2, 5,345, 7,131, Σ 10,735 | 4, 5,345, 7,789, Σ 22,807 | 2, 9,395, 11,383, Σ 14,989 | 3 | 251 | 3/3 · 3/3 |
| filtered | 2, 4,220, 6,377, Σ 9,982 | 5, 4,220, 7,367, Σ 28,799 | 2, 7,521, 9,567, Σ 13,172 | 4 | 335 | 4/4 · 4/4 |
| heavy-overlap | 2, 22,370, 24,530, Σ 28,136 | 5, 22,370, 25,524, Σ 78,360 | 2, 23,086, 25,816, Σ 29,420 | 4 | 335 | 7/7 · 5/7 |

"Transcript" is everything after the prompt: tool calls and results. "Σ
context" adds up the context the scripted provider received on each request.

- **One message of parallel calls costs the same two requests as one batch.**
  Pi runs them concurrently. The difference is between one message and one
  call per message. For the wide survey that is 78,360 context characters
  against 28,136, because each request resends the growing history. That is
  model behaviour, which no offline harness can measure, and nothing here
  shows that a model would choose the batch over parallel calls.
- **Pi's answer is text, not JSON.** The curated tool answers one line per hit
  with path, title, type and snippet, with no score, status or dates. That is
  why the same evidence is 11,040 characters in Pi and 19,181 over MCP. The
  prototype's JSON is 69% larger for the overview. A Pi multi-query tool would
  need its own text view, and it could then fold only a title and a type.
- **Each Pi call has its own 30,000-character clip**
  (`clip`, `packages/ui-backend-pi/src/tool-kit.ts:29-32`). None of these tasks
  reached it, so the parallel arm lost nothing. The prototype's shared default
  budget did.

### Contract mechanics

The prototype was built to the rules in [the contract it would need](#the-contract-it-would-need),
and the harness checks each one. What the comparison shows about the
alternatives:

- **Errors.** Over MCP a malformed date or an unknown sort fails that one call
  at schema validation (`MCP error -32602 … is not a calendar date at
  updated_since`), and the other parallel calls answer. Parallel calls
  therefore already isolate per-query errors. The prototype gets the same
  isolation only by moving those checks out of the schema into per-query
  `invalid_query` items. Core's message then names its internal option
  (`updatedSince must be a date written YYYY-MM-DD`), not the input the caller
  sent.
- **Duplicates.** A repeated query is answered once and reported as
  `duplicate` with `of` pointing at the first. Parallel calls run it twice. In
  this workload the only identical repeats were the ones planted.
- **No-answer.** Full-text matching is a disjunction of terms, so `tribute
  return deadline` returned five partial matches on every surface. A batch
  changes nothing here.
- **Cancellation.** The prototype checks the signal between queries and
  rejects with no partial answer (1 of 4 queries ran). Over MCP a cancelled
  call rejects on the client, which sends `notifications/cancelled`. But
  `searchDocuments` takes no signal, so the server finishes the search anyway.
- **Snapshot.** All queries of one prototype call read the index snapshot of
  its first read. When an index row was renamed between two queries, a
  second separate search returned the new title, and the second query inside
  the call still returned the old one. As in [multi-root-graph.md](multi-root-graph.md),
  this is a reindex racing two reads. Each result is internally coherent.
- **Path scope.** Pushed into the pool, `timber` scoped to `projects/` found 5
  documents. Filtering the unscoped top 10, which is all an agent can do with
  `brain_search` today, kept 2. The harbour scope with one exclusion found 10
  against 7. An excluded folder lost nothing, because the top 10 had room.
  Scope has to change the pool, not the answer: the full-text lane draws
  `limit × 2` candidates before reranking and cutting
  (`ftsSearch`, `packages/core/src/lib/search-engine.ts:410-415`), so widening
  the limit and filtering afterwards ranks a different pool.
- **Roster cost.** The listed `brain_search` definition is 3,179 characters.
  A like-for-like `brain_search_many`, with `brain_search`'s own field
  descriptions as the item schema plus the call's fields, is 3,173. A second
  search tool roughly doubles the search share of the roster on every
  provider request of a session that has it.

**Unavailable.** Provider input, output and cache tokens, cost, actual
provider-request grouping and model usability. The evidence rows carry the
`UNAVAILABLE` marker rather than a zero. Embedding and reranker requests are
not observed. The rule that a batch makes one embedding request per distinct
hybrid or vector query, the same as parallel calls, comes from the code, not
from a measurement.

## The contract it would need

This section records the design so that a reopened proposal starts from it
rather than from a plain array of queries. It is not a contract anything
builds now.

- **Queries.** 1–8 entries, each with a caller-chosen `id` (1–64 of
  `A-Z a-z 0-9 _ . -`, unique in the call) and `brain_search`'s own inputs.
  A per-query `limit` from 1 to 50 is rejected outside that range, never
  clamped. A structural error rejects the whole call. A filter value that only
  the search can judge (a date, a sort, a scope entry) is that query's
  `invalid_query`.
- **Association and order.** `queries[]` comes back in request order with
  `index` and `id`. Each hit carries its own query's `rank` and `score`.
  Scores are on that query's scale and are never compared, merged or fused
  across queries. A repeated query (same inputs, any id) is a `duplicate` with
  `of` and runs once.
- **Deduplication.** Optional and representational only. A path's
  query-independent fields appear once, in `documents` keyed by path. Every
  hit keeps its path, rank, score and snippet, so every (query, path)
  association survives. The harness checks that a folded answer resolves to
  exactly the unfolded one.
- **Bounds.** `max_total_chars` (2,000–40,000, default 24,000) bounds the
  whole serialized answer. `max_total_results` (1–200, default 50) bounds the
  hits. The envelope is reserved first, with every count at its widest. If it
  does not fit, the call is rejected. Hits are then taken **one rank at a time
  across queries**, and a query stops at its first hit that does not fit, so
  each query returns a prefix of its own ranking. Each query reports
  `returned`, `omitted` (ranked but cut) and `limit_reached` (more may exist).
  At 4,000 characters a query-order fill returned nothing for the last two
  queries of the overview (useful coverage 2 of 5). The rank-by-rank fill kept
  every query's first hit (4 of 5).
- **Work.** One search per distinct query, and nothing shared. Vector and
  judgment-rerank requests are those of the same parallel calls, never more,
  and they are counted. The query limit is the work cap.
- **Errors.** One query's error is an item with a code (`invalid_query`,
  `search_failed`) and a message that names the caller's input and never a
  host path. It never fails the call.
- **Cancellation.** The signal is checked before each query. A cancelled call
  rejects with no partial answer. Production would also need a signal in
  `hybridSearch`'s vector and rerank lanes.
- **Path scope.** Per-query `include`/`exclude` with exactly the semantics of
  [#3644](https://github.com/schlessera/brain-kit/issues/3644) (`parseContextScope`,
  `packages/core/src/lib/context-scope.ts:105-137`): an exact path or a folder
  ending in `/`, an exclusion wins, exclusions case-folded. It is pushed into
  every lane's pool through `SearchOptions.paths`, never applied to a cut
  list.
- **Snapshot.** Every query in one read transaction.

## What to revisit

Reopen the multi-query question only on new evidence: a real-model trial in
which agents demonstrably fall back to one search per message, or
provider-reported usage showing that per-call envelope overhead, not result
content, dominates search-heavy tasks. Fewer tool calls alone is not that
evidence. `gpt-6.1-terra` is one model to run. A trial must record the exact
model, route, settings and fixture identities, and report tokens, cache and
cost from the provider's own usage.

The single-query findings are separate, cheaper candidates, to be filed and
ruled on separately:

1. **Path scope for `brain_search`**, on MCP and Pi, with #3644's
   `include`/`exclude` semantics pushed into the pool through
   `SearchOptions.paths`. This is an additive contract change. It is the one
   finding with a measured evidence loss today (2 of 5 and 7 of 10 above).
   #3643 adds a path prefix to `brain_list`, not to search.
2. **Cap Pi's `brain_search` limit** as MCP caps it (`MAX_SEARCH_LIMIT`, 50).
   Pi passes the model's limit through. A limit of 60 searched for 60, and
   only the corpus size and the 30,000-character clip bounded the answer.
3. **Let a cancelled `brain_search` stop the server's work.** `searchDocuments`
   takes no abort signal, so a cancelled MCP search runs to completion.

None of these has a contract impact until it is filed and built. This
decision changes no production API.

## Reproduction

```sh
bun run build   # the experiment tier needs the built workspace
BRAIN_MULTI_QUERY_EVIDENCE=/path/to/evidence.json \
  bun run test experiments/multi-query-search.test.ts
```

The environment variable is optional. With it set, the run writes the raw
rows behind every table above to that file: each arm, repeat timings, wire
totals, duplication counts, coverage, the budget sweeps and the unavailable
markers.
