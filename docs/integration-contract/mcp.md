# Integration contract — MCP tools

Authoritative component of the [integration contract](../integration-contract.md).
Its [shared scope and versioning policy](../integration-contract.md) apply to every section below.

<a id="mcp-server-stdio-brain-mcp-or-srcmcp-serverts"></a>

## MCP server (stdio, `brain mcp` or `src/mcp-server.ts`)

Tool names and input schemas are stable:

| Tool | Annotations | structuredContent |
|------|-------------|-------------------|
| `brain_search` | readOnly | `{ results, warnings }` — each result is `{ path, title, type, relevance, status, summary, updated, deadline, tags, score, snippet, supersededBy? }`; every field after `type` may be `null`. `status`, `summary`, `updated` and `deadline` are additive in 0.38.0. `supersededBy`, the path of the document that `supersedes` this one, is present only when one does (additive in 0.38.0) |
| `brain_context` | readOnly | `{ context, warnings }` |
| `brain_read` | readOnly | none — the first `content` block is the file text, verbatim; with `section`, that section; over `max_tokens`, the frontmatter and an outline of headings with estimated token counts. `max_tokens` is the threshold that switches to the outline, not a cap on the output: a large frontmatter or very many headings give an outline larger than it |
| `brain_list` | readOnly | `{ documents, warnings }` |
| `brain_graph` | readOnly | `{ edges: [{ source, target, resolved }], nodes: [{ path, title, type, summary, updated }], warnings }`. `nodes` holds one entry, sorted by `path`, for every document an edge touches: each `source`, and each `target` whose `resolved` is `true`. An unresolved target is raw link text and never a node. `summary` and `updated` may be `null`. `nodes` is additive in 0.38.0 |
| `brain_add` / `brain_update` / `brain_archive` | non-destructive, idempotent (update/archive) | result object |

`brain_search`, `brain_list` and `brain_graph` repeat their structuredContent
as the first `content` block, and the write tools return their result object
there. Both are compact JSON, with no indentation or line breaks (since
0.38.0). `brain_context`'s first block is the context text itself.

The server sends `instructions` at `initialize` (additive in 0.38.0). They
are descriptive, not frozen: the wording may change in any release, so a
client may show them to an agent but must not parse them. Today they say the
brain is the source of truth for facts about its owner, named from
`profile.name` when the config sets it and otherwise "the person it belongs
to". The name goes in as quoted data: whitespace, control and format
characters collapse to single spaces and it is capped at 80 characters, so a
config value cannot add lines of its own. They point to `brain_search`,
`brain_context`, `brain_read` and `brain_graph` for reading, and `brain_add`
and `brain_update` for writing, and say that `brain.db` is never edited
(`serverInstructions`, `packages/core/src/mcp-server.ts:77-89`). Tool descriptions are descriptive in the
same way. The read tools' descriptions state their defaults and the server
caps: `brain_search` `limit` at 50 and `brain_graph` `depth` at 5, and
`brain_list`'s accepted `limit` range of 1 to 100.

The input schemas, as `tools/list` reports them, are pinned in
[`packages/core/tests/mcp-input-schemas.json`](../../packages/core/tests/mcp-input-schemas.json)
with descriptions left out; `mcp-contract.test.ts` fails when a tool's schema
drifts from it. `?` marks an optional input; a default is given where the tool
applies one:

| Tool | Inputs |
|------|--------|
| `brain_search` | `query`, `type?`, `tag?`, `relevance?`, `mode?` (`fts`\|`vector`\|`hybrid`, default `hybrid`), `rerank?` (`none`\|`heuristic`\|`jev`; omitted → the configured provider when `reranker.enabled` is true and available, otherwise local heuristic. An explicit `jev` cannot enable judgment while off; it warns and falls back. 0.39.0 added `jev` and dropped the schema default of `heuristic`), `include_archived?` (default `false`), `assets_only?` (default `false`), `limit?` (default `10`), `updated_since?`, `updated_before?`, `deadline_from?`, `deadline_to?` (`YYYY-MM-DD`, inclusive), `sort?` (`score`\|`updated`\|`deadline`, default `score`), `upcoming?` (default `false`) — the six date inputs added in 0.38.0, additively; an invalid date is a tool error |
| `brain_context` | `query`, `max_tokens?` (default `4000`), `include_identity?` (default `true`), `include_current_focus?` (default `true`) |
| `brain_read` | `path`, `section?` (a heading's visible text, compared under Unicode canonical caseless matching (full case folding); the body is parsed as GFM, and only top-level ATX and setext headings count, never one inside code, HTML, a table, a list or a blockquote; the section runs to the next heading of the same or higher level; of two equal headings the first is returned; an unknown one is an error naming the document's headings), `max_tokens?` (positive safe integer; the threshold for the outline, not an output cap; no default, so the whole file comes back unless it is given). Both additive in 0.38.0 |
| `brain_list` | `type?`, `tag?`, `status?`, `relevance?`, `limit?` (integer `1`–`100`, default `20`; the schema says `"type": "integer", "minimum": 1, "maximum": 100`. A fraction, `0`, a negative or a value over `100` is rejected as invalid input, a tool result with `isError: true` and no `structuredContent`, the convention every schema violation follows. **Breaking in 0.41.0 (#1351):** the schema was a plain `number` and the server clamped the value into 1–100, so `0` listed 1 and `500` listed 100) |
| `brain_graph` | `path`, `depth?` (default `1`), `direction?` (`outgoing`\|`incoming`\|`both`, default `both`) |
| `brain_add` | `content`, `type?`, `title?`, `tags?` (comma-separated) |
| `brain_update` | `path`, `summary?`, `status?` (`active`\|`archived`\|`draft`), `relevance?` (`primary`\|`secondary`\|`historical`), `tags?` (comma-separated, replaces), `deadline?`, `next_review?` (ISO 8601; `""` removes), `append_content?`. Setting `status: "archived"` applies `brain_archive`'s relevance rule to the effective relevance (the `relevance` passed in the same call, else the document's): a `primary` or missing one becomes `historical` and `"relevance"` is listed in `changes`; an explicit `secondary` or `historical` stays (additive in 0.38.0) |
| `brain_archive` | `path`, `dry_run?` (default `false`) |

Read tools append an index-staleness warning when markdown files are newer
than their `indexed_at`.

<a id="hosted-authoritative-application-tools"></a>

### Hosted authoritative application tools

Hosted turns route authoritative Markdown through the server-owned application
boundary. Standalone terminal `brain mcp` names and schemas above are unchanged.
Claude registers the tools below under `mcp__brain-ui__`; pi uses the unprefixed
names. Hosted Claude disallows project `mcp__brain__brain_add`,
`mcp__brain__brain_update` and `mcp__brain__brain_archive`, plus built-in raw
writers; its server tools apply the validated effects instead.

| Tool | Exact input (unknown keys refuse) |
| --- | --- |
| `brain_read_base` | `{ path: string }`; returns `{ content: string, expectedBaseHash: string }` |
| `brain_add` | `{ content: string, type?: string, title?: string, tags?: string[], target?: string, expectedBaseHash?: string \| null }`; deterministic server capture plans and validates its current base when absent |
| `brain_update` | `{ path: string, expectedBaseHash: string \| null, summary?: string, status?: "active" \| "archived" \| "draft", relevance?: "primary" \| "secondary" \| "historical", tags?: string[], deadline?: string, next_review?: string, append_content?: string }` |
| `brain_archive` | `{ path: string, expectedBaseHash: string \| null, dry_run?: boolean }` |
| `write_file` | `{ path: string, expectedBaseHash: string \| null, content: string }` |
| `edit_file` | `{ path: string, expectedBaseHash: string \| null, old_string: string, new_string: string }`; nonempty old string must occur exactly once |
| `apply_staged_changes` | `{ files: [{ path: string, expectedBaseHash: string \| null, content: string }] }`; 1–32 unique named files, no command field |

Hashes are lowercase SHA-256 of complete UTF-8 bytes; `null` means exclusive
creation. Pi may omit a tool's base hash only when a preceding read in the same
turn supplied it; a write with no read is create-only. The server application
request is `{ principalId, turnId, input: { operation, ...toolInput } }`;
identity is bound by the trusted host, never taken from tool arguments. Operations
are `add`, `update`, `archive`, `write`, `edit` and `staged` only. No command replay,
filesystem handle, policy-derived authority or standing grant is accepted.

The request and combined proposed Markdown each have a 1,048,576-byte UTF-8 bound.
The Markdown operations support only ordinary UTF-8 `.md` files. The separate
PNG mask application below is the sole binary exception. Paths are exact root-relative names,
up to 1,024 characters: no traversal, hidden path components, backslashes or
control characters. Policy paths and ancestors (including case/Unicode variants),
symlinks, multiple-link files and changed directory topology refuse. Existing
content must match the exact stated base, including after approval/lock admission.
Unsupported hosts refuse; descriptor-anchored I/O currently requires Linux procfs.

Every call rechecks current principal/turn authority and operation membership.
Archive and an update setting `status: "archived"` retain their explicit permission;
ordinary permitted writes/edits add no confirmation. Voice retains capture and
append/update, excludes archive/raw/staged writes, and cannot grant. Unattended
rosters supply no new authoritative grant. Direct backend calls without an
application bridge retain their existing enforced roster, permission checkpoints
and writer-yield behavior. Hosted routing begins when the host binds that bridge.
Cancellation before commit changes no
Markdown; the synchronous commit burst completes before cancellation can interleave.
All effects actually reaching Markdown are recorded, including a partial I/O
failure. Disposable-index failure after commit does not report the write as absent.
The in-process lock does not coordinate external terminal writers.

Application results are `{ ok: boolean, message: string, changes:
[{ path: string, contentHash: string | null }], code?: string,
indexed?: boolean, outcome?: object }`. A null result hash denotes a removed
source. `changes` names only committed effects. A refused result is visible to
the agent and recorded as a server-authored `brain_application` activity event;
policy denial, alias denial, topology change, stale base, revoked authority,
membership, permission, invalid request, unsupported kind/host, payload and
cancellation errors never silently merge or replay. Error codes are additive;
consumers tolerate unknown codes. Claude wraps the result in MCP text with
`isError: !ok`; pi returns successful results as text/details and throws refused
results through its existing tool-error path.

CLI commands encountering `EROFS` exit 2. On Linux, known write forms also
refuse a read-only brain mount before entering handlers which collect per-file
errors; dry-run forms and read-only commands remain available. Machine mode emits
`{ schema_version: 1, ok: false, error: { code: "read_only_brain", message: string,
tool: string } }`. The message states that the brain is read-only here and names
`brain_add`, `brain_archive`, or `apply_staged_changes` for the corresponding
hosted effect, including the Claude spelling. Nothing is staged or replayed;
read-only commands continue to work. Writable index connections retain SQLite WAL
sidecars after clean close, so a read-only mount can read the checkpointed index
without recreating sidecars. Human mode prints the same message to stderr.

<a id="hosted-png-mask-application-additive-1037"></a>

### Hosted PNG mask application (additive, #1037)

Claude hosted turns run the CLI and its descendants inside the mandatory isolated
worker, including project stdio MCP servers. A failed boundary probe refuses before
runtime initialization. Hosted brain writes use the structured tools above instead
of built-in Write, Edit and NotebookEdit; unsupported notebook effects refuse.
Scratch is separately writable. Ordinary sessions persist and resume native JSONL
transcripts outside the brain through parent-owned, alias-refusing snapshots.

`BackendBridge.applyImageMask?(input: BrainMaskInput)` is the narrow binary
application callback. `BrainMaskInput` is `{ imagePath: string, maskPath: string,
png: Uint8Array }`; `BRAIN_MASK_MAX_BYTES` is 8,388,608. It returns the existing
`BrainApplicationResult`. The host binds principal and turn identity and accepts
only the exact bytes returned by that turn's browser editor. No worker-supplied
identity, arbitrary binary kind, command or destination is accepted.

Only PNG-signature bytes within the cap may replace the submitted existing image's
backend mask filename (Claude: `raft-mask.png`; pi: `raft.mask.png` for `raft.png`),
selected by the server’s backend identity, beside the source or
under `.brain/scratch`. Image and previous mask hashes are captured before the
editor opens and rechecked under the application lock and immediately before
commit. Policy/ancestor paths, traversal, hidden metadata outside scratch,
symlinks, multiple-link files and changed directory topology refuse. Authority,
turn membership and cancellation are rechecked at application time; voice cannot
request or apply masks. Scratch prerequisites are unchanged. Scratch pruning runs
under that same authority/lock and records actual removals alongside the mask.

The existing `request_image_mask` name, input and result remain unchanged. Its
`maskPath`, `imagePath`, `bytes` and `note` still describe the saved PNG. Refusals
change no files and appear as tool errors and recorded application results.
Only committed effects enter `changes`, including an effect followed by a later
I/O or prune failure. PNG effects do not enter the disposable Markdown index.
The Markdown byte cap and supported file kinds above remain unchanged.

<a id="chat-ui-in-process-tools-mcp__brain-ui__"></a>

### Chat-UI in-process tools (`mcp__brain-ui__*`)

The chat-UI backends register an in-process MCP server under the `brain-ui`
key; its tool names are equally stable. `ask_user`, `ask_user_form` (additive in 0.40.0), `ask_user_rank` (additive in 0.40.0), `ask_user_list` (additive
in 0.40.0), `get_current_location` and `request_image_mask` bridge to the
connected browser. `query_activity`
(read-only) reads the host's activity record — scopes `running` | `recent` |
`run` | `rollups` | `inbox`; results are wrapped in a data-only delimiter
(nonce-suffixed per call) because they can contain free text from past runs.
`show_block` (side-effect free, always registered) renders one of the kit's
answer blocks inline in the answer, or the follow-ups the model offers under
it (`suggestions`); it validates its argument and echoes it, and rejects a `link` block whose
address the link policy refuses, and a `tracker` block with any event whose address it refuses.
The eight bridge tools are declared once as **tool contracts** in
`@schlessera/brain-ui-sdk/tool-contracts` (also re-exported from `/server` and
`/client`); their names and Claude-side input schemas are stable.

**Schema representation (#563):** `show_block` now writes its unchanged
`tone`, `valueTone` and `icon` inputs once as shared definitions, and omits
field descriptions already stated by the tool description. The Claude MCP
listing uses draft-7 `definitions` and local `$ref`; Pi uses draft-2020-12
`$defs` and local `$ref`. Consumers resolve these references according to the
advertised schema dialect. Tool names, accepted fields, validation, handler
results and rendered blocks remain unchanged; this representation update ships
in a minor without a `schema_version` change. The choice and measured limits
are recorded in [the design-kit decision](../decisions/design-kit.md).

<a id="tool-component-contracts"></a>

### Tool component contracts

A contract is `{ name, description, input, brief }`, plus `payload` when the
tool's result is meant to be rendered as a component rather than read as text:

| Contract | Payload in `output` | Rendered as |
|---|---|---|
| `ask_user` | `{ questions, answers, annotations? }` | the picker's answered state |
| `ask_user_form` (0.40.0) | `{ answers, visibleNodes }` — typed answers by visible node id; the request is not echoed | one conditional form and its visible-path answered record |
| `ask_user_rank` (0.40.0) | `{ order, unchanged }` — every requested id exactly once; the request is not echoed | final numbered order rebuilt from input and result |
| `ask_user_list` (0.40.0) | `{ answers, skipped, notes? }` — the request is not echoed | the list card's answered record, rebuilt from the call's input plus this |
| `get_current_location` | `{ latitude, longitude, accuracyMeters, place?, address?, addressComponents?, note?, retrievedAt }` | a map card: the fix as a pin, the shoreline from `GET /api/geo/coastline` when the server has it |
| `request_image_mask` | `{ maskPath, imagePath, bytes, note }` | a mask result |
| `query_activity` | **none** | prose in a nonce-delimited data block |
| `show_block` | `{ block }`, the validated input echoed | the block, inline at the call's position in the answer; `suggestions` alone is drawn under the answer instead |

<a id="ask_user_form-additive-in-0400"></a>

#### `ask_user_form` (additive in 0.40.0)

- **Input:** `{ prompt, nodes }`, a flat list in display order. Every node has
  a unique `id` (1–64 characters), `kind`, `prompt` (1–300), optional `header`
  (up to 12) and `required` (omitted means `true`). `single` and `multi` add
  `options[2..]{label (1–40), description? (≤120), preview? (≤4000)}`.
  `scale` adds the list tool's `scale`, `items` and optional `notes`;
  `rank` adds the rank tool's `items` and optional `cutoff`; `text` needs no
  additional fields. Scale and rank retain their existing per-node item caps
  (30 and 15); scale retains its 2–8 options. Duplicate node/item ids or
  option labels, and invalid cutoffs, are refused before displaying a card.
- **Conditions:** optional `showIf: { node, anyOf }` names an earlier
  `single`/`multi` node and one or more labels offered by it. A multi parent
  matches any selected label. An unknown/later parent, non-choice parent or
  unoffered label is refused. A hidden ancestor hides all descendants;
  automatic Other input never reveals a branch, even when its text matches
  an offered label.
- **Limits:** `AskUserFormLimits` exposes exactly `maxDepth`, `maxNodes` and
  `maxOptions`, defaulting to 3 (root is depth 1), 12 and 8. Hosts may pass
  `WsHostOptions.askUserFormLimits`; the server accepts
  `BRAIN_UI_ASK_USER_FORM_MAX_DEPTH`, `BRAIN_UI_ASK_USER_FORM_MAX_NODES` and
  `BRAIN_UI_ASK_USER_FORM_MAX_OPTIONS`. Set values must be positive safe
  integers (`maxOptions` at least 2); invalid values refuse startup. Both
  backend handlers validate using the host's limits, and the host validates
  before emitting. Raising `maxOptions` raises the choice cap; the scale's
  native 8-option cap remains. There is no independent aggregate-items cap.
- **Result:** `{ answers, visibleNodes }`. `answers` contains only answered
  visible nodes, with these values: single `{ value, other? }` (`other: true`
  marks custom input); multi `{ values, other? }` (`other` is custom text);
  scale `{ answers, skipped, notes? }`; rank `{ order, unchanged }`; text is
  a trimmed string, at most 280 characters. The handler recomputes visibility,
  drops hidden/unknown answers and normalizes each kind. Required visible
  nodes must be complete; a required scale needs every row. An untouched rank
  returns the input order with `unchanged: true`. Rank answers must be a
  complete permutation, and `unchanged` is derived. `visibleNodes` follows
  input order, including unanswered optional nodes, distinguishing skipped
  from hidden. A supplied client `visibleNodes` is never trusted.
- **Frames:** `server_hello.capabilities.askUserForm` advertises support.
  Session/turn-scoped `ask_user_form_request` carries
  `{ requestId, prompt, nodes }`; `ask_user_form_response` carries
  `{ requestId, answers, turnId? }`. The SDK echoes the request's turn id.
  `ask_user_cancel` dismisses it; all four ask kinds share the cancellation id
  space. Pending forms survive a temporary disconnect and are re-delivered,
  and reject when the turn is cancelled. Unknown additive frame/node/answer
  fields survive wire parsing; validation and normalization still apply.
- **Backends:** optional `BackendBridge.askUserForm(requestId, spec)` returns
  `AskUserFormResult { answers }`; `askUserFormLimits` carries the host limits.
  Claude registers `mcp__brain-ui__ask_user_form` with `alwaysLoad`; pi registers
  `ask_user_form`. Both use the shared schema/handler, and withhold the card
  from turns declaring `noGrantSurface`. All existing ask tools remain.
- **Rendering/replay:** one outer card contains shared scale and rank rows,
  unindented branch slots and one Submit. Hidden answers are held locally for
  Undo/reselection, excluded from progress, submission and summary. Drafts are
  not persisted. Input plus result rebuilds the visible answered path after
  reload. Composer text remains an ordinary message. A dismissed exchange may
  reopen locally and send its visible answers as a new composer message.

<a id="ask_user_rank-additive-in-0400"></a>

#### `ask_user_rank` (additive in 0.40.0)

- **Input:** `{ prompt, items, cutoff? }`. There are 2–15 items in the
  suggested starting order. Each has a unique `id` (1–64 characters), a
  `label` (1–200), optional `detail` (up to 200) and `link` (up to 2,000).
  `prompt` is 1–300 characters. `cutoff` is an integer from 1 through the item
  count: only that prefix matters, but the response includes every item.
  Duplicate ids and a cutoff beyond the item count are refused before the
  host receives a request.
- **Result:** `{ order: string[], unchanged: boolean }`. `order` is a complete
  permutation of the requested ids; missing, repeated, extra or unknown ids
  are refused. The handler derives `unchanged` from equality with the input
  sequence, rather than trusting the client's boolean. The request is not
  echoed in the result.
- **Frames:** hosts advertise `capabilities.askUserRank` in `server_hello`.
  Session/turn-scoped `ask_user_rank_request` carries `{ requestId,
  prompt, items, cutoff? }`. `ask_user_rank_response` carries `{ requestId,
  order, unchanged, turnId? }`, with the same turn echo rules as other
  interactive responses. `ask_user_cancel` dismisses it too; request ids share
  the ask exchange namespace. Pending requests survive a temporary disconnect
  and are delivered again on reconnect, and reject when their turn is cancelled.
- **Backends:** optional `BackendBridge.askUserRank(requestId, spec)` returns
  `AskUserRankResult { order, unchanged }`. Claude registers
  `mcp__brain-ui__ask_user_rank`; pi registers `ask_user_rank`. Both use the
  shared schema/handler. A turn with no grant surface does not open a rank card.
- **Rendering/replay:** one kit `AskUserRankCard` supports handle drag,
  tap-to-pick/tap-to-place and keyboard moves. Below-cutoff rows retain contrast.
  The result plus the original tool input rebuild the answered numbered list.
  Composer text stays an ordinary message; there is no inferred typed ranking.
  Dismissed exchanges can reopen locally and send their new order as a normal
  composer message, without answering the old server request.

<a id="ask_user_list-additive-in-0400"></a>

#### `ask_user_list` (additive in 0.40.0)

One scale applied to a list of items, answered in one card (#583).

- **Input:** `prompt` (1-300), `scale[2..8]{label (1-40), description? (≤120)}`,
  `items[1..30]{id (1-64), label (1-200), detail? (≤200), link? (≤2048)}`,
  `allowSkip?` (default `true`), `notes?` (default `false`). Item ids and
  scale labels must each be unique; a duplicate is refused before any card is
  drawn. A `link` is shown only after the client's own `classifyLink` accepts
  it, with the host that parse yields; the model never supplies a host.
- **Result:** `answers` maps item id to the chosen option's label, `skipped`
  lists every other id in item order (the two always partition the list), and
  `notes`, present only when the input set `notes: true` and a note was
  written, maps item id to a note of at most 280 characters. A skipped item is
  absent from `answers`, never `""`, and may still carry a note. An answer
  naming an unknown id or an option not on the scale is dropped and the item
  counted as skipped.
- **Frames:** the host sends `ask_user_list_request` `{ requestId, prompt,
  scale, items, allowSkip, notes }` (defaults applied, session- and
  turn-scoped); the client answers with `ask_user_list_response` `{ requestId,
  answers, notes?, turnId? }`, or dismisses with the existing `ask_user_cancel`
  — request ids share one space across all ask kinds. A pending list survives
  a disconnect and is re-sent on reconnect, as an `ask_user` card is.
  `server_hello` advertises `capabilities.askUserList`.
- **Backends:** the bridge method is `BackendBridge.askUserList?` (`AskUserListResult
  { answers, notes? }`); a backend registers the tool when the host supplies it,
  and withholds it from a turn declaring `noGrantSurface`, as it does the mask
  editor, because the card needs someone to read it. It is not in the voice
  posture.
- **Composer:** a message typed while a list is pending is an ordinary
  message; it is not bound to the list.

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
| `files` | `items[1..20]{path (1-1024), reason? (≤240)}` | `RelatedFiles` |
| `map` | `title?` (≤60), `places[1..30]{label (1-80), lat? (-90..90), lon? (-180..180), meta? (≤40), source? (≤80), accuracyM? (>0, ≤100000)}`; `lat` and `lon` come together or not at all (additive in 0.39.0) | `PlaceMap`, planned by `planPlaces` |
| `graph` | `title?` (≤60), `nodes[2..20]{label (1-80), path? (≤1024), tone?, focus?}`, `edges[0..40]` index pairs `[a,b]`, `legend?[0..7]{label (1-40), tone?}`, `meta?` (≤40) | `GraphView`, deterministic client layout |
| `link` (0.39.0) | `url` (1-2048), `title?` (1-100), `description?` (≤240) | `LinkPreviewCard` (link mode) |
| `tracker` (0.41.0) | `events[1..20]{url (1-2048), action, qualifier? (1-60, trimmed, one line), title (1-200, trimmed, one line)}`, `action` one of `opened`, `closed`, `reopened`, `merged`, `labeled`, `commented`, `reviewed`; an event takes no other key | `TrackerPillList` |
| `suggestions` (0.39.0) | `label?` (1-24), `items[1..2]{label (4-80, trimmed, one line), icon?}` | the app's closing row, from `SuggestionChips`' data minus `tone` |

A `files` block (#1139) lists supporting local notes in payload order.
Paths and plain-text reasons are supplied by the agent; a reason is its claim,
and the block carries no retrieval scores or evidence that a file was read.
The live transcript and replay draw the list with the heading `Supporting
files`, clearing the kit's sample metadata. A permitted path opens the existing
authenticated file viewer in the current root only when the reader activates
that row. Absolute paths, URLs, schemes, backslashes, control characters,
query/fragment suffixes, empty path segments and `.`/`..` segments remain
readable without an open control. Missing files use the viewer's existing
unavailable-file error and never redirect to an alternative destination.
Static exports preserve every path and reason without interactive controls
or file requests. Malformed payloads retain the readable generic tool view.
The post-answer classifier does not infer this variant or supporting reasons.

A `graph` block (#1140) presents the agent's supplied nodes and relationships.
The host validates and echoes; it does not query the index or verify claims.
Edge indices must name distinct supplied nodes. Duplicate pairs, including
reversed pairs, are dropped; the first focused node wins. Unknown fields,
including coordinates and handlers, are discarded. Only supplied edges are
drawn: the kit's implicit focus spokes are disabled. Pure client layout
preserves indices and reserves room for wrapped labels. A textual node and
edge list is the accessible equivalent. Permitted brain file paths use the
existing file-link policy and current root's viewer; traversal and refused
paths stay plain text. No requests run while drawing the graph. Replay uses
the same block; static exports retain its full topology without file controls.
Optional title, legend and metadata never inherit kit sample defaults. Graphs
are not inferred by the answer classifier.

A `link` block's address passes `classifyLink` (`@schlessera/brain-ui-kit/links`)
twice. The handler rejects the call when it refuses the address, naming the
reason: `too-long`, `hidden-characters` (control, zero-width or bidi
characters, or leading and trailing space), `relative`, `unparseable`,
`scheme` (anything but `http:` and `https:`), `credentials` (any
`user:password@`), or `mixed-script` (a hostname label that fails UTS #39
Highly Restrictive). An echoed `link` payload is therefore one the policy
accepted when it was echoed. The payload parse on the client stays
structural, so a refused address that reaches a client anyway still parses,
and the card draws it as a withheld link with no anchor rather than falling
back to the generic view. The host is not a field: the card derives the host
it shows and the `href` it opens from one parse of `url`. Nothing is fetched
to draw the card, and it navigates only when the reader activates its Open
anchor (`target="_blank"`, `rel="noopener noreferrer nofollow"`, no referrer).

A `tracker` block (#1001) lists changes the agent reports it made to issues
and pull requests, one line each, in payload order. An event's repository,
number and item type are not fields: the kit derives them from a
GitHub-shaped `url` (`https://github.com/<owner>/<name>/issues/<n>` or
`.../pull/<n>`, optionally followed by a subpath, query or fragment), and any
other address shows only its title, its action and the host derived from the
`url`. An event carrying any key besides its four (`repository`, `number`,
`type`, `host`, …) is rejected naming the key, on the model's call and in the
client's payload parse alike. Each `url` passes `classifyLink` as a `link`
block's does: the handler rejects the call naming the event's 1-based
position and the reason (`refused tracker event 2: credentials`), and a
refused address that reaches a client anyway draws a withheld line with no
anchor. Every other line is an anchor to the parsed `href` (new tab, no
opener, no referrer); consecutive events with the same host and repository
share one header naming them; more than six events show five and a `Show
all N changes` control in the chat, while a shared image or PDF draws every
event with its title in full; and the list always ends with `Changes as reported
by the brain · tracker not checked`. Nothing is fetched to draw it. The
`qualifier` is the close reason, the label name or the review verdict, and
with the action it picks the line's tone (`merged`, `closed completed` and
`reviewed approved` teal, `opened` amber, `reopened` and `reviewed changes
requested` gold, everything else neutral); the action is always printed as
a word.

Layout knobs the kit components take (`labelWidth`, `barWidth`, `height`,
`timeWidth`, …) are not part of the contract: the surface decides them.

`map` is the one variant that is not handed to its component as it stands.
The model names places; how they are drawn is the surface's, and nothing in
the payload can set a span, zoom, box, height, tone, geometry or number.
`planPlaces` (`@schlessera/brain-ui-sdk/client`) turns the places into the
drawing, as a pure function a consumer may rely on:

- **Every place is a row, numbered 1..N in payload order**, in every mode.
  A place without `lat`/`lon`, at exactly `0, 0`, or past ±85° latitude is a
  row with a reason (`no position`, `0, 0 is usually a missing value`,
  `beyond the map's ±85°`) and no pin; a missing coordinate is never
  estimated. More than 30 places is a schema rejection, never a truncation.
- **The mode comes from the coordinates**: `list` when nothing is pinned or
  the pins' tightest arc crosses ±180°; `map` when one frame's envelope fits
  the geometry route's 5°; `pair` when the pins form exactly two groups
  (single linkage at 5° on both axes) that each fit; `list` otherwise. The
  reason line's distance is a haversine of the given coordinates, to three
  significant figures.
- **Each frame's geometry comes from `GET /api/geo/coastline`**, with the
  frame's `bbox` and `width=495`, the location card's route and cache. An
  empty answer or a failed request draws no frame, only
  `No map for this area · places listed below`; the list is unchanged.
- **Positions are the brain's claim.** Whenever a place is pinned the card
  says `Positions as given by the brain · the map does not check them`, and
  the OpenStreetMap credit appears once, exactly when OSM geometry is drawn.
`icon` fields are the kit's semantic icon keys; a key the kit does not know
is dropped rather than rejected. `show_block` payloads discard unknown fields
from the rendered block rather than keeping them, so otherwise valid stored
or replayed blocks still render. Its payload schema is separate from new-call
validation: new `suggestions` calls reject unknown keys at both the block and
item levels, including an item's unsupported `tone` (#635). Claude and pi
advertise that restriction and reject such calls with validation errors.
This tightens accepted input and ships as a pre-1.0 minor. Stored or replayed
suggestions continue to discard those keys; malformed payloads still fall
back to the generic tool view. Other block kinds keep their existing input
and payload parsing behavior.

`suggestions` (additive in 0.39.0, D50) is the one kind that is not part of
the answer. It is follow-ups the model offers the reader, and a consumer
that draws it holds to these rules:

- **Not at the call's position.** It is drawn after the answer, as the
  turn's closing row, from the turn's **last** call that parses. An earlier
  or rejected call draws nothing, and a share or print of the answer leaves
  it out.
- **Taking one never sends.** A chip puts its `label` in the reader's
  composer, below any draft, to edit or leave. It is never a message, an
  answer to a pending question or an approval.
- **The row is gone once the reader sends anything**, and it is not drawn
  while the turn runs, while an `ask_user` question in the turn is
  unanswered, or when the answer's last text ends in a question. The
  decision reads only the transcript and current state, so a replayed
  session draws what the live one did.
- **An older client** has no variant for it: the payload fails its parse
  and falls back to the generic tool view, as any unparsed payload does.

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

New billing computations use only a valid `brain.billing_mode`
(`subscription` | `api`) recorded on the run's root span. Missing or invalid
billing stays unknown for every origin, including cron: `billingMode`,
`effectiveCostUsd` and `pricingEstimate` are `null`, regardless of server
credentials or runtime identity. Available backend-reported or computed
list-price `costUsd` is retained. Non-null historical costs and billing remain
frozen at their first write; later valid evidence may fill unknown slots only
when it agrees with an already frozen classification. Re-rollups do not
reclassify previously recorded history from today's environment (#293).

<a id="module-tools"></a>

## Module tools

`ModuleContribution.tools` declares lazy MCP definitions by local name.
`brain mcp` imports these definitions at startup and serves them after the
eight core tools, in module config order and then declaration order. A loader
may resolve a `ModuleTool` directly or an object with a `default` tool export.
Other CLI commands do not import the definitions.

A module dormant at startup contributes no tools: its definitions are not
imported and its tools are absent from `tools/list`. The filter uses
`LoadedModule.state`; omission in constructed legacy contexts means active.
`brain module list --json` still includes dormant modules and their declared
canonical tool names. Marking a module dormant on disk leaves the running
process's registered tools callable; the next process omits them. In-flight
calls are not cancelled and completed effects are not rolled back. Dormancy
controls context and is not permission revocation.

Core composes each name as `<module>_<local>`, at most 64 characters. Modules
with nonempty `tools` must match `^[a-z][a-z0-9-]{0,30}$`; `brain` is reserved.
Local names must match `^[a-z][a-z0-9_]{0,31}$`. Invalid names or non-function
loaders fail module loading. An invalid config retains the existing degraded
MCP behavior: only core tools load, with a config warning and writes disabled.
Registration also checks composed names against all earlier registered names
before registering any tool from that module.

`brain module list --json` adds `tools: string[]` to each enabled module,
containing canonical names in declaration order, or `[]`. Listing imports no
tool definitions. `brain module lint <name> --json` retains its
`{ module, findings, errors }` envelope and adds error rules `tool-load`,
`tool-name`, `tool-annotations`, `tool-schema` and `tool-docs`. Lint uses MCP
startup's definition validator, additionally requires a description for every
input, and checks that the module README's level-two `MCP tools` section names
every declared canonical tool. Annotation/schema errors use their specific
rule instead of a duplicate `tool-load`; import and other definition failures
use `tool-load`. Invalid names remain load errors for normal commands and are
reported as `tool-name` when linting the rejected module.

The `ModuleTool`, `ToolContext` and `defineModuleTool` exports are
`@experimental` until 1.0. The identity helper infers `run`'s input and result
from its schemas. A definition requires a nonempty description, strict zod 4
object `inputSchema` and `outputSchema`, and a `run` function. Both schemas
must be representable as JSON Schema. Annotations must explicitly state
`readOnlyHint` and `openWorldHint`; `destructiveHint` is also required when
`readOnlyHint` is false. An optional title and `idempotentHint` are supported.
Annotations are client hints, never permission grants.

If any import, definition or collision check fails, that module contributes
zero tools. Core and other modules continue serving. The failure appears on
stderr and in the `warnings` of core tools that return warnings.

The SDK validates input against the full strict schema before calling
`run(input, { root, config, taxonomy, signal })`. `config` is the owning
module's validated block; `signal` aborts when the client cancels the request.
Resolved results appear in `structuredContent` and in the first text block
as compact JSON. The SDK validates them against `outputSchema`. Input or
output validation failures return `isError: true`; thrown operations return
`{ isError: true, content: [{ type: "text", text: "Error: <message>" }] }`.
A tool states and applies its own result cap; core adds no generic truncation.

The tool set is fixed for the process lifetime. The server sends no
`notifications/tools/list_changed`, although the SDK advertises
`tools.listChanged`. Config edits take effect in the next process; they do
not revoke existing handles, cancel calls or roll back completed effects.
Calling a name this process did not register returns `isError: true` with
`MCP error -32602: Tool <name> not found`.

Namespacing prevents collisions and does not exclude a tool from compatibility
policy. Each module owns its documented tool names, schemas and behavior.
First-party tools enter this contract when shipped and follow the project's
versioning rules; third-party modules document the same policy in their own
packages. Adding a supported tool is a minor change. Removing or breaking one
requires a maintainer ruling for first-party tools and a breaking release
under the applicable package's policy. A tool and its CLI subcommand call the
same deterministic operation. See the
[module-tool decision](../decisions/module-mcp-tools.md) for the full specification.

<a id="first-party-module-tools"></a>

### First-party module tools

| Tool | Owning module | Inputs | Result |
| --- | --- | --- | --- |
| `jobs_review` | `@schlessera/brain-module-jobs` | Optional `status` (one of `REVIEW_STATUSES` or `all`, default `queued`), `min_score` (finite number, inclusive), `limit` (positive integer, default 20, clamped to 50), `source` (one of `ALL_SOURCES`). Unknown keys and invalid values are tool errors. | `{ jobs: JobSummary[] }`, in the CLI review order: descending relevance score, then descending publication date, excluding duplicates. |

`jobs_review` (0.40.0+) calls the same validated operation as
`brain jobs review --json`; the CLI's full-row `{ jobs }` envelope and human
output remain unchanged. The tool returns a compact projection, at most 50
entries. Each summary has required fields `id: integer`, `title: string`,
`company: string`, `source: string`, `review_status: ReviewStatus`,
`relevance_score: number`, and `tags: string[]`; `location`, `remote_type`,
`salary_raw`, `salary_currency`, `published_at`, and `url` are required
`string | null` fields; `salary_min` and `salary_max` are required
`number | null` fields. No full description is returned. Absent or invalid
stored tags produce `[]`. Stored source identifiers, including retired boards,
remain readable; the input filter accepts the current `ALL_SOURCES` only.
Both result objects are strict.

Salary bounds retain the ingested **annual EUR cents**, including hourly
annualization; `salary_currency` retains the original listing's label and is
not the denomination of the converted bounds. The tool uses its owning
module's contained `dbPath`. A missing database returns `{ jobs: [] }`
without creating it; an existing database may undergo the same schema
initialization/migration as the CLI. Annotations are `readOnlyHint: true` and
`openWorldHint: false`, with backend admission governed separately.
