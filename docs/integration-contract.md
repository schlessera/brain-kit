# brain-kit Integration Contract

The machine-readable surface other systems (primarily **brain-ui**) may depend
on. Anything NOT listed here is an internal implementation detail and can
change without notice. Contract changes require a `CONTRACT:` commit prefix and a
same-commit update of this file. How they are versioned:

- **Additive** — a new field, a new optional input, a new tool, a
  `schema_version` bump for a migration that only adds. Ships in a minor.
- **Breaking** — a field removed, renamed or retyped, or a value whose meaning
  changes. Before 1.0 it ships in a minor as well, and additionally needs the
  `breaking` label, a maintainer ruling recorded on its issue before code is
  written, and a changeset that names the break. From 1.0 it needs a major
  version bump of `@schlessera/brain-*`.

The reasoning is in [decisions/contract-versioning.md](decisions/contract-versioning.md).

Lineage: this is the public successor of the `INTEGRATION.md` that lived in
the private brain's `scripts` directory; shapes are unchanged unless marked.

## Consumers

| Consumer | Surfaces used |
|----------|---------------|
| brain-ui (`packages/ui-server/src/brain/client.ts`) | CLI `--json` commands, brain.db reads (voice keyterms), file paths |
| Coding-agent sessions (MCP) | MCP server tools, CLI |
| Cron on a hosting container | `brain maintain`, module cron entries (`brain jobs scrape` …) |

## CLI conventions

- Bin name: `brain` (stable). Runs under Bun.
- Output mode: JSON when stdout is not a TTY; force with `--json` / `--human`.
- Exit codes: `0` success · `1` usage error · `2` internal failure
  (`maintain` exits `2` if any step failed).
- Boolean flags never consume the following argument.
- End-of-options: a bare `--` stops flag parsing, and every later argument is
  positional verbatim. Output-mode and help flags after it are positional too
  (additive in 0.33.0).

### Stable `--json` shapes

| Command | Shape |
|---------|-------|
| `brain search "q" --json` | `{ "results": SearchResult[], "warnings": string[] }` — `warnings` reports degraded modes (no vectors, model mismatch, missing key) |
| `brain audit --json` | `{ "issues": AuditIssue[], ... }` — markdown documents only (assets excluded) |
| `brain context "q" --max-tokens N` | assembled markdown context (text) |
| `brain briefing` | briefing text (mechanical: deadlines, reviews due, silent edits — no LLM) |
| `brain index [--force] [--embeddings]` | stats object; incremental by default, `--force` = full rebuild, `--incremental` accepted as no-op |
| `brain doctor --json` | `{ "checks": [{ "id", "status": "pass"\|"warn"\|"fail", "detail", "fix"? }] }` (new in brain-kit) |
| `brain init --check` | preflight object (new in brain-kit). Its `config` block is `{ exists, valid, initialized, path, error? }`; `initialized` is true only when the config declares something (profile, taxonomy, modules, embeddings), so a brain holding the template's empty starter config reads as `exists: true, initialized: false` (added in 0.37.0) |
| `brain okf export --json` | `{ "outDir", "filesExported", "assetsCopied", "linksConverted", "linksDegraded", "degradedLinks", "indexFilesGenerated", "topLevelDirectories", "warnings" }` |
| `brain okf check [dir] --json` | `{ "directory", "ok", "filesChecked", "errors", "warnings", "issues": [{ "severity", "path", "message" }] }`; exit 1 when `errors > 0` |
| `brain graph stats --json` | `{ "computedAt", "root", "nodes", "edges", "brokenLinks", "components", "reachable", "layoutSkipped", "algo", "communities" }` |
| `brain graph compute [--root <path>] --json` | `{ "nodes", "edges", "brokenLinks", "components", "communities", "root", "reachable", "layoutSkipped", "durationMs" }` |
| `brain graph export --mode clusters\|discovery\|local\|maintenance --json` | `{ "nodes", "edges", "truncated" }`, except `maintenance` → `{ "staleDays", "root", "orphans", "unreachable", "brokenLinks", "stale" }` |
| `brain stats --json` | `{ "documents", "byType", "byStatus", "byRelevance", "tags", "links", "brokenLinks", "chunks", "embeddings", "health", "size" }` — `health` and `size` added in 0.37.0, additively; every earlier field keeps its name and type. `embeddings` keeps its name and type but **changed value** in 0.37.0: it now reports the real vector count on an embedded brain, where before it read `0` on every brain |
| `brain jobs scrape --json` | `{ "report": ScrapeReport }` — a module command, listed here because a hosting container runs it on a schedule (see Consumers). `sources[].status` added in 0.37.0 |

`SearchResult` fields: `path`, `title`, `type`, `snippet`, `score`, `tags`,
`status`, `relevance`, plus ranking metadata. Treat unknown fields as
additive; never rely on field order.

`brain stats --json` grew two nested blocks in 0.37.0. Nothing was removed or
renamed, so a consumer reading only the flat counts (as
`packages/ui-react/src/lib/api-client.ts` does) needs no change.

One flat count did change value, though its name and type did not. Before
0.37.0 the command counted `vec_chunks` on a read-only connection that had
never loaded sqlite-vec, so the query raised `no such module: vec0` and a bare
`catch` reported `embeddings: 0` — on a fully embedded brain as much as on a
keyless one. It now loads the extension before counting, so on any host where
sqlite-vec loads, `embeddings` is the real number of stored vectors. A consumer
that treated `0` as "this brain does not embed" was reading a measurement
failure, and will now see the true count; one that charted the figure over time
will see a step at this version, not a re-embedding run.

**The failure is narrowed, not closed.** `embeddings` is typed `number` and is
emitted as `embeddingCount ?? 0`, so when the extension will not load *at all*
on a host it still reads `0` for a brain that holds vectors. The two states
remain indistinguishable in that field. What separates them is its sibling:
`health.embeddingCoverage` is `null` when the count is unknown and a ratio when
it is known, so a consumer that needs to tell "no vectors" from "could not
count" must read the coverage, not the count. Making `embeddings` itself
nullable would say this in the field's own type, but that is a breaking shape
change and is deliberately not made here.

```jsonc
{
  // health: what needs attention. A figure that cannot be known is null,
  // never 0 — an unmeasurable ratio must not read as a failing one.
  "health": {
    "brokenLinkRate": 0.054,       // brokenLinks / links; null when there are no links
    "embeddingCoverage": null,     // vectors / chunks; null when this brain neither
                                   // embeds nor holds vectors, or has no chunks
    "stale": 2,                    // past the per-type staleDays — the `brain audit` definition
    "orphans": 1,                  // no link either way, honouring orphanExempt — likewise
    "untagged": 1,                 // non-archived markdown documents with no tags
    "thresholds": { "coverageFloor": 0.9, "brokenLinkCeiling": 0.05 }
  },
  // size: what the brain weighs. brain.db is disposable; its size is a
  // rebuild-cost figure, not a claim that it holds authoritative state.
  "size": {
    "corpus": { "bytes": 22231, "files": 29 },   // null when a directory under the
                                                 // root could not be read
    "db": { "bytes": 453208, "tables": { "documents": 25, "links": 37 } },
    "freeBytes": 643825672192     // null when the platform call fails
  }
}
```

`stale` and `orphans` are the same counts `brain audit` reports in its
`staleness` and `orphan` categories, from the same per-type `staleDays` /
`orphanExempt`. `brain stats` does not carry a threshold of its own; the only
configuration it adds is the `stats` block on `brain.config.*`
(`coverageFloor`, `brokenLinkCeiling`, both ratios in 0..1), which supplies the
`health.thresholds` echoed above and defaults to the values shown when absent.

`brain jobs scrape --json` prints `{ report }` and nothing else. Its per-source
rows gained a `status` in 0.37.0, additively — every earlier field keeps its
name and type — because the count alone could not say what a zero meant. A
board that had nothing to offer and a board whose parser had stopped working
both reported `jobs_found: 0` with an empty `errors`, and that is what
[#37](https://github.com/schlessera/brain-kit/issues/37) closes.

```jsonc
{
  "report": {
    "sources": [
      {
        "source": "remoteineurope",
        // One of exactly four values. A consumer branches on this, not on the
        // count, and must tolerate an unknown fifth rather than assuming.
        //
        //   "ok"          rows came out. Pages that drifted are still listed
        //                 in `errors`, so `ok` does not mean "no errors".
        //   "empty"       EVERY page the board attempted came back readable,
        //                 and they said, in the board's own terms, that it
        //                 holds no postings — an API's own envelope with an
        //                 empty record list, a feed with a channel and no item
        //                 markup. One page that failed or was not recognised
        //                 denies the board this. The only zero-row state
        //                 allowed to carry an empty `errors`.
        //   "unparseable" a page arrived, did not say it was empty, and
        //                 yielded nothing: selector drift, a challenge page,
        //                 or markup from another site.
        //   "not_run"     nothing readable arrived at all — never invoked, or
        //                 every page failed before a body could be parsed
        //                 (robots.txt refusal, HTTP 410, no Chrome).
        "status": "unparseable",
        "jobs_found": 0,
        "jobs_new": 0,
        "jobs_updated": 0,
        "errors": ["Remote in Europe https://remoteineurope.com/: parsed 0 jobs from a page that does not say it is empty — selector drift, a challenge page, or markup that is not this board's"],
        "duration_ms": 4213
      }
    ],
    "dedup": { "checked": 0, "duplicates_found": 0 },
    "scored": 0,
    "total_new": 0,
    "total_errors": ["..."]   // every source's errors, concatenated
  }
}
```

Every selected board gets a row, including one whose adapter never returned: it
appears with `status: "not_run"` rather than dropping out of `sources`, because
a missing row reads as a board that was never asked for.

The jobs database records the same judgement in `scrape_runs.status`: `ok` and
`empty` are `completed`, `unparseable` and `not_run` are `failed`. A board that
could not be read therefore stops advancing its cursor even when it threw
nothing.

## MCP server (stdio, `brain mcp` or `src/mcp-server.ts`)

Tool names and input schemas are stable:

| Tool | Annotations | structuredContent |
|------|-------------|-------------------|
| `brain_search` | readOnly | `{ results, warnings }` |
| `brain_context` | readOnly | `{ context, warnings }` |
| `brain_read` | readOnly | file text |
| `brain_list` | readOnly | `{ documents, warnings }` |
| `brain_graph` | readOnly | `{ edges, warnings }` |
| `brain_add` / `brain_update` / `brain_archive` | non-destructive, idempotent (update/archive) | result object |

Read tools append an index-staleness warning when markdown files are newer
than their `indexed_at`.

### Chat-UI in-process tools (`mcp__brain-ui__*`)

The chat-UI backends register an in-process MCP server under the `brain-ui`
key; its tool names are equally stable. `ask_user`, `get_current_location`
and `request_image_mask` bridge to the connected browser. `query_activity`
(read-only) reads the host's activity record — scopes `running` | `recent` |
`run` | `rollups` | `inbox`; results are wrapped in a data-only delimiter
(nonce-suffixed per call) because they can contain free text from past runs.
`show_block` (side-effect free, always registered) renders one of the kit's
answer blocks inline in the answer; it validates its argument and echoes it.
The five bridge tools are declared once as **tool contracts** in
`@schlessera/brain-ui-sdk/tool-contracts` (also re-exported from `/server` and
`/client`); their names and Claude-side input schemas are stable.

### Tool component contracts

A contract is `{ name, description, input, brief }`, plus `payload` when the
tool's result is meant to be rendered as a component rather than read as text:

| Contract | Payload in `output` | Rendered as |
|---|---|---|
| `ask_user` | `{ questions, answers, annotations? }` | the picker's answered state |
| `get_current_location` | `{ latitude, longitude, accuracyMeters, place?, address?, addressComponents?, note?, retrievedAt }` | a map card: the fix as a pin, the shoreline from `GET /api/geo/coastline` when the server has it |
| `request_image_mask` | `{ maskPath, imagePath, bytes, note }` | a mask result |
| `query_activity` | **none** | prose in a nonce-delimited data block |
| `show_block` | `{ block }`, the validated input echoed | the block, inline at the call's position in the answer |

`show_block`'s `block` is a discriminated union on `kind`. Each variant
mirrors the props of the kit component that draws it; tone values are the
kit's `Tone` / `ValueTone` / `DeltaTone` sets, and every value is a
pre-formatted string because the blocks do no arithmetic:

| `kind` | Shape | Drawn by |
|---|---|---|
| `comparison` | `columns[2..4]{label, note?, tone?, recommended?}`, `rows[]{label, cells[](string \| {v, tone?})}`, `corner?`, `footnote?` | `ComparisonTable` |
| `stats` | `tiles[1..8]{label, value, meta?, icon?, tone?}` | `StatTiles` |
| `trend` | `label?`, `value?`, `delta?`, `deltaTone?`, `values[2..]`, `ticks?[]`, `tone?` | `TrendChart` |
| `table` | `columns[1..6]{label, align?}`, `rows[]{cells[]{v, tone?, mono?, bold?}}` | `DataTable` |
| `bars` | `rows[1..12]{label, pct 0-100, value, tone?}` | `BarList` |
| `receipt` | `title?`, `titleIcon?`, `titleTone?`, `rows[]{k, v, tone?}`, `diff?`, `footnote?` | `Receipt` |
| `steps` | `steps[]{title, detail?, meta?, code?, state?}`, `variant?` | `StepList` |
| `timeline` | `items[]{time, title, detail?, meta?, tone?, pulse?}` | `TimelineList` |
| `schedule` | `groups[]{day, meta?, items[]{time, title, detail?, tag?, tone?}}` | `ScheduleList` |
| `quote` | `quote`, `source?`, `locator?`, `note?`, `tone?`, `icon?` | `QuoteCard` |
| `contact` | `label`, `role?`, `contactKind?`, `badge?`, `tone?`, `facts?[]{k, v, tone?}`, `initials?` | `ContactCard` |

Layout knobs the kit components take (`labelWidth`, `barWidth`, `height`,
`timeWidth`, …) are not part of the contract: the surface decides them.
`icon` fields are the kit's semantic icon keys; a key the kit does not know
is dropped rather than rejected. `show_block` is the one payload parsed with
its **input** schema rather than a loose one: the payload is the model's own
argument echoed back, so a field the client's schema does not know is dropped
from the rendered block rather than kept, and the block still renders.

Rules a consumer may rely on:

- **The payload rides as JSON inside `ServerToolResult.output`**, which is
  already a string, so this needs no `PROTOCOL_REV` bump. Every tool with a
  `payload` schema serialises it there — `query_activity` has no payload
  because its result is untrusted text from past runs, and handing that to a
  component is a separate decision with its own threat model.
- **Payload schemas are additive and parsed loosely.** Unknown keys survive, so
  a newer server may add fields; a consumer that cannot parse a payload falls
  back to the generic tool view rather than failing the message.
- **The name the model sees is adapter-derived**, not a second constant:
  `visibleToolName(name, "claude")` prefixes `mcp__brain-ui__`, `"pi"` uses the
  bare name. `bridgeContractForToolName()` resolves either spelling.
- **`BRAIN_UI_SYSTEM_PROMPT_APPEND`'s tool paragraph is generated** from the
  contract list: every contract carries its own `brief`, so a tool cannot be
  schema'd without being described to the model.
- **The input JSON Schema is `z.toJSONSchema(input, { io: "input" })` with
  `$schema` removed**, identical across both backends for the same tool.

Result fields are additive (treat unknown fields as such). Cost fields are
dual: `costUsd` is the list-price reference, `effectiveCostUsd` the actual
out-of-pocket cost ($0 for subscription-billed runs); `null` means unknown,
never zero — aggregate scopes sum only known values and carry the excluded
count as `unpricedRuns`.

## ui-server HTTP routes

### Runtime stats (`GET /api/activity/stats`, additive in 0.37.0)

The runtime half of a stats surface. `GET /api/brain/stats` passes
`brain stats --json` through and stays the corpus channel; this route reports
what the **server's own** database holds — sessions, runs, tokens, cost — and
never reads brain.db. A consumer calls both and merges. It sits behind the
auth guard with the other `/api/activity/*` routes. `?days=N` picks the
window (default 30, clamped to 1–90). The shape is `ActivityRuntimeStats` in
`@schlessera/brain-ui-sdk/protocol`; timestamps are ms epoch:

```
{
  generatedAt,
  lifetime: { scope: "lifetime", sessions, turns, costUsd,
              firstActivityAt | null, lastActivityAt | null, elapsedDays,
              averages: { costUsdPerSession, turnsPerSession,
                          costUsdPerDay, costUsdPerMonth } },
  window:   { scope: "window", days, since, until,
              recordedSince | null, coveredDays,
              detailRetention: { days, cutoffAt, insideWindow },
              detailPrunedRuns,
              runs, failures, costUsd, effectiveCostUsd,
              unpricedRuns, unpricedListCostRuns,
              inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
              averages: { runsPerDay, costUsdPerDay, costUsdPerMonth,
                          effectiveCostUsdPerDay, effectiveCostUsdPerMonth } },
  database: { sizeBytes }
}
```

Rules a consumer may rely on:

- **Every figure is labelled with what it covers.** `lifetime` is read from
  the never-pruned session catalog; `window` from the run rollups, over
  exactly `[since, until]` — a closed interval whose upper end is enforced, so
  a run dated after `until` (a clock corrected backwards leaves such rows) is
  not summed. The two do not agree and are not meant to: the catalog predates
  the activity record, and the two count different things.
- **The window says how much of itself it can vouch for.** Rollup rows
  outlive detail pruning, so the sums are complete back to `recordedSince`
  (the oldest run in the record at or before `until`) — and no further;
  `coveredDays` is the span the per-day averages divide by.
  `detailRetention.cutoffAt` is where drill-in detail stops, `insideWindow`
  says whether that boundary falls inside the window, and `detailPrunedRuns`
  counts the runs in it that are already rollup-only. Say "detail older than
  N days is pruned"; do not present a window as a total.
- **Unknown never reads as $0, on EITHER cost axis.** Each cost sum is a sum
  of known values, and each carries **its own** excluded count, because the
  two columns are independently nullable: `costUsd` (list price) excludes
  `unpricedListCostRuns`, `effectiveCostUsd` excludes `unpricedRuns`. A
  subscription-billed run with no backend-reported cost is in the first
  counter and not the second — its effective cost is a known $0 while its
  list price is unknown. Render both the same way: "≥ $X · N unpriced" when
  the counter is nonzero, and wholly unknown when it equals `runs` — never as
  the `0` that a sum of no known values carries.
- **An average is `null` rather than a fabricated rate.** Every average is
  `null` when its denominator is zero, `costUsdPerDay`/`PerMonth` are `null`
  whenever `unpricedListCostRuns > 0`, and `effectiveCostUsdPerDay`/`PerMonth`
  whenever `unpricedRuns > 0` — a rate over a partial sum would hide the hole
  the sum shows. `lifetime.elapsedDays` is `0`, and its per-day and per-month
  figures `null`, when the catalog is empty *or* its oldest session is dated
  after `generatedAt`; the lifetime totals still include such a session, since
  it happened.
- **The route does no rounding or formatting**, while
  `GET /api/activity/rollups` rounds its cost sums to 4 decimal places. Over
  the same window the two therefore report `0.299997` and `0.3` for one
  quantity. Round at render time, identically for both, rather than treating
  either as pre-formatted. This channel stays raw on purpose: rounding a sum
  to 4 dp turns a real sub-$0.0001 cost into a `0` that reads as free.
- **`lifetime.costUsd` is a floor, and cannot be better than one.** The
  session catalog folds an unreported cost into `0` at write time, so no
  unpriced counter is recoverable at read time; `window` is the channel that
  separates unknown from zero. `lifetime.turns` has the same shape.
- `database.sizeBytes` is the logical size of the server database (pages ×
  page size, the WAL sidecar aside). It is a rebuild-cost figure for a
  disposable store, not a claim that the file holds authoritative state.

## brain.db (direct SQL reads)

Prefer the CLI/MCP. If reading directly:

- Check `index_metadata` first: `schema_version` (currently **8**),
  `embedding_model`, `embedding_dimensions`, `vec_schema`.
- Semi-stable tables: `documents` (path, title, type, status, relevance,
  content, deadline, next_review, …), `chunks`, `tags`/`document_tags`,
  `links`, and the derived graph tables `graph_metrics` (document_id,
  in_degree, out_degree, component, pagerank, community), `graph_communities`
  (community, size, label, top_terms JSON), `graph_root_distances`
  (document_id, distance, parent_id) and `graph_layouts` (mode, document_id,
  x, y). Columns are only ever ADDED within a schema_version line.
- The `graph_*` tables are **derived cache, rebuilt wholesale when graph inputs
  change** — they may be empty until the first index run on schema 8, and an
  older CLI writing to a v8 database leaves them stale rather than wrong.
  Unchanged index runs may reuse the graph and preserve its provenance and
  layout; `brain graph compute` and `brain index --force` always rebuild it.
  Internal input fingerprints are disposable and are not a consumer API.
  Their provenance lives in `index_metadata`: `graph_computed_at` (ISO),
  `graph_algo` (JSON parameters), `graph_root` (a document path, or
  `virtual:AGENTS.md` for an index-excluded entry file), `graph_root_links`
  (JSON array of document ids seeded by a virtual root), `graph_node_count`,
  and `graph_layout_skipped` (`"1"` when the corpus was over the layout cap).
  `graph_root` and `graph_root_links` are absent together when no root could be
  resolved, and `graph_layout_skipped` is absent unless the cap was hit — read
  every key as optional.
  A virtual root has no `documents` row; consumers synthesize a node with
  `id: 0` for it. Compare `graph_computed_at` against the newest
  `documents.indexed_at` to detect staleness.
- `vec_chunks` is a sqlite-vec virtual table — unreadable without loading the
  extension; do not depend on it externally. Its dimension is the width the
  stored vectors were produced at, recorded in
  `index_metadata.embedding_dimensions` (1536 on a fresh brain). Changing the
  configured provider does not re-declare the table; a re-embedding run does.
- Open read-only. Writers must set `PRAGMA busy_timeout` (core uses 5000ms).
- **Do not write to brain.db from outside** — markdown is the source of truth.

Everything above is enforced by `tests/brain-db-contract.test.ts`, which indexes
the fixture corpus with the real CLI and then reads it back with the shipped
`ui-server` readers. `schema_version` has exactly one source — `SCHEMA_VERSION`,
exported from `@schlessera/brain` — and that test fails when this document, the
`brain doctor` check, or a reader floor disagrees with it.

### Revision negotiation

`PROTOCOL_REV` is **4**. A client announces what it speaks with a `client_hello`
as its first frame; a host that does not understand the frame ignores it, and a
client that never sends one is treated as rev 2.

That handshake is what makes a field enforceable without a flag day. A host
applies rev-3 rules only to connections that declared rev 3:

- **rev 2** — parallel sessions, host-minted `turnId`, `server_hello`.
- **rev 3** — `client_hello`, and `turnId` echoed on every interactive reply.
  A client declaring 3 MUST echo; a reply without one is refused, because it
  cannot be correlated to the turn that raised the request. Clients that
  declare nothing keep the rev-2 tolerance indefinitely.
- **rev 4** — `message_blocks` and the `blocks` field on history messages
  (additive, see below). Nothing is required of a client; one that does not
  know the frame drops it and renders the markdown it already has.

A host must never REQUIRE `client_hello`, and must not refuse a client
declaring a revision it does not recognise — it holds it to the newest rules it
knows.

### Server → client frames

Both directions are now schema-validated at the boundary
(`@schlessera/brain-ui-sdk/schemas`). The receiving policies differ on purpose:

- A **server** rejecting a client frame answers with an `error` frame and
  counts the drop. Inbound validation is a trust boundary.
- A **client** rejecting a server frame DROPS it and reports it, never throws.
  The protocol is additive, so a client that hard-failed an unrecognised frame
  would turn every additive server change into a breaking one for older
  clients. Unknown object keys are preserved in both directions.

A third-party client may rely on that: adding a frame type, or an optional
field to an existing one, is not a breaking change. `BrainUiClient`
(`@schlessera/brain-ui-sdk/client`) implements this policy and is the supported
way to speak the protocol without reimplementing it.

### Activity stream (rev 3, additive)

Hosts that record agent activity advertise `capabilities.activity` on
`server_hello`. A client opts in per view with `activity_subscribe`
(`index` | `session` | `run`) and receives `activity_snapshot` then
`activity_delta` frames; a server never sends activity frames to a connection
without a matching subscription. Ordering: a snapshot carries per-run
high-water `seq`, every delta carries its `seq`, and the client discards
deltas at or below the snapshot's high-water for that run. Deltas are
append-only increments (a small span row, or exactly one event) — they never
grow with run length. The `result` frame additionally carries an optional
`usage` block (token totals + per-model breakdown; absent cost means unknown,
never zero), and `tool_use_start` an optional `parentToolUseId` marking tool
calls that ran inside a subagent. Activity spans may carry the additive
`principalId` of the actor responsible for them; absence means unattributed.
Each human tool response also appends an `approval_decision` event whose payload
records `principalId`, `decision` (`allow` | `always_allow` | `deny`), and
`requestKind` (`tool` | `command`), preserving every responder when one tool
raises more than one approval.
An answered `ask_user` interaction appends an `ask_user_response` event carrying
the responder's `principalId`.
Run summaries and rollups may additionally carry `principalId`,
`principalLabel`, and `principalKind`. The label and kind are immutable
historical snapshots taken when the rollup is first written, so consumers must
not join them back to the live principal record or expect later label changes
and principal pruning to rewrite history. Older clients may ignore all three
fields.

### Classified blocks (rev 4, additive)

A host may run a classification pass over a finished turn's assistant text
(D42): a deterministic walk finds candidates — a GFM table, an ordered list,
a bullet list whose items open with a time, a blockquote, a run of
key-colon-value lines — and one call to a classifier decides which of the
kit's answer blocks each candidate is, if any. What comes back is one
`message_blocks` frame, sent AFTER the turn's `result` and only when at
least one block was classified:

```
{ type: "message_blocks", sessionId, blocks: MessageBlock[] }
MessageBlock = { partIndex, start, end, block, confidence }
```

`partIndex` is the block's ordinal among the message's `text` parts;
`start`/`end` are character offsets in that part's text, end exclusive; the
client cuts the part at the span and renders `block` there. `block` is the
same union `show_block` carries, so a consumer renders both with one
component. `confidence` is the classifier's, 0–1, already above the host's
threshold. Replayed history carries the same objects on
`SessionHistoryMessage.blocks`, joined by the host from what it persisted,
so a consumer never classifies twice.

Rules a consumer may rely on:

- **The pass is progressive enhancement.** A turn's `result` never waits on
  it; the frame is absent, not late, when the classifier is unconfigured,
  times out (the host's budget is two seconds), errors, or answers below
  threshold. A consumer that renders markdown and ignores the frame is
  correct.
- **Spans are exact for the text the host saw.** A span that does not fit
  the text a consumer holds must be ignored, never rendered blank.
- **Blocks contain only what the text carried.** The classifier chooses a
  shape and a tone; it never invents a footnote, a figure, or a source line.

## File-layer contracts

- Markdown files: YAML frontmatter per `CONTRACT.md` (shipped in the package);
  `deadline` / `next_review` are ISO dates queried by briefing features.
- The configured inbox dir (default `notes/`) with `status: active` =
  unprocessed inbox (capture targets this).
- Committed sidecars `.context-cache.jsonl` / `.asset-cache.jsonl`:
  content-hash-keyed `{k,v}` JSONL, rebuilt from the db after embeddings
  runs — machine-managed, union-merge on conflict, never hand-edit. Templates
  ship them empty.
- Module data files (e.g. module-jobs' `jobs.db`) are documented by the module
  that owns them.

## Extension interfaces

`EmbeddingProvider`, `CompletionProvider`, `AgentRunner`, `SkillEmitter`
(core) and the ui-sdk interfaces are `@experimental` until 1.0: breaking
changes are minor-version events, announced in the CHANGELOG.

Module manifests are two-phase: `defineModule({ name, configSchema?, setup })`,
where `setup(validatedConfig)` returns the contribution. The contribution is
schema-validated at load — unknown keys are load errors — and module commands
receive `{ root, json, config, taxonomy }`, so a command must NOT re-read
`brain.config` itself. See [modules.md](modules.md).

## Guarantees consumers may rely on

- **Containment.** Everything the CLI writes stays inside the brain root.
  Config-supplied directories, module config paths, and caller-supplied
  document paths are repo-relative (no absolute, `~`, `..`, or control
  characters) and resolved through a symlink-aware canonicalizer, so neither a
  symlinked directory nor a dangling symlink redirects a write out of the repo.
- **Mutating commands require an initialized brain.** `add`, `import`, `index`,
  `archive`, `accept-mtime`, `process`, `maintain`, `sync`, `skills sync`, and
  `setup`, plus `okf export`, exit 1 when no `brain.config` is found rather than initializing a
  stray directory. Read-only commands (including `skills lint`) still run.
- **OKF exports are derived and isolated.** `okf export` only writes inside a
  taxonomy-excluded directory, wipes that derived directory before generation,
  and never modifies source concept files. `okf check` is read-only and accepts
  third-party bundle directories.
- **`module list --json` cron entries are shape-constrained.** A container
  entrypoint materializes them into a crontab with root privileges, so `name`
  is kebab-case, `schedule` is a 5-field expression, and `command` is a plain
  `brain …` argument string — no newlines or shell metacharacters can appear.
  **A consumer should still re-validate before interpolating**, including the
  module KEY: defense in depth is the contract here, not producer trust.
- **`modules` config keys** must be an npm package specifier or a contained
  `./path`, and are canonicalized before `import()` — a symlink cannot make the
  loader execute code from outside the root.

## Recommended consumer hygiene

Keep one **contract test** that runs `brain search "x" --json` and
`brain briefing` against a fixture brain and asserts the envelope shapes
above — cheap insurance against silent breaks.
