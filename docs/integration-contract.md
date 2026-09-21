# brain-kit Integration Contract

The machine-readable surface other systems (primarily **brain-ui**) may depend
on. Anything NOT listed here is an internal implementation detail and can
change without notice. Contract changes require a `CONTRACT:` commit prefix, a
same-commit update of this file, and a major version bump of `@schlessera/brain-*`.

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
| `brain init --check` | preflight object (new in brain-kit) |
| `brain okf export --json` | `{ "outDir", "filesExported", "assetsCopied", "linksConverted", "linksDegraded", "degradedLinks", "indexFilesGenerated", "topLevelDirectories", "warnings" }` |
| `brain okf check [dir] --json` | `{ "directory", "ok", "filesChecked", "errors", "warnings", "issues": [{ "severity", "path", "message" }] }`; exit 1 when `errors > 0` |
| `brain graph stats --json` | `{ "computedAt", "root", "nodes", "edges", "brokenLinks", "components", "reachable", "layoutSkipped", "algo", "communities" }` |
| `brain graph compute [--root <path>] --json` | `{ "nodes", "edges", "brokenLinks", "components", "communities", "root", "reachable", "layoutSkipped", "durationMs" }` |
| `brain graph export --mode clusters\|discovery\|local\|maintenance --json` | `{ "nodes", "edges", "truncated" }`, except `maintenance` → `{ "staleDays", "root", "orphans", "unreachable", "brokenLinks", "stale" }` |

`SearchResult` fields: `path`, `title`, `type`, `snippet`, `score`, `tags`,
`status`, `relevance`, plus ranking metadata. Treat unknown fields as
additive; never rely on field order.

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
  extension; do not depend on it externally. Its dimension follows the
  configured embedding provider (default 1536).
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
