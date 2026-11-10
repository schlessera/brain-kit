# Decision — a bounded multi-read is a budgeting contract, not an efficiency win

The [#3641](https://github.com/schlessera/brain-kit/issues/3641) spike qualified
a candidate `brain_read_many` against the individual `brain_read` calls agents
already make, sequentially and in parallel. The result has three parts:

- **Go, as a distinct tool, for what it bounds and attributes.** One call can
  hold the whole model-visible answer of up to 20 reads under a stated cap, say
  per item what is missing and how to continue, give each file a version, fold
  duplicates and carry one envelope, one warning set and one journal
  observation. Today none of that is true: `brain_read` over MCP has no cap at
  all, and parallel reads add up with no limit. The contract below is the input
  [#3642](https://github.com/schlessera/brain-kit/issues/3642) builds.
- **No-go for any efficiency claim.** For the same content the prototype's
  answer is *larger* than the individual reads: its per-item version and size
  metadata cost more than the ~75-character MCP envelope or the Pi transcript
  wrapping it replaces. Parallel `brain_read` calls already return in one
  assistant message and one follow-up request, which is the grouping a batch
  would give. A batch only comes out smaller when its cap cuts content, and
  that content then needs a follow-up. A dependent outline-then-section read
  still takes two rounds.
- **Model usability is inconclusive (not measured).** No authorized real-model
  trial ran, so nothing here says whether a model, `gpt-6.1-terra` included,
  chooses the tool, fills it correctly or reads its outlines. That gates
  recommending the tool (see [Rollout](#rollout-and-verification-gates)). It
  does not gate building it.

Measured on 2026-11-08 at epic branch `2ed20c3be` (main `1619741f2` plus one
project-sync commit), with Bun 1.4.4, `@modelcontextprotocol/sdk` 1.30.1 and
`@earendil-works/pi-ai`/`pi-agent-core` 0.99.2. No production tool, schema or
contract changes. The prototype is private to the harness.

## What was compared

The harness is [`experiments/bounded-read-contract.test.ts`](../../experiments/bounded-read-contract.test.ts).
Its plain measurement helpers are in [`experiments/bounded-read/measure.ts`](../../experiments/bounded-read/measure.ts),
written so the multi-query search spike (#3645) can reuse them. The private
prototype was `experiments/bounded-read/prototype.ts`; #3642 replaced it with
the shipped operation and removed it (see [Delivered](#delivered-in-3642)).
The scenarios are [`experiments/bounded-read/scenarios.ts`](../../experiments/bounded-read/scenarios.ts).

**Scenarios.** Odysseus documents generated from fixed text, so they are the
same bytes on every run, written into a copy of the core fixture corpus with
the pinned date `2026-07-12`:

| Scenario | What it stresses |
| --- | --- |
| small files | four corpus project, focus and identity notes |
| large frontmatter | a crew ledger with 600 frontmatter entries (20,015 chars) and a two-heading body |
| many headings | a 241-heading passage log |
| huge lines | 70,612 chars of star bearings on one line, no headings |
| mixed scripts | Greek, CJK, an astral emoji, quotes, backslashes and tabs (3,978 chars, 5,118 UTF-8 bytes, 4,418 chars once JSON-escaped) |
| late-document update | a raft build log that gains a `2026-07-12 Launch` section between an outline and its follow-up |
| missing and refused | a missing file, `..`, an absolute path, a symlink out of the root, a directory and an unknown section |
| sections | three sections, matched case-insensitively |
| duplicates | the same path spelled twice and the same section in different case |
| aggregate overflow | twenty 1,450-char notes, more than one default result holds |

**Tasks.** All four are known-path retrieval. Discovery is not measured here;
it is #3643 and #3645. One task is a dependent follow-up:

| Task | Reads |
| --- | --- |
| `overview-small` | 4 small files |
| `sections` | 3 sections |
| `overflow-20` | 20 notes |
| `outline-then-section` | an outline (`max_tokens: 500` for `brain_read`), then the `Day 17` section, which depends on it |

**Arms.** Sequential `brain_read` calls, parallel `brain_read` calls and the
prototype batch, each repeated five times:

- **MCP**: the real keyless stdio server (`brain mcp`) against the scenario
  corpus. A recording wrapper on the client transport logs every JSON-RPC
  message. The prototype is not a served tool, so its response uses the
  framing the server's structured tools use (`structuredResult`,
  `packages/core/src/mcp-server.ts:165-168`). Its latency is in-process.
- **Pi**: `runAgentLoop` from `pi-agent-core` with `pi-ai`'s faux provider,
  executing the curated `brain_read` from `createBrainTools`. The faux provider
  is **scripted**. Its tool choices and request count show runtime mechanics
  only: they are not evidence that a model would choose or understand a tool,
  and they are not provider-request savings. Arms: all calls in one assistant
  message (Pi's default `parallel` execution; the Pi backend does not override
  it), the same with `toolExecution: "sequential"`, one call per assistant
  message, and the prototype as an in-test tool.
- **Journal**: the real `createTurnJournal` over the native journal test
  fixture, with four `brain_read` results and one batch result.

**Unavailable.** Provider input, output and cache tokens, cost, actual
provider-request grouping and model usability. Rows carry the `UNAVAILABLE`
marker rather than a zero. "Context chars" in the Pi table is Pi's internal
transcript JSON as the scripted provider received it. It is not a provider's
wire format or token count, and timing overlap is not provider-response
identity. The Claude backend's host-inclusive overhead (the Agent SDK's
result handling) was not exercised, because it has no offline fixture for an
MCP read.

## Results

Characters are UTF-16 code units. Byte counts are listed where they differ.

### MCP stdio

| Task | Calls (individual / batch) | Individual payload | Individual responses on the wire | Envelope per call | Batch payload | Batch response, modelled | Latency ms, median (seq / par / batch) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| overview-small | 4 / 1 | 3,540 | 3,963 | 74 | 4,530 | 9,406 | 1.3 / 0.8 / 0.3 |
| sections | 3 / 1 | 645 | 886 | 74 | 1,404 | 3,018 | 8.0 / 5.0 / 3.5 |
| overflow-20 | 20 / 1 | 29,022 | 30,762 | 75 | 23,982 | 48,865 | 7.1 / 2.6 / 5.8 |
| outline-then-section | 2 / 2 | 6,923 | 7,332 | 75 | 8,399 | 18,455 | 45 / 39 / 31 |

- Parallel calls still send one JSON-RPC request per read. They overlap on the
  pipe and save wall time, nothing else.
- The batch payload is larger for the same content: 4,530 against 3,540 chars
  for four small files, 1,404 against 645 for three sections. The difference
  is the per-item `sha256`, `bytes`, `chars` and `est_tokens` fields, about 170
  chars an item, against the 74-char envelope of a `brain_read` response.
- `structuredResult` sends the JSON twice, as a text copy and as
  `structuredContent`, so a structured batch is about twice its payload on the
  wire. The cap bounds each copy, not the pair.
- On `overflow-20` the batch held 13 notes whole, 6 as outlines and 1 as a
  `budget_exhausted` stub, all within 23,982 of its 24,000 chars. The
  individual reads returned everything (29,022 chars) with no bound.
- Latency is sub-millisecond to tens of milliseconds on a warm host, dominated
  by parsing for outlines. It is reported, not relied on.

### Pi agent loop (scripted provider)

| Task | All calls in one message | One call per message | Prototype batch | Max concurrent `brain_read` executions |
| --- | --- | --- | --- | --- |
| overview-small | 2 requests, 5,768 transcript chars, Σ context 7,669 | 5 requests, 6,751, Σ 20,641 | 2 requests, 6,024, Σ 8,538 | 4 |
| sections | 2, 2,508, Σ 4,411 | 4, 3,164, Σ 10,055 | 2, 2,799, Σ 5,314 | 3 |
| overflow-20 | 2, 36,612, Σ 38,513 | 21, 42,879, Σ 469,565 | 2, 26,678, Σ 29,192 | 20 |
| outline-then-section | 3, 8,985, Σ 19,865 | 3, 8,985, Σ 19,865 | 3, 11,656, Σ 25,783 | 1 |

"Transcript chars" is everything after the prompt: tool calls and their
results. "Σ context" adds up the context the scripted provider received on
each request. `toolExecution: "sequential"` gave the same transcript as the
parallel default, with concurrency 1.

- Pi already runs the calls of one message concurrently, so one message of
  reads costs the same two requests as one batch call. The large difference is
  between one message and **one call per message** (21 requests and 469,565
  context chars for 20 reads, because each request resends the growing
  history). That is a model behaviour no offline harness can measure, and
  nothing here shows a model would pick the batch over parallel calls.
- For equal content the batch transcript is 4–12% larger than the parallel one.

### Journal, cancellation and errors

- **Journal.** No backend proves where `brain_read` ran: Pi's
  (`provenToolExecution`, `packages/ui-backend-pi/src/worker-session.ts:29-37`)
  proves only `read_file`, `write_file` and `edit_file`. So
  (`toolObservation`, `packages/ui-server/src/brain/tool-observation.ts:37-42`)
  calls it `unproven`, and
  (`toolEnded`, `packages/ui-server/src/brain/turn-journal.ts:557-564`)
  observes every result and marks the turn lasting. Four reads made four
  observations, sequential or parallel. One batch call made one. That is a
  real host-side saving, small in time (8.3 ms against 1.4 ms on the fixture).
  It must come from the call count, never from adding the batch to
  `HOST_READS`: a read-only annotation is not proof.
- **Prototype cancellation.** Aborted while it reads, the batch stops before
  the next file (1 of 20 read) and rejects with no partial result.
- **MCP cancellation.** Cancelling one of four parallel reads rejects that call
  on the client and sends `notifications/cancelled`. All four server responses
  still arrived: `readDocument` is synchronous, so a cancelled read runs to
  completion and the client discards it.
- **Pi cancellation.** Aborting at the first `tool_execution_start` ran no
  read. Parallel mode stops preparing later calls, so the message's other
  calls got no tool result at all. The loop then called the stream function
  once more with the aborted signal, and the faux provider answered `aborted`.
  The batch arm behaved the same. Whether a real provider adapter sends
  anything on that last call cannot be observed offline.
- **Errors.** A missing file over MCP returns
  `Error: ENOENT: no such file or directory, open '<absolute path>'`: the host's
  brain root reaches the model. Refused paths and unknown sections give fixed
  messages. Prototype items carry a code and no host path.
- **Repeated warnings.** A stale-index warning (71 chars) rides on every
  individual MCP result. A batch would carry it once. Along the way the spike
  found that `brain index` counts a same-content rewrite as unchanged and
  keeps its old `indexed_at`, so
  (`indexStaleness`, `packages/core/src/lib/ops/staleness.ts:25-44`) keeps
  flagging the file until `brain index --force`.
- **Units.** Pi's (`clip`, `packages/ui-backend-pi/src/tool-kit.ts:29-32`)
  measures `string.length`, UTF-16 code units, but its limits are named
  `MAX_READ_BYTES` and `MAX_OUTPUT_BYTES` and its note says "bytes". The mixed-scripts
  document is 3,978 units and 5,118 bytes.

### Old single-read semantics

Unchanged, and the harness asserts it. With only a path, `brain_read` returns
the whole file however large: 70,612 chars for the huge line, over MCP. Pi
clips it at 100,000 chars
(`brainReadTool`, `packages/ui-backend-pi/src/brain-tools.ts:210-254`). The
`max_tokens` option stays a threshold, not a cap
(`readDocumentPart`, `packages/core/src/lib/document-parts.ts:152-199`): a
100-token threshold on the crew ledger returns a 20,190-char outline, almost
all of it frontmatter. #383 deliberately left those calls uncapped. The new
tool does not change them.

## A distinct tool, not an overload of `brain_read`

Both were considered. Overloading `brain_read` with a `requests` array:

- would make `path` optional and change the pinned input schema of a
  contract tool, a breaking change under `docs/integration-contract.md`;
- would make one tool answer raw text for one input and JSON for another, a
  shape a client can only predict by reading the input;
- would need a default cap for the array form and none for the path form, two
  meanings of one tool's limits, while #383 keeps the path form uncapped;
- would put a new behaviour under a name that permission defaults, the Pi
  allowlist and journal classification already key on, so it would inherit
  approvals given to the single read instead of being reviewed.

A distinct `brain_read_many` costs one more roster entry: 1,702 chars for the
proposed definition, against `brain_read`'s 1,258. That is input on every
provider request of a session that has it, cached or not. It is present from
the session's first request, so the provider-facing history stays
byte-identical within the session
([provider history](provider-history.md)). That cost is accepted with the
decision. #3642 should check it again before adding more description text.

## The contract #3642 builds

Every size below is counted in **UTF-16 code units of the serialized JSON
result**: `JSON.stringify(result).length`. That includes field names,
metadata, quoting and escaping. It is the unit
(`brainReadBaseResult`, `packages/ui-sdk/src/server/brain-read-base.ts:58-100`)
already budgets in. It is also the unit the Claude Agent SDK's 50,000-char
persistence threshold and its `length / 4` MCP token estimate count. UTF-8
bytes can reach three times that count and are reported only as measurements.
`est_tokens` is core's `estimateTokens` rule (`ceil(chars / 4)`), always
labelled an estimate and never a provider count.

**Name and surfaces.** `brain_read_many` on the MCP server and the Pi
backend, plus `brain read-many --json` in the CLI if #3642 adds a CLI form. All
are thin adapters over one core operation in `packages/core/src/lib/ops/`.
The paging primitive it shares with `brain_read_base` moves out of `ui-sdk`
(core cannot depend on a UI package) into `brain-common` or core, unchanged.

**Input.**

| Field | Type and bounds | Default |
| --- | --- | --- |
| `requests` | array of 1–20 request objects; more or fewer is rejected, never clamped | required |
| `requests[].path` | string, 1–1,024 chars, repo-relative | required |
| `requests[].section` | string, at most 512 chars; the heading's visible text, matched as `brain_read` matches it | the whole document |
| `requests[].offset` | integer ≥ 1: the line of the requested scope (document or section) to page from | none |
| `requests[].column` | integer ≥ 0: column inside the `offset` line; only with `offset` | 0 |
| `requests[].expected_sha256` | the `sha256` of an earlier item of this file | none |
| `max_total_chars` | integer 2,000–40,000 | 24,000 |
| `max_item_chars` | integer 512 – `max_total_chars` | 8,000, or `max_total_chars` if smaller |

A call is rejected whole, with no reads and a validation error, when the
schema fails or when the envelope plus a `budget_exhausted` stub for every
request does not fit `max_total_chars`.

**Envelope.** `{ items, truncated, max_total_chars, max_item_chars, warnings }`.
`items` keeps request order and `items[i].index === i`. `truncated` is true
when any item is not the whole of what it asked for. `warnings` holds the
call's tool warnings (config, module load, stale index) once. The whole
envelope is at most `max_total_chars` and every item at most
`max_item_chars`. Items are filled in request order. Before each item, the
call reserves room for a `budget_exhausted` stub for every request after it,
so a later request is never silently dropped. Request order is the caller's
priority.

**Items.** Every item has `index`, `path` (as given) and, when asked,
`section`, plus a `kind`:

| `kind` | When | Fields |
| --- | --- | --- |
| `full` | the requested document or section fits the item budget | `sha256`, `content` (byte for byte what `brain_read` returns for the same path and section) |
| `outline` | it does not fit and the scope has headings to choose between (a section needs a subheading) | `sha256`, `bytes`, `chars`, `est_tokens`, `frontmatter` (whole document only, and only if it fits whole; otherwise `frontmatter_chars`), `headings: [{ level, text, est_tokens }]` in document order while they fit, `omitted_headings`, `next: { offset: 1 }` |
| `partial` | it does not fit and has no headings to choose between, or `offset` was given | `sha256`, `bytes`, `chars`, `est_tokens`, `offset`, `column?`, `lines`, `returned_lines`, `text`, `next?: { offset, column? }` |
| `duplicate` | an earlier request resolves to the same file, section (casefolded), offset, column and expected hash | `of`: the earlier item's index; that item stands for both, whatever its kind |
| `error` | see the codes below | `code`, `message`, `sha256?`, `headings?` |

The prototype also put `bytes`, `chars` and `est_tokens` on `full` items. #3642
should drop them there: they are derivable from `content` and account for
most of the metadata cost measured above. `sha256` stays: it is the version a
follow-up needs.

**Paging.** `partial` pages whole lines while they fit, then the fitting prefix
of the next line, cut on a code point. A page starts at `offset`/`column`
within the scope, and joining every page's `text` reproduces the scope
exactly. The harness checks this for the huge line (43 pages of 2,000 chars),
the mixed scripts and the passage log. A continuation sends `expected_sha256`.

**Errors.** One item's error never fails the call. The codes are
`refused` (absolute, `..`, colon or backslash segment, or a link out of the
root: the same rule as `safeResolve`), `not_found`, `not_a_file`,
`too_large` (file over 4 MiB, checked again after the read), `work_limit`
(the call has read 16 MiB of distinct files), `read_failed`,
`section_not_found` (with as many `headings` as fit), `source_changed` (the
file's hash differs from `expected_sha256`; the current `sha256` is included),
`bad_offset` and `budget_exhausted`. Messages are fixed text and never contain
a host path.

**Versions.** Each distinct file is read once per call, so all items of one
file describe the same version. `sha256` is the SHA-256 of the file's bytes,
the same hash `brain_read_base` calls `expectedBaseHash`. Across calls, an
outline followed by a section read with `expected_sha256` gets
`source_changed` instead of a section of a newer file. Plain `brain_read` has
no such signal.

**Work and cancellation.** At most 20 items, 4 MiB per file and 16 MiB per
call. The operation is asynchronous and checks the signal before and after
each file read. A cancelled call rejects with no partial result. MCP adapters
pass the request's abort signal; Pi passes the tool's.

**MCP representation.** Return the JSON once, as text content, with no
`outputSchema`. A structured result would double the wire size and leave it
unclear which copy a client shows the model. If #3642 needs `structuredContent`
for a client, the cap applies to each copy, and the doubled wire size has to be
accepted and documented.

**Safety classification.** `readOnlyHint: true`, plus the same permission
default as `brain_read` in each backend, reviewed explicitly for the new name.
The journal classification stays `unproven`: no entry in `HOST_READS`, and no
proof path, unless a separate decision gives `brain_read` and this tool real
execution proof.

## Rollout and verification gates

1. **#3642 ships the tool** with the contract above, additive, on MCP and Pi
   together (a wrapper on one surface is not parity). It needs a `CONTRACT:`
   commit updating the integration-contract component, the MCP input-schema
   snapshot (`packages/core/tests/mcp-input-schemas.json`), the 24-tool
   roster tests and the Pi tool roster fixture, plus a minor changeset.
2. **Test gates in #3642**, each with a failing-first or mutation receipt:
   the total and item caps over every scenario here, at the default and at
   2,000/512 chars; the tight-total case where error items outgrow their stub
   reserve; `full` items equal to `readDocument`; discriminators per scenario;
   exact reconstruction across pages; `source_changed` on the late update;
   duplicate folding with one read per file; refused and missing paths with no
   host path; whole-call rejection of invalid input; cancellation between
   files; and the old `brain_read` assertions unchanged. The harness's
   mutation list is the starting set (see the spike PR).
3. **Provider history.** The keyless provider-history guard runs with the new
   tool on the roster, so tools and system prompt stay byte-identical across a
   session's turns.
4. **Do not recommend it yet.** No skill, system-prompt or description text
   steers agents from parallel `brain_read` to the batch until a real-model
   trial measures choice, argument correctness and outline follow-ups.
   `gpt-6.1-terra` is one model to run. The trial must record the exact
   model, route, settings and fixture identities, and report provider tokens,
   cache and cost from the provider's own usage. Until then the tool is
   available, not preferred.
5. **Revisit** the metadata cost if the trial shows the batch is chosen mainly
   for small-file overviews, where it is the larger answer.

<a id="delivered-in-3642"></a>

## Delivered in #3642

#3642 ships the contract above as `brain_read_many` on MCP and pi and as
`brain read-many --json`, over one core operation
(`readMany`, `packages/core/src/lib/ops/read-many.ts:426-480`). The
integration contract is
[Bounded multi-read](../integration-contract/mcp.md#bounded-multi-read-additive-0450-3642).
The harness now drives that operation, calls the served tool over stdio and
executes pi's roster tool; the prototype is gone.

**Details this record left open, as #3642 decided them:**

- `full` items carry `sha256` and `content` only, as recommended above.
  `bytes`, `chars` and `est_tokens` stay on `outline` and `partial` items and
  describe the requested scope (the document or the section), not the file.
- `truncated` is true for an `outline`, an `error`, or a `partial` with a
  `next`. A last page completes its request.
- An outline that could hold no heading is not returned; the scope is paged
  instead, so the item always offers a choice or makes progress.
- `bad_offset` also covers a `column` at or past the end of its line and a
  `column` that splits a surrogate pair. `expected_sha256` must be 64
  lowercase hex characters, or the call is refused.
- A request whose own `budget_exhausted` stub exceeds `max_item_chars` (a
  1,024-character path of characters JSON escapes) refuses the whole call,
  like a total too small for every stub.
- The paging primitive was not moved out of `ui-sdk`. `brain_read_base` stays
  untouched, and its pager stops before a line that does not fit, while this
  one fills the rest of the page with that line's prefix. The two share the
  line-splitting and code-point rules, not code.
- MCP returns the envelope once, as text, with no `outputSchema` or
  `structuredContent`. The read tools' warnings ride in the envelope once,
  not as a second content block. The CLI prints the same envelope as compact
  JSON and has no warnings; neither has pi.
- Each surface resolves requests with the resolver its `brain_read` uses
  (`safeResolve` in core, pi's `resolveInRepo`, the same rule). Pi's tool
  records no write base: a retrieval hash is not a hosted write receipt.
- Placement in the backends: auto-allowed wherever `brain_read` is, in the
  Claude voice posture ([voice-permission.md](voice-permission.md)), among the
  named reads that take no lock, at the index barrier, replayable as a read on
  inbox yield, and in the `file_read` roadblock family. It is not a schedule
  tool, not in `HOST_READS` and has no execution proof: the journal observes it
  as `unproven`, as it does `brain_read`.
- The listed definition is 1,706 characters, about the 1,702 estimated above
  (the first draft, with longer field descriptions, was 2,252). The description
  states behaviour and does not recommend the tool over parallel reads.

**Re-measured** on 2026-11-08 with the served tool, the same scenarios and
five repeats (MCP stdio, characters):

| Task | Calls (individual / batch) | Individual payload | Individual responses on the wire | Batch payload | Batch response on the wire | Latency ms, median (seq / par / batch) |
| --- | --- | --- | --- | --- | --- | --- |
| overview-small | 4 / 1 | 3,540 | 3,963 | 4,362 | 4,661 | 1.9 / 1.8 / 10.2 |
| sections | 3 / 1 | 645 | 886 | 1,283 | 1,452 | 8.1 / 5.1 / 4.1 |
| overflow-20 | 20 / 1 | 29,022 | 30,762 | 23,921 | 24,592 | 7.4 / 2.3 / 20.2 |
| outline-then-section | 2 / 2 | 6,923 | 7,332 | 8,358 | 9,965 | 39 / 33 / 44 |

- The conclusion stands: for the same content the batch is larger (4,362
  against 3,540 chars for four small files), and smaller only where its cap
  cut content (`overflow-20` held 14 notes whole, 1 as an outline and 5 as
  `budget_exhausted` stubs). Dropping the size fields from `full` items cut
  the batch payload by 4–9% against the prototype; text-only output cut
  the wire response to about half the modelled one.
- Served, the batch is no faster: its median latency is higher than parallel
  reads in three of four tasks. These are warm-host medians of five runs
  and support no ranking.
- Pi (scripted faux provider): one batch message and one message of parallel
  reads both take two requests; the batch transcript is 1–7% larger for
  the two equal-content tasks, 30% larger for `outline-then-section` (its
  outline is structured JSON, not `brain_read`'s outline text) and 28% smaller
  for `overflow-20`, where its cap cut. Its
  first request is 1,557 chars larger, the size of the added tool definition,
  which every request of a session carries.
- One journal observation per batch call against one per read, as before.
- Provider tokens, cache, cost and model usability remain unavailable. Gate 4
  still holds: nothing recommends the tool until a real-model trial.

## Limits of this evidence

Offline only, on one host, with synthetic Odysseus documents and four
known-path tasks. There are no provider tokens, cache, cost or real-model
trials. Pi's provider was scripted. The MCP batch response is modelled, not
served. The latency numbers are warm-host medians of five runs and support no
ranking. Discovery, search fan-out (#3645) and graph traversal (#3646) are
out of scope. The Claude backend's host path was not exercised.

## Follow-ups found

These are recorded for filing, not done here:

- MCP `brain_read` puts the host's absolute brain root in its `ENOENT` error
  text.
- `brain index` leaves a same-content rewrite flagged as stale until
  `--force`, so every MCP read result carries the warning.
- Pi's `clip` limits are named and reported in bytes but counted in UTF-16 code
  units.

## Reproduction

```sh
bun run build   # the experiment tier needs the built workspace
BRAIN_BOUNDED_READ_EVIDENCE=/path/to/evidence.json \
  bun run test experiments/bounded-read-contract.test.ts
```

The environment variable is optional. With it set, the run writes the raw
rows behind every table above (each arm, repeat timings, wire totals, envelope
sizes and the unavailable markers) to that file.
