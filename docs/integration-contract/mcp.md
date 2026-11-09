# Integration contract — MCP tools

Authoritative component of the [integration contract](../integration-contract.md).
Its [shared scope and versioning policy](../integration-contract.md) apply to every section below.

<a id="mcp-server-stdio-brain-mcp-or-srcmcp-serverts"></a>

## MCP server (stdio, `brain mcp` or `src/mcp-server.ts`)

Tool names and input schemas are stable:

| Tool | Annotations | structuredContent |
|------|-------------|-------------------|
| `brain_search` | readOnly | `{ results, warnings }` — each result is `{ path, title, type, relevance, status, summary, updated, deadline, tags, score, snippet, supersededBy? }`; every field after `type` may be `null`. `status`, `summary`, `updated` and `deadline` are additive in 0.38.0. `supersededBy`, the path of the document that `supersedes` this one, is present only when one does (additive in 0.38.0) |
| `brain_context` | readOnly | `{ context, warnings }`, plus `coverage` when the call has a path scope (additive in 0.45.0; see [Scoped context](#scoped-context-additive-0450-3644)) |
| `brain_read` | readOnly | none — the first `content` block is the file text, verbatim; with `section`, that section; over `max_tokens`, the frontmatter and an outline of headings with estimated token counts. `max_tokens` is the threshold that switches to the outline, not a cap on the output: a large frontmatter or very many headings give an outline larger than it |
| `brain_list` | readOnly | `{ documents, warnings }`; with `path_prefix`, `overview` or `cursor`, one bounded page `{ documents, next_cursor, total, truncated?, warnings }` (see [paged inventory](#brain_list-paged-inventory-additive-0450-3643), additive in 0.45.0) |
| `brain_read_many` (additive, 0.45.0) | readOnly | none — the first and only `content` block is the compact JSON envelope `{ items, truncated, max_total_chars, max_item_chars, warnings }`; see [Bounded multi-read](#bounded-multi-read-additive-0450-3642) |
| `brain_graph` | readOnly | `{ edges: [{ source, target, resolved }], nodes: [{ path, title, type, summary, updated }], warnings }`. `nodes` holds one entry, sorted by `path`, for every document an edge touches: each `source`, and each `target` whose `resolved` is `true`. An unresolved target is raw link text and never a node. `summary` and `updated` may be `null`. `nodes` is additive in 0.38.0 |
| `brain_add` / `brain_update` / `brain_archive` | non-destructive, idempotent (update/archive) | result object |
| `brain_compute_*` | see [External compute tools](#external-compute-tools-additive-0450-3107) | the `brain compute` envelope |
| `brain_apify_discover` … `brain_apify_abort` (additive, 0.45.0) | open-world; read-only except `run` and `abort` | the Apify envelope; see [Apify tools](#apify-tools-additive-0450-3162) |

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
(`serverInstructions`, `packages/core/src/mcp-server.ts:95-109`). Since 0.45.0
they add one sentence: the `brain_apify_*` tools reach Apify's paid remote
extractors under the governance policy, are not web search, and discovering or
inspecting an Actor never runs it. Tool descriptions are descriptive in the
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
| `brain_context` | `query`, `max_tokens?` (default `4000`), `include_identity?` (default `true`), `include_current_focus?` (default `true`), `include?`, `exclude?` (each at most 64 paths of 1 to 512 characters; additive in 0.45.0, see [Scoped context](#scoped-context-additive-0450-3644)) |
| `brain_read` | `path`, `section?` (a heading's visible text, compared under Unicode canonical caseless matching (full case folding); the body is parsed as GFM, and only top-level ATX and setext headings count, never one inside code, HTML, a table, a list or a blockquote; the section runs to the next heading of the same or higher level; of two equal headings the first is returned; an unknown one is an error naming the document's headings), `max_tokens?` (positive safe integer; the threshold for the outline, not an output cap; no default, so the whole file comes back unless it is given). Both additive in 0.38.0 |
| `brain_list` | `type?`, `tag?`, `status?`, `relevance?`, `limit?` (integer `1`–`100`, default `20`; the schema says `"type": "integer", "minimum": 1, "maximum": 100`. A fraction, `0`, a negative or a value over `100` is rejected as invalid input, a tool result with `isError: true` and no `structuredContent`, the convention every schema violation follows. **Breaking in 0.41.0 (#1351):** the schema was a plain `number` and the server clamped the value into 1–100, so `0` listed 1 and `500` listed 100), `path_prefix?`, `overview?` (boolean), `cursor?` (the three additive in 0.45.0, #3643) |
| `brain_graph` | `path`, `depth?` (default `1`), `direction?` (`outgoing`\|`incoming`\|`both`, default `both`) |
| `brain_read_many` | `requests` (1–20 of `{ path, section?, offset?, column?, expected_sha256? }`; no other key), `max_total_chars?` (integer `2000`–`40000`; `24000` when omitted), `max_item_chars?` (integer `512`–`40000` and at most `max_total_chars`; `8000`, or `max_total_chars` if smaller, when omitted). Additive in 0.45.0; see [Bounded multi-read](#bounded-multi-read-additive-0450-3642) |
| `brain_add` | `content`, `type?`, `title?`, `tags?` (comma-separated) |
| `brain_update` | `path`, `summary?`, `status?` (`active`\|`archived`\|`draft`), `relevance?` (`primary`\|`secondary`\|`historical`), `tags?` (comma-separated, replaces), `deadline?`, `next_review?` (ISO 8601; `""` removes), `append_content?`. Setting `status: "archived"` applies `brain_archive`'s relevance rule to the effective relevance (the `relevance` passed in the same call, else the document's): a `primary` or missing one becomes `historical` and `"relevance"` is listed in `changes`; an explicit `secondary` or `historical` stays (additive in 0.38.0) |
| `brain_archive` | `path`, `dry_run?` (default `false`) |

Read tools append an index-staleness warning when markdown files are newer
than their `indexed_at`; `brain_read_many` carries it, once, in its envelope's
`warnings` instead of a second content block.

<a id="brain_list-paged-inventory-additive-0450-3643"></a>

### `brain_list` paged inventory (additive, 0.45.0, #3643)

Passing any of `path_prefix`, `overview` or `cursor`, even `overview: false`,
selects one bounded page of the shared paged inventory instead of the legacy
listing: `{ documents, next_cursor, total, truncated?, warnings }`, newest
`updated` first then by `path`, at most 30,000 UTF-8 bytes of compact JSON,
whole rows only. Every row keeps the six listing fields; `overview: true` adds
`summary`, `updated`, `deadline`, `indexed_at` and `indexed_body_bytes`, and a
row shortened to fit names the fields in `clipped`. `updated` is the
frontmatter date as indexed, not the file's mtime or project activity;
`indexed_body_bytes` is the UTF-8 size of the indexed body without its
frontmatter, never the whole file's size. `path_prefix` matches whole path
segments. `next_cursor` is `null` at the end; a malformed cursor, a cursor
from a listing with other filters or prefix, and a malformed prefix are tool
errors (`isError: true`, no `structuredContent`) naming the input. The page
carries the server's usual warnings, a stale-cursor warning when the index
changed since the cursor was issued, and, with `overview`, a warning for
listed sources changed after indexing or missing. Pi's `brain_list` takes the
same three inputs and returns the same page as compact JSON text, and pi's
`brain_search` takes `overview` to show each result's status, `updated`,
`deadline` and summary (whitespace collapsed, at most 300 code points)
within its 30,000-byte output, keeping whole results and ending with
`… <n> more result(s) omitted to fit the output budget` when they do not all
fit; without it pi's search output is unchanged. The fields, order, cursor,
bound and warnings are specified once in
[the paged inventory](../content-index-queries.md#paged-inventory-and-the-overview-projection).
A call with none of the three inputs returns the legacy `{ documents,
warnings }` byte for byte.

<a id="scoped-context-additive-0450-3644"></a>

### Scoped context (additive, 0.45.0, #3644)

`brain_context` takes two optional path lists, `include` and `exclude`; `brain
context` takes them as repeatable `--include` and `--exclude` flags and pi's
`brain_context` as `include` and `exclude` parameters. All three call one
assembler (`assembleContext`, `packages/core/src/lib/context-assembler.ts:346-567`),
which validates the scope (`parseContextScope`,
`packages/core/src/lib/context-scope.ts:105-133`) before anything is read.

- **Entries.** A repository-relative path. One ending in `/` is a folder
  prefix and covers everything under it at any depth; any other entry names
  exactly one file (`projects` is a file called `projects`, not the folder).
  There are no globs. An absolute path, a `.`, `..` or empty segment, `\`,
  `:` or a control character is refused: a tool error on MCP, a usage error
  (exit `1`, nothing on stdout, no query run) on the CLI, a thrown tool error
  on pi. Each list holds at most 64 entries of 1 to 512 characters.
- **Precedence.** An exclusion wins over an inclusion everywhere. With no
  include list, every path not excluded is in scope; with one, only the paths
  it covers. Include entries match case-sensitively; exclude entries match
  under Unicode compatibility case folding, so a differently cased spelling of
  an excluded path is still excluded. A file is also checked under its real
  path: an in-repository symlink to an excluded file is excluded, and one that
  leaves the root is unavailable.
- **Every lane.** The scope applies before a source file is opened, to the
  identity and current-focus documents, to the search pool (drawn from the
  scope's indexed paths, so nothing outside it takes a place or fills spare
  budget), to each hit's section expansion and to the `### Related`
  neighbours; an out-of-scope `_index.md` is passed over for the next one up.
  An include list that does not cover the identity or current-focus document
  leaves it out. The scope only narrows: it never makes readable what the
  index, policy or provider masks leave out.
- **Coverage.** A scoped call returns `coverage`: `{ exhaustive: false,
  include, exclude, excerpts: [{ path, lane, form }], omitted: [{ path, reason
  }], omittedMore, budgetExhausted }`. `lane` is `identity`, `focus`, `search`
  or `related`; `form` is `whole`, `cut`, `section`, `snippet` or `summary`.
  `reason` is `budget` (an in-scope candidate with no room), `unavailable`
  (named or canonical but not indexed, missing, unreadable or outside the
  root), `not_ranked` (an exactly included path the query did not select) or
  `excluded` (an exactly included path an exclusion also covers). At most 64
  omissions are listed; `omittedMore` counts the rest. A briefing is ranked
  and budgeted, never an inventory: a path in scope that is in neither list
  was simply not selected. MCP adds `coverage` to `structuredContent` and a
  `### Coverage` note as the last content block; the CLI prints the note after
  the context, and pi appends it to the tool text and puts `coverage` in the
  result's `details`. The note is outside the token budget; it names the
  partial excerpts (`snippet` or `cut`), whose files hold more than the
  briefing shows, and the omissions, at most 20 of each.
- **Unscoped calls are unchanged.** Without an entry in either list, output,
  `structuredContent` and defaults are what they were: MCP and the CLI include
  identity and current focus by default; pi never does, scoped or not, since
  its session already loads them.

<a id="bounded-multi-read-additive-0450-3642"></a>

### Bounded multi-read (additive, 0.45.0, #3642)

`brain_read_many` reads up to 20 documents or sections under one size budget.
MCP serves it as `brain_read_many`, pi registers a tool of the same name with
the same input, and `brain read-many --json` prints the same envelope. All
three run one core operation (`readMany`,
`packages/core/src/lib/ops/read-many.ts:426-480`); the decision behind it is
[bounded-multi-read.md](../decisions/bounded-multi-read.md). `brain_read` is
unchanged: its output, its whole-file default and its uncapped `max_tokens`
threshold are what they were, and so is the hosted `brain_read_base`.

- **Unit.** Every size is UTF-16 code units of compact JSON,
  `JSON.stringify(x).length`, field names, quoting, metadata and escaping
  included. The whole envelope is at most `max_total_chars` and each item at
  most `max_item_chars`. UTF-8 bytes can be up to three times that.
  `est_tokens` is `ceil(chars / 4)`, an estimate, never a provider count.
- **Refused whole.** A call that fails the schema, sets `column` without
  `offset`, sets `max_item_chars` above `max_total_chars`, or whose caps
  cannot hold a `budget_exhausted` stub for every request (or a stub within
  `max_item_chars`) reads nothing: a tool error on MCP and pi, a usage error
  (exit `1`, nothing on stdout) on the CLI. Nothing is clamped.
- **Envelope.** `{ items, truncated, max_total_chars, max_item_chars, warnings }`.
  `items[i].index === i`, in request order, which is the caller's priority.
  Before each item the call reserves room for a stub for every later request,
  so a later request is answered, at worst, as `budget_exhausted`, never
  dropped. `truncated` is true when an item is an `outline`, an `error`, or a
  `partial` with a `next`. `warnings` holds the call's tool warnings once: on
  MCP the read tools' config, module-load and stale-index warnings; the CLI
  and pi have none.
- **Items.** Each has `index`, `path` (as given), `section` when asked, and a
  `kind`:
  - `full`: `sha256`, `content`. `content` is byte for byte what `brain_read`
    returns for the same `path` and `section`.
  - `outline`: the scope does not fit and has headings to choose between (a
    section needs a subheading). `sha256`, `bytes`, `chars`, `est_tokens` (of
    the scope), `frontmatter` (whole document only, when it fits whole;
    otherwise `frontmatter_chars`), `headings: [{ level, text, est_tokens }]`
    in document order while they fit, `omitted_headings` when some did not,
    and `next: { offset: 1 }`. An outline that could hold no heading is not
    returned; the scope is paged instead.
  - `partial`: the scope has nothing to choose between, or `offset` was given.
    `sha256`, `bytes`, `chars`, `est_tokens`, `offset`, `column` (when not
    `0`), `lines` (of the scope), `returned_lines` (lines touched, one cut
    short included), `text` and, unless the page reaches the end, `next: {
    offset, column? }`. A page takes whole lines while they fit, then the
    fitting prefix of the next line, cut on a code point. Requesting `next`
    each time and joining every page's `text` reproduces the scope exactly.
  - `duplicate`: `of`, the index of an earlier request that resolves to the
    same file (through spelling and in-root links) with the same section
    (compared as `section` matches headings), `offset`, `column` and
    `expected_sha256`. That item stands for both, whatever its kind.
  - `error`: `code`, `message` (fixed text, never a host path), and `sha256`
    and `headings` where noted.
- **Error codes.** `refused` (the path is absolute, has a `..`, colon or
  backslash segment, or leaves the root through a link: `brain_read`'s rule),
  `not_found`, `not_a_file`, `too_large` (over 4 MiB, checked again after the
  read), `work_limit` (the call has read 16 MiB of distinct files),
  `read_failed`, `section_not_found` (with `sha256` and as many of the
  document's heading texts as fit in `headings`), `source_changed` (the file's
  SHA-256 is not `expected_sha256`; carries the current `sha256`),
  `bad_offset` (past the last line, past the end of the offset line, or a
  `column` that splits a surrogate pair; carries `sha256`) and
  `budget_exhausted`. One item's error never fails the call. Consumers
  tolerate unknown codes.
- **Versions.** Each distinct file is read once per call, so every item of
  it names the same `sha256`: the SHA-256 of its bytes, the hash
  `brain_read_base` calls `expectedBaseHash`. It is a retrieval version, not a
  hosted write receipt: pi's `brain_read_many` records no write base.
- **Authority.** Each request is resolved as one `brain_read` resolves it, by
  the same resolver on each surface, and read through the filesystem the
  caller runs in, so provider masks and data trees apply as they do to
  `brain_read`. MCP marks it `readOnlyHint: true`; both backends auto-allow it
  as they do `brain_read`, it is in the Claude voice posture, takes no lock,
  waits at the index barrier like `brain_read`, and the turn journal observes
  it as `unproven`. Schedules do not accept it.
- **Cancellation.** The signal is checked before every request and before
  and after every file read. A cancelled call rejects with no partial result:
  MCP passes the request's abort signal, pi the tool's and the turn's.
- **CLI.** `brain read-many <path>... [--max-total-chars N] [--max-item-chars
  N]`, or `--input <file.json>` / `--stdin` with the MCP input object. `--json`
  prints the envelope as compact JSON, so the printed text is the text the
  caps count; human mode prints one labelled block per item.

<a id="external-compute-tools-additive-0450-3107"></a>

### External compute tools (additive, 0.45.0, #3107)

`brain mcp` serves six `brain_compute_*` tools after the eight document tools
and before module tools. They call the same core operation set as
[`brain compute`](cli.md#external-compute-additive-0450-3107) and return the
same envelopes: a success as `structuredContent` with its compact JSON text
copy, a refusal as a tool result with `isError: true` carrying
`{ ok: false, error: { code, message } }` in both. A schema violation is the
usual tool error without `structuredContent`. An operation that fails inside
the server instead of refusing (an unreadable state directory, for example)
is also a tool error without `structuredContent`, with the fixed text
`Error: <tool name> failed inside the brain MCP server; its log has the
details`: the thrown message, which can name local paths, goes only to the
server's stderr.

| Tool | Annotations | Inputs | Result |
|------|-------------|--------|--------|
| `brain_compute_health` | readOnly, openWorld | `provider?` | the `health` envelope |
| `brain_compute_plan` | readOnly, not openWorld | `provider`, `argv`, `cwd?`, `env?`, `source?`, `artifacts?` (`[{ path, max_bytes? }]`, default cap 1 MiB), `lease_seconds?`, `retain?` | the `plan` envelope |
| `brain_compute_run` | not readOnly, not destructive, not idempotent, openWorld | as `brain_compute_plan` | the `run` envelope, returned once the command has started |
| `brain_compute_status` | not readOnly, not destructive, idempotent, openWorld | `job` | the `status` envelope |
| `brain_compute_cancel` | destructive, idempotent, openWorld | `job` | the `cancel` envelope |
| `brain_compute_collect` | not readOnly, not destructive, idempotent, openWorld | `job` | the `collect` envelope |

Every input schema is a closed object (`additionalProperties: false`), pinned
with the others in `mcp-input-schemas.json`. No input names a caller, a
principal, a session, a credential or a vendor id: the caller is
`{ kind: "mcp", principal: <the server process's operating-system user> }`,
and a job is addressable only by the caller kind and principal that started
it. `status`, `cancel` and `collect` advance the job they report.

The six tools are registered whatever the brain's configuration says, with
fixed names, order, descriptions and schemas, so a session's tool roster does
not change when compute is configured, disabled or reconfigured; an
unconfigured or unavailable provider refuses at call time
([provider-history.md](../decisions/provider-history.md)). Status and cost
appear only in results the agent asked for.

`brain_compute_run` does not wait for the job. While the server process
lives it advances the jobs it started through the same `status` operation,
one visit at a time with backoff (2 s rising to 15 s), at most 16 visits a
pass to the least recently visited jobs first and up to 256 jobs tracked,
until each has ended and its cleanup is settled. A job whose visits throw
five times in a row is no longer advanced, and the server logs it on stderr. Closing the server stops those
visits and cancels nothing: a job is then bounded by its lease, and the next
`status`, `cancel`, `collect` or `brain compute reconcile` settles it.

<a id="hosted-authoritative-application-tools"></a>

### Hosted authoritative application tools

Hosted turns route authoritative Markdown through the server-owned application
boundary. Standalone terminal `brain mcp` names and schemas above are unchanged.
Claude registers the tools below under `mcp__brain-ui__`; pi uses the unprefixed
names. Hosted Claude disallows project `mcp__brain__brain_add`,
`mcp__brain__brain_update` and `mcp__brain__brain_archive`.
Hosted interactive Claude keeps native `Write`/`Edit`/`NotebookEdit` registered
across governed, strict and voice turns. Governed typed natives are auto-allowed
when configured, under existing stale-read, write-lock, journaling and protected
mount controls. Strict and voice native calls refuse at call time before
execution or an approval card, including with settings or remembered allows;
server application tools retain their existing per-turn authority. Autonomous
registration and authority are unchanged (#2022, #2048 A).

| Tool | Exact input (unknown keys refuse) |
| --- | --- |
| `brain_read_base` | `{ path: string, offset?: integer ≥ 1, limit?: integer ≥ 0, column?: integer ≥ 0 }`; returns `{ expectedBaseHash, bytes, lines, content }` for a whole document, or `{ expectedBaseHash, bytes, lines, offset, column?, returnedLines, text, nextOffset?, nextColumn?, hint? }` for a page ([paging](#brain-read-base-paging)) |
| `brain_add` | `{ content: string, type?: string, title?: string, tags?: string[], target?: string, expectedBaseHash?: string \| null }`; deterministic server capture plans and validates its current base when absent |
| `brain_update` | `{ path: string, expectedBaseHash: string \| null, summary?: string, status?: "active" \| "archived" \| "draft", relevance?: "primary" \| "secondary" \| "historical", tags?: string[], deadline?: string, next_review?: string, append_content?: string }` |
| `brain_archive` | `{ path: string, expectedBaseHash: string \| null, dry_run?: boolean }` |
| `write_file` | `{ path: string, expectedBaseHash: string \| null, content: string }` |
| `edit_file` | `{ path: string, expectedBaseHash: string \| null, old_string: string, new_string: string }`; nonempty old string must occur exactly once |
| `apply_staged_changes` | `{ files: [{ path: string, expectedBaseHash: string \| null, content: string }] }`; 1–32 unique named files, no command field |

<a id="brain-read-base-paging"></a>

`brain_read_base` paging (#1624; **breaking** in 0.42.0 under the maintainer
ruling on that issue). The result is one compact JSON text block whose first
key is always `expectedBaseHash`, the server's SHA-256 of the **whole**
document, never of a page; `bytes` is its UTF-8 size and `lines` its line
count. A call without `offset`, `limit` or `column` returns the whole document
as `content` while its JSON-escaped text fits the 40,000-character page budget
(`BRAIN_READ_BASE_PAGE_CHARS`). A larger document, or any ranged call, returns a
page instead, with no `content`: `text` holds lines from `offset` (1-based,
default 1) with their line terminators kept, at most `limit` of them and never
more than the budget, so concatenating every page's `text` reproduces the
document. `returnedLines` counts them, and `nextOffset`, present while text
remains, is where the next page starts. A line longer than the whole budget is
cut on a code point; the page then carries `nextColumn`, the UTF-16 offset
inside line `nextOffset` to pass back as `column`, and a page that starts
there echoes `column`. `limit: 0` returns the hash and sizes with an empty
page. `hint` is present only when a call without a range was too large to
return whole. The budget keeps every result under the Claude Agent SDK's
50,000-character tool-result persistence threshold and inside its uncounted
MCP pass-through size (length / 4 within half its default 25,000-token
`MAX_MCP_OUTPUT_TOKENS`), so the hash is never spilled to a file.

The break: before 0.42.0 every result was `{ content, expectedBaseHash }`.
A call without a range on a document over the budget no longer carries
`content`; a consumer that needs the whole text reads the pages in turn.
Documents within the budget keep `content`, now with `bytes` and `lines`.

Hashes are lowercase SHA-256 of complete UTF-8 bytes; `null` means exclusive
creation. Pi may omit a tool's base hash only when a preceding read in the same
turn supplied it (a paged `brain_read_base` supplies the whole-document hash);
a write with no read is create-only. The server application
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
indexed?: boolean, indexStatus?: "pending", outcome?: object }`. A null result hash denotes a removed
source. `changes` names only committed effects.

**Deferred indexing (breaking, 0.44.0, #2835).** A committed application returns
as soon as its Markdown is durable, with `indexed: false` and `indexStatus:
"pending"` and no `indexError`; an `add` result's `outcome` carries the same two
fields. Pending is not a failure. `indexed: true` is never reported for queued
work. The host batches the exact committed paths of every application and runs
one targeted index update, in the same isolated maintenance worker, at the next
index-dependent read or at the end of the turn, whichever comes first. A brain
whose index holds no Markdown yet, or cannot be trusted for a targeted update,
gets a complete build instead. Index-dependent reads are every tool of the
brain's own MCP server (`mcp__brain__*`), pi's `brain_search`, `brain_context`,
`brain_read`, `brain_list`, `brain_graph` and `brain_read_many`, either backend's shell, and capture
planning for `add`; each waits for every application committed before it, in
any turn, before it runs. File reads and host application tools do not wait.
When the update fails, the waiting read is refused with a message that names the
committed paths and the index error, and never runs against the stale index; an
`add` refuses with the additive code `index_stale` and changes nothing. The
paths stay queued, and the next reader or turn end retries. The Markdown stays
committed throughout. The `brain_application` Activity event records
`indexed: false` with `indexStatus: "pending"`; each later outcome appends a
`brain_application_index` event `{ applicationId, indexed, indexError?,
changeCount }` naming it, failure once and success once, before the turn's
terminal record. No earlier result or provider message is rewritten. A failed
turn-end update is on that record, and its paths are retried by the next reader. A refused result is visible to
the agent and recorded as a server-authored `brain_application` activity event;
policy denial, provider-mask refusal (`provider_masked`, #2690; whole-tool for `query_activity`, `inbox_list` and `inbox_get`, #2698; an autonomous origin thread without compatible provenance, #2741), alias denial, topology change, stale base, revoked authority,
membership, permission, invalid request, unsupported kind/host, payload and
cancellation errors never silently merge or replay. Error codes are additive;
consumers tolerate unknown codes. Claude wraps the result in MCP text with
`isError: !ok`; pi returns successful results as text/details and throws refused
results through its existing tool-error path.

CLI commands encountering `EROFS` exit 2. On Linux, known write forms also
refuse a read-only brain mount before entering handlers which collect per-file
errors; dry-run forms and read-only commands remain available. Since #2038,
`brain render` checks that its input is inside the brain and exists before this
refusal: an outside or missing input is a usage error (exit 1), even on a
read-only brain. Stdin (`-`) and reference forms have no input path to check.
Other commands retain their existing error precedence. Machine mode emits
`{ schema_version: 1, ok: false, error: { code: "read_only_brain", message: string,
tool: string } }`. The message states that the brain is read-only here and names
`brain_add`, `brain_archive`, or `apply_staged_changes` for the corresponding
hosted effect, including the Claude spelling. The `tool` field keeps that value
for every command. Additively since #1626, the pre-check asks about the
directory a command writes: `brain scratch` and a `brain render` sent to
`--scratch` (or rendering stdin without `--out`) check `.brain/scratch/`,
which a hosted worker binds writable, so they run there. For `brain render`
and `brain image` into the read-only brain the message names `--scratch` as
the route and says to link the printed path; when `.brain/scratch/` is
read-only as well it states that condition, points to the sandbox note for the
reason, and says nothing written now is kept; it does not guess the host's
mount reason. For `brain scratch` it
says the scratch area is read-only and nothing was removed. Nothing is staged or replayed;
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

**Interactive roster stability (#2048).** Each backend offers its complete
first-party deployment tool roster in deterministic order on every interactive
turn, including voice-first sessions. A temporary missing handler, no-grant
surface or strict sandbox fallback does not remove tools, schemas or descriptions.
Registration grants no authority. Unavailable bridge calls return a model-readable
refusal before opening a permission card or invoking the privileged handler;
voice and no-grant turns refuse visual pickers, image masks, policy proposals and
inbox mutations. Claude keeps native `Write`, `Edit` and `NotebookEdit` registered
and refuses them at call time on strict/voice turns, including settings or
remembered allows. Governed typed calls retain their stale-read and write-lock
checks. Pi still rejects voice dispatch before a provider request: the stable
roster does not add a voice posture. Restricted autonomous rosters remain exact
server authority and are outside this interactive stability rule. Existing tool
names, inputs and result shapes are unchanged. Hosted legacy project-MCP
shadowing uses the session-stable trusted
`StartTurnRequest.applicationAuthority: "server"` declaration even when its
route handler is absent; direct unhosted consumers retain their legacy tools.
See [the package API](package-api.md#stable-hosted-application-roster-2048).

The chat-UI backends register an in-process MCP server under the `brain-ui`
key; its tool names are equally stable. `ask_user`, `ask_user_form` (additive in 0.40.0), `ask_user_rank` (additive in 0.40.0), `ask_user_list` (additive
in 0.40.0), `get_current_location` and `request_image_mask` bridge to the
connected browser. `query_activity`
(read-only) reads the host's activity record — scopes `running` | `recent` |
`run` | `rollups` | `inbox` | `roadblocks` (additive in 0.42.0); results are wrapped in a data-only delimiter
(nonce-suffixed per call) because they can contain free text from past runs.
The `roadblocks` scope reads retained governance episodes rather than prunable
Activity details. Optional `hoursBack` is an integer from 1 to 2160 (default
24), and `limit` is an integer from 1 to 100 (default 20), applied separately
to each ranking after selected episodes in the window have been aggregated.
Optional `remedy` is `actionable` (default), `all`, `guidance`, `capability`, or
`abandoned` (#2034). Actionable excludes abandoned episodes before aggregation,
rankings, totals and examples; all includes them, and a named remedy selects
only that class. Abandoned indicates one unresolved failure with no retry and
an eligible later successful step; it does not prove intent was satisfied. The
result has `windowHours`, `episodes` (valid episodes), `totalGroups`,
`unavailableEpisodes` (unsupported versions or invalid stored payloads), and
four arrays of groups: `byCount`, `byTokens`, `byCostUsd`, `byTime`.

Each group has the classifier's normalized `signature`, episode `count`,
`remedies: { guidance, capability, abandoned }` counts, `resolved` count,
`resolutionRate` (resolved/count), `waste: { tokens, costUsd, ms,
unknownTokens, unknownCostUsd }`, and up to five distinct `exampleTurnIds`
in event-id order. Mixed remedy counts retain all selected classes. Historical version-1 evidence
is read as recorded, without synthesizing abandoned classifications. Waste totals sum
measured values only; tokens/cost remain `null` when none were measured, and
the unknown counts disclose incomplete coverage. A genuine measured zero is
zero. Rankings descend by their named metric; unknown totals follow measured
totals, ties descend by episode count then ascend by signature (code-point
order). No combined weighted waste score or inferred price is introduced.
All data remains on the host; no UI or external telemetry is added. Invalid
roadblocks parameters become tool errors without changing other scopes.

`show_block` (side-effect free, always registered) renders one of the kit's
answer blocks inline in the answer, or the follow-ups the model offers under
it (`suggestions`); it validates its argument and echoes it, and rejects a `link` block whose
address the link policy refuses, and a `tracker` block with any event whose address it refuses.
The eleven bridge tools are declared once as **tool contracts** in
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
| `turn_temp` (0.42.0) | **none** | JSON usage or purge receipt |
| `show_block` | `{ block }`, the validated input echoed | the block, inline at the call's position in the answer; `suggestions` alone is drawn under the answer instead |

#### `turn_temp` (additive in 0.42.0, #1703)

Both hosted backends expose `turn_temp` (Claude spelling:
`mcp__brain-ui__turn_temp`) for interactive and voice turns, without approval.
Restricted autonomous turns do not register it.

- **Input:** `{ action: "usage" | "purge", paths?: string[], all?: boolean,
  force?: boolean }`. `paths` has at most 100 strings, each 1–1000 characters.
  `usage` takes no paths, `all: true` or `force: true`. `purge` requires
  either nonempty `paths` or `all: true`, never both. `force: true` is valid
  only with named paths.
- **Scope:** paths are relative to the worker's private `/tmp`; absolute
  `/tmp/…` and `$BRAIN_WORKER_SCRATCH/…` spellings are accepted. The root,
  traversal and outside paths are refused. Directory traversal is descriptor
  relative with `O_NOFOLLOW`; nested mounts and runtime state are excluded.
  A named symlink or hardlink is unlinked without touching its target.
  Worker scratch and XDG root directories remain in place.
- **Usage result:** `{ usedBytes, limitBytes, freeBytes, largest, truncated }`.
  `largest` lists at most 10 entries `{ path, bytes, type: "file" | "directory" }`,
  ordered by descending bytes. Usage measures the private tmpfs; the entry
  walk excludes runtime state and is bounded.
- **Purge result:** `{ truncated, removedCount, removed, skippedCount, skipped,
  freedBytes, usedBytes, limitBytes, freeBytes, note? }`. Entry lists are
  capped at 50; counts describe the complete operation. `truncated: true`
  means the 100,000-entry walk stopped early; retry to visit remaining paths. Skips carry
  `{ path, reason }`, including `linked`, `outside`, `not_turn_temp`, `missing`,
  `symlink_in_path` and `io_error`. Files already linked in this turn's answer
  are kept for promotion unless named paths use `force: true`; purge-all
  cannot override that guard. Each purge emits a validated `turn_temp_purge`
  governance event (see [HTTP kinds](../http-api.md#governance-event-kinds)).

The sandbox note states the admitted allowance and names this tool. Tool
results/context warn once at 80% measured use, and an out-of-space message
names `turn_temp`. Admission refusal remains `worker_state_busy` with Retry;
this tool grants no access to canonical or persistent scratch/workspaces.

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
core tools (the eight document tools, then the six `brain_compute_*` tools from 0.45.0), in module config order and then declaration order. A loader
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

## Durable inbox bridge tools (additive, #685)

Both first-party backends attach `inbox_list`, `inbox_get`, `inbox_add`,
`resolve_action` and `complete_share` to their existing UI bridge. Claude names them
`mcp__brain-ui__<name>` and loads their schemas and executors eagerly; pi
attaches plain names to its session toolkit. Shared contracts are exported
from `@schlessera/brain-ui-sdk/tool-contracts` and `/server`.

| Tool | Input | Result inside a nonce-delimited, data-only inbox record |
| --- | --- | --- |
| `inbox_list` | `view`: `queue` or `actions`; optional `threadId`; integer `limit` 1–100, default 50 | `{ items, threads }`, in store priority order, capped by `limit` |
| `inbox_get` | `itemId` | `{ item, thread }` |
| `inbox_add` | `text` (1–32000 characters); `idempotencyKey` | `{ created, threadId, itemId }` |
| `resolve_action` | `sessionId`, `itemId`, `optionId`, positive integer `expectedVersion` | `{ replay, followUpId? }` |
| `complete_share` | `receiptIds` (1–32 distinct IDs); `files` (0–10 exact original dispositions) | `{ itemId, status: "done", replay }` |

IDs and keys are nonempty strings of at most 256 characters. Inputs are strict
objects; origin, principal, trust, policy and effects are never tool arguments.
Intake still enforces its byte and staging limits. Tool failures reject in pi
and return an MCP error in Claude.

Every executor rechecks the durable principal and current turn. Interactive
reads use the authenticated UI's scope; autonomous reads are restricted to the
server-selected origin thread from the admitted budget item and cannot widen
it with a tool argument. An activity-linked item sharing a run ID cannot
select the origin or grant read scope. Under provider folder masks an
autonomous read first revalidates its origin thread's provenance admission
(#2741) and refuses with `provider_masked` when the thread or policy no longer
qualifies.
`inbox_add` reuses compensated CLI intake for authenticated interactive
origins, and refuses an untrusted origin thread. Its key is scoped to principal
and turn: retries with identical text return the same item; different text
under that key refuses. It stages triage work and grants no operation authority.
In a turn with an admitted protection set, staging, publication and every
compensation refuse a protected target, ancestor, descendant or link alias
with the application route's `policy_denied` refusal (#2876). Refused before
staging, it stages nothing and creates no item; a compensation refused after
a link moved its arrival into a protected path leaves the arrival and its
cleanup receipt in place.
Voice and restricted memberships allow reads and refuse both mutations.
Autonomous rosters remain exact server-selected authority.

Resolution requires a server-held approval bound to the live session, Action,
option, original version and exact stored effect. It reuses the UI resolver's
fresh operation authorization and deterministic replay transaction; it calls
no inference and creates at most one follow-up. V1 never mints a discuss
binding: ordinary and autonomous sessions refuse `resolve_action`. Deferred
`open_session`/`write_policy` and hygiene's separate UI preview are unavailable
through this tool. A future bound flow must supply an explicit exact approval;
the tool name or an extra permission tap alone cannot establish that binding.

### Interactive share completion (additive, #1764)

The confirmed client sends the intake's UUID as `chat_message.shareId`, outside
the quoted prompt. The host matches the immutable authenticated intake principal
and share provenance, claims the original triage item using its existing
version/attempt/lease lifecycle, and persists the resulting session binding.
It accepts no model-selected item ID, trust class or operation grant. Racing
owners refuse. A repeated confirmed intake resumes its server-selected existing
session; a caller asking for a different session refuses. Recovery uses that
same session and item. A share whose start ended before a
session was named can start again after lease recovery.

The device retains its confirmed review until the matching `requestId` receives
`session_info`, after the durable binding exists. Refused sends, disconnects
and unconfirmed admission retain the copy. Repeated authenticated
`POST /api/share` returns optional `ShareIntakeResult.filingSessionId` only to
the original intake principal when a bound session exists. The client opens
that session for recovery without dispatching another filing turn, including
a lost acknowledgement or reload after partial or completed filing. This is
read-only recovery, not authority to complete the item or apply content.

For a bound session, successful authoritative applications return an optional
`BrainApplicationResult.shareReceiptId`. Each receipt belongs to the source
item and records actual document paths and hashes. An intake admits at most
32 bounded application records; reaching that limit refuses additional filing. Equivalent validated
application effects replay their original result without applying again, including
a freshly read base hash after a lost response. A proven no-effect failure may
retry only under a fresh bounded server claim, with current operation authority
and approvals; repeated delivery within one claim keeps its original refusal. An
interrupted application with an uncertain result refuses replay and preserves
originals for inspection; it never guesses success or retries the side effect.

`complete_share` takes no session or item ID. The server selects both from the
live bridge, rechecks principal/turn authority and verifies each receipt against
current authoritative document bytes. The filed Markdown must include
`<!-- share-source:INTAKE_UUID -->`, identifying the source association; this
marker alone cannot create a receipt or grant authority. Unrelated or forged
receipts, destructive effects, changed documents and incomplete intake refuse.

Each original requires exactly one strict disposition object. Retention uses
`{ sourcePath, disposition: "retained", path }`: `path` must be an ordinary
`assets/` file with the original intake hash and a Markdown link in a filed
document that resolves to `path` from that document's folder: document-relative
(`../../assets/x.pdf` from `a/b/note.md`), brain-root-absolute (`/assets/x.pdf`)
or root-relative from a root-level note (`assets/x.pdf`), percent-encoded or in
`<…>` when the path has spaces. Inline links, images and reference definitions
count; links inside code spans or fenced blocks and wiki-links do not, since
wiki-links resolve only to Markdown documents. A refusal names the expected
target and an example link (accepting these link forms is additive in 0.45.0).
When several receipts cover one path, the one matching its current content
proves it; a path no passed receipt matches refuses, naming those receipts.
Discard uses `{ sourcePath, disposition: "discarded", reason }`, with
a nonempty reason capped at 1000 characters, and requires the existing exact
interactive approval. Missing files, aliases, changed originals and unsupported
retention refuse. The operation promotes no binary and grants no new writer.

Completion atomically records the exact request and transitions the owned item
to `done` once. Replaying that request returns `replay: true`; a changed replay
refuses. Later ordinary work in the same chat remains available. Partial or
cancelled filing retains originals and durable replay restrictions, and a
dispatcher cannot acquire the bound item. Cleanup is journaled only after
verified completion and live worker unwind, then retried through the existing
compensation lifecycle. The path also works with dispatch disabled. Voice,
restricted and unbound sessions cannot complete interactive shares.

<a id="reference-source-and-managed-worktree-tools-additive-0440-2432"></a>

## Apify tools (additive, 0.45.0, #3162)

Seven tools reach Apify, with the same names, strict input schemas and
envelope on every surface that offers them: the core MCP server (`brain mcp`),
and both first-party chat backends' bridges (Claude names them
`mcp__brain-ui__<name>` and loads them eagerly; pi attaches plain names). Each
calls the operation `brain apify <operation> --json` calls
([CLI component](cli.md#apify-operations-additive-0450-3162), which documents
every input bound and `data` shape).

| Tool | Input |
|---|---|
| `brain_apify_discover` | `query` (1–80 characters), `limit?` (integer 1–10) |
| `brain_apify_inspect` | `candidate` (1–64 characters) |
| `brain_apify_prepare` | `candidate`, `input` (object), `max_charge_usd` (positive, at most 1,000,000) |
| `brain_apify_run` | `proposal` |
| `brain_apify_status` | `run` |
| `brain_apify_results` | `run`, `cursor?` (1–64 characters), `limit?` (integer 1–100) |
| `brain_apify_abort` | `run` |
| `brain_apify_availability` | `actor_id?` (immutable id) |
| `brain_apify_approvals` | empty object |
| `brain_apify_revoke` | `actor_id` (immutable id) |

Inputs are strict objects: an Actor id, URL, token, run option or any other
field is invalid. The result is the envelope `{ ok, operation, data }` or
`{ ok: false, operation, error: { code, reason, message } }`, a tool error when
`ok` is false. On the core server it is also `structuredContent`; a schema
violation is an error result without it, as for every core tool. Discovered
Actor schemas, READMEs and results are returned as data marked
`untrusted: true`; no tool is ever added or removed for an Actor, and the
roster is fixed for a server process and for a chat session.

On the core server the operator's own policy, `APIFY_TOKEN` and
`BRAIN_APIFY_LEDGER` apply, as for the CLI; the session is `default` and
nobody can be asked, so a run needs a remembered Actor approval for its principal. In the chat
backends the host takes principal, session, turn, posture and approvals from
the authenticated turn and holds the credential and the ledger; the worker
sends the input only. The tools are in every interactive session's fixed
roster, after the reference tools, and auto-allowed: the host raises a per-use
`command` approval for each discovery or inspection under `ask`, and an
`actor` approval for a run without a remembered Actor approval. A remembered tool grant authorizes none of them.
Voice and no-grant-surface turns refuse them at call time; restricted
autonomous rosters do not include them; the host refuses any non-interactive
turn with `policy_denied`. A chat worker that also loads the
brain's own `brain mcp` sees that server's `brain_apify_*` tools too (deferred,
as every core tool is there); they refuse, because the worker holds neither
the token nor the ledger. A run is refused as `accounting_unavailable`
(`session_unbound`) until the conversation is named, so the turn budgets can
attribute its liability. A turn's cancellation, timeout or budget stop aborts
the runs it started.

Availability and approval-list tools advertise read-only MCP annotations;
revoking an Actor approval advertises a mutation.

Three additive tools complete the fixed roster in #3580:
`brain_apify_availability` accepts `{ actor_id? }`, `brain_apify_approvals`
accepts `{}`, and `brain_apify_revoke` accepts `{ actor_id }`. Actor ids are
immutable, 1–64 alphanumeric characters. Results use the same envelope and
[operation shapes](cli.md#apify-operations-additive-0450-3162). Availability
is advisory and consumes no run approval. Actor schemas and outputs remain
data; credential-extraction scanning applies to Actor input and output.

Since #3624, each approval-list entry also includes `candidate: string | null`
([CLI result shape](cli.md#apify-operations-additive-0450-3162)). A non-null
reference lets this session inspect and prepare the remembered Actor without
searching the catalog again. It carries no execution permission. References
remain principal/session/account-bound and all normal policy and spend checks
apply.

Shared agent guidance checks remembered approvals first and reuses a suitable
Actor after inspection. If none fits and several new Actors do, the agent
compares the best 3–5 (two if only two fit), explaining owner/name, task fit,
available pricing and uncertainty, and limitations. It waits for a user choice
before preparing or running one. Chat uses the existing `ask_user_form`
single-choice node, which can present five options; other clients can ask in
conversation. Cancellation selects nothing. This is agent orchestration, not a
new admission mechanism: selecting an Actor neither approves a run nor creates
a remembered approval.

## Reference source and managed worktree tools (additive, 0.44.0, #2432)

Both first-party backends attach `reference_source` and `reference_worktree`
to their existing UI bridge. Claude names them `mcp__brain-ui__<name>` and
loads them eagerly; pi attaches plain names. Both stay in every interactive
session's fixed roster, after `turn_temp`; a turn without a host handler
refuses the call instead. They are auto-allowed: the host decides authority on
every call. Restricted autonomous rosters do not include them. Shared contracts
are exported from `@schlessera/brain-ui-sdk/tool-contracts` and `/server`.

| Tool | Input | Result |
| --- | --- | --- |
| `reference_source` | `repository` (1–2048 characters: https without credentials, loopback http or absolute `file://`), `revision` (1–200 characters, a branch or tag) | `{ ok: true, source, guidance }` |
| `reference_worktree` | `action`: `request` (with `repository`, `revision`), `access`, `renew` or `release` (with `worktreeId`, 1–64 characters), or `list` (no other field) | `{ ok: true, action, worktree, guidance }`; for `list`, `{ ok: true, action: "list", worktrees, truncated, guidance }` with at most 20 worktrees, most recent activity first |

Inputs are strict objects: an action given a field it does not take, or
missing one it needs, is invalid. Principal, profile, brain, session, worker
generation and paths are never inputs; the host takes them from the
authenticated turn, and another principal's worktree identity reads as
`missing`. A refusal is `{ ok: false, code, message }`, a tool error on both
backends, with `code` one of `unavailable`, `unauthorized`, `missing`,
`invalid`, `capacity`, `busy`, `released` or `cancelled`. Messages are at most
500 bytes; one that could name a host path is replaced by a fixed message for
its code, as is a stale source's `error`.

`source` is `{ repository, revision, domain, commit, path, freshness,
refreshedAt, validatedAt, error }`. `freshness` is `fresh` or `stale`; a stale
source carries the refresh `error` and its unchanged `refreshedAt`. `path` is
`/tmp/brain-reference/<public|private>/<name>` when this turn's workers bind
that view, else `null`. The source is read-only and moves: a later read of the
same path may see a newer commit. Before a turn's workers bind a view, every
source in it whose five-minute validation lapsed, or has less than a minute
left, is validated again; one that fails is withheld until a request validates
it, and a running reader's later lookups of it fail until then. One turn keeps at most 32
distinct sources; a further one is refused as `busy`.

`worktree` is `{ id, repository, revision, domain, startingCommit, state,
path, lastActivityAt, expiresAt, releasedAt, allowanceBytes }`. `state` is
`active`, `expired` or `released`. `path` is `/tmp/brain-worktrees/<id>` only
while this turn's worker generation holds the worktree, else `null`. `request`
and `access` grant it to the turn and need a worker generation; without one the
call refuses and nothing is allocated. Only `request`, `access` and `renew` move
`lastActivityAt`. `release` is final. Times are ISO 8601.

Interactive governed and strict turns have the tools; a voice turn may read
source and `list`, and refuses the other worktree actions. Each call runs
through the reference services, which check authority again
([managed worktrees](../decisions/managed-worktrees.md#agent-tools)).

## External compute bridge tools (additive, 0.45.0, #3108)

Both first-party backends attach six host-executed tools to their existing UI
bridge: `brain_compute_health`, `brain_compute_plan`, `brain_compute_run`,
`brain_compute_status`, `brain_compute_cancel` and `brain_compute_collect`.
Claude names them `mcp__brain-ui__<name>` and loads them eagerly; pi attaches
plain names. They stay in every interactive session's fixed roster, after
`reference_worktree`; a turn without a host handler refuses the call instead.
They are auto-allowed: the host decides authority and shows its own card for a
run. Restricted autonomous rosters do not include them. In every Claude
session the in-worker brain server's `mcp__brain__brain_compute_*` tools are
disallowed, so a hosted turn reaches external compute only through the host.

Inputs are exactly the strict inputs of the
[MCP tools of #3107](#external-compute-tools-additive-0450-3107), and results
their envelopes, with two host differences: a collect's artifacts carry no
`file` (no host path reaches the agent), and every bound credential value is
redacted. Principal, session, turn, policy, posture, profile, brain, state
directory and credentials are never inputs; the host takes them from the
authenticated turn. A job belongs to its conversation: a later turn of it may
check, cancel or collect the job, whichever principal the host authorized for
that conversation (a re-login is recorded on the job's Activity run), and any
other conversation gets `job_unknown`. Input that does not parse, an extra key included, refuses
`policy_denied` before the host sees it; a turn without a handler refuses
`compute_disabled`.

A run on an interactive typed turn asks for approval on a `command` card,
every time, naming the instance, provider, lease, cost estimate or that it is
unknown, retention, source files with their hash, argv, environment variable
names, artifacts and whether the conversation is tainted; an edited card is a
refusal. A voice turn, a turn without a grant surface and a turn with no
client connected refuse `approval_required` without a card; a plan answers
the same, without a card. Hosted runs accept only built-in providers and
credentials the operator bound on the host; a provider value or an unbound
`apiKeyEnv` is `provider_unavailable`. A `.env*` file, a Tier A protected
path, and a source or `cwd` hidden by the turn's provider masks are
`source_refused`. A job outlives a turn that ends normally; a cancelled,
timed-out, budget-stopped or revoked turn cancels its jobs, including one it
was still starting, before anything is allocated. The rules and
their reasons are in [the compute decision](../decisions/external-compute.md#settled-by-3108).

## `read_attachment` (additive, 0.45.0, #3154)

Both first-party backends attach one host-executed tool to their UI bridge:
`read_attachment`, named `mcp__brain-ui__read_attachment` on Claude (loaded
eagerly) and `read_attachment` on pi. It is in every interactive session's
fixed roster, with or without attachments, so an upload never changes the
tools; a turn without a host handler gets `outcome: "unavailable"`. It is
auto-allowed: the host authorizes each call. Restricted autonomous rosters do
not include it.

Input, a strict object (`READ_ATTACHMENT_INPUT_SCHEMA`):

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | The attachment id from the message's `<brain-attachments>` block. |
| `pages` | string, optional | PDF only: `"3"` or `"3-7"`, at most 20 pages. Default: pages 1–20. |
| `cursor` | string, optional | An earlier result's `next`. Not combined with `pages`. |

The result (`AttachmentReadResult`) is one JSON line of facts, followed, when
text was returned, by the text inside an
`<<<attachment-data-<nonce>` … `attachment-data-<nonce>>>>` delimiter:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `kind` | The original, as recorded; `name` and `kind` are absent when the id was refused. |
| `outcome` | `read`: the requested scope in full. `partial`: an output bound cut it (`truncated`, `next`), or some pages had no text (`pagesWithoutText`). `no_text`: a valid PDF with no extractable text in the scope; no OCR is run. `encrypted`: a password is needed; none is supplied. `malformed`: not a readable PDF, or not valid UTF-8. `failed` (`reason`: `timeout`, `resource_limit`, `crash` or `error`). `unavailable`: no reader for this kind, or none could start. `changed`: the bytes no longer match the recorded digest; nothing is returned. `refused`: unknown id, not sent to this conversation, deleted, a bad range or cursor. |
| `scope` | `{ pages: [first, last], pageCount }` for a PDF, `{ bytes: [start, end), totalBytes }` for text. A result never claims more than it covers. |
| `pagesWithoutText`, `truncated`, `next`, `message`, `reason` | As above; `message` is one sentence. |

Every outcome except `read` and `partial` is a tool error. Text pages open with
`[page N]`, or `[page N, continued]` when a cursor resumes inside a page. Text
is cut on a code-point boundary at 65,536 UTF-8 bytes per call and 262,144 per
turn; past the turn's budget the result is `partial` with an empty text and a
`next` for a later turn.

Only originals a **message of the calling session** references are readable:
draft and outgoing bindings are not. Each call rechecks the record, that the
file is a regular file under the attachment store reached through no link, its
size and its SHA-256. Session, principal and turn come from the authenticated
turn and are never inputs. Each call taints the session as `chat_attachment`,
whatever its outcome. The read appends an ordinary tool result; no earlier
message, tool or system text changes, and the host's read records are UI data
that never reach the provider. The bounds and reasons are in
[the attachment decision](../decisions/chat-attachments.md#what-3154-built).

## Host-owned web tools (additive, 0.45.0, #3685)

The pi backend's ordinary governed and strict interactive sessions list four
host-executed bridge tools: `web_search`, `fetch_content`,
`get_search_content` and `source_check`. Their names and parameters follow the
pinned upstream pi-web-access tools, narrowed to what the host admits. They
are in every interactive session's fixed roster, whether or not the host can
run them. On a host without a web executor, the gate refuses each call before
it runs, with no card. No autonomous roster lists them, restricted or not. The
Claude backend is unchanged and keeps its own `WebSearch` and `WebFetch`.
They are auto-allowed like Claude's: the host binds and bounds every call.

Inputs are strict objects (`WEB_SEARCH_INPUT_SCHEMA`,
`FETCH_CONTENT_INPUT_SCHEMA`, `GET_SEARCH_CONTENT_INPUT_SCHEMA`,
`SOURCE_CHECK_INPUT_SCHEMA`):

| Tool | Fields |
| --- | --- |
| `web_search` | exactly one of `query` or `queries` (at most 4), plus optional `numResults` (1–20), `includeContent`, `recencyFilter` (`day`, `week`, `month`, `year`), `domainFilter` (at most 10), `category` and `provider` |
| `fetch_content` | exactly one of `url` or `urls` (at most 5 absolute `http(s)` URLs), plus optional `mode` (`readable` or `raw`) |
| `get_search_content` | `responseId`, plus optional `query`, `queryIndex`, `url`, `urlIndex`, `offset`, `limit` (at most 30,000 characters), `findText` (one string or at most 10) and `findMode` (`exact`, `case-insensitive`, `fuzzy`) |
| `source_check` | `claim`, plus optional `queries`, `numResults`, `fetchContent`, `recencyFilter`, `domainFilter` and `provider` |

Each text field holds at most 500 characters and each URL at most 2,048, and a
serialized input is at most 16,384 bytes (`WEB_TOOL_LIMITS`). `provider` names
one id from the curated catalog (`WEB_TOOL_PROVIDERS`, the same ten ids as
`WEB_SEARCH_PROVIDERS`) or a list of at most 3, or `auto`. The host
additionally refuses any provider it does not admit, and always refuses `all`.
No field selects an endpoint, proxy, command, local path, credential or
browser profile: `proxy`, `forceClone` and `redirects`, like any other unknown
field, are `invalid_input`. Upstream parameters for deferred workflows and
excluded credential modes are recognised and answered `unsupported` with the
`feature` they name: `workflow` other than `none` on `web_search`, and `mode:
"answer"`, `prompt`, `answerModel`, `timestamp`, `frames`, `model` and `auth`
on `fetch_content`.

The result is one JSON envelope (`WebToolEnvelope`) as the tool output:
`{ ok: true, tool, text, responseId? }`, or `{ ok: false, tool, error: { code,
message, feature? } }` as a tool error. `text` is external content. The codes
(`WEB_TOOL_ERROR_CODES`) are `invalid_input`, `unsupported`,
`provider_not_admitted`, `unavailable`, `unknown_handle`, `replayed_call`,
`busy`, `request_too_large`, `response_too_large`, `cancelled`, `deadline`,
`executor_died` and `failed`.

A `responseId` is an opaque handle the host issues. It is scoped to the
calling principal and session and to the executor session that stored the
content, and it ends when that executor ends. An executor's own result id
never reaches the model. A guessed, foreign or expired handle is
`unknown_handle`, with nothing saying which. Principal, session, turn,
tool-call id, worker profile, policy revision and cancellation come from the
authenticated turn and are never inputs. A tool-call id runs once per turn.
Each call taints the session (`web_search` or `web_fetch`) before it runs, and
its result is recorded before the model receives it. A call appends an
ordinary tool result; no earlier message, tool or system text changes.

## Hosted policy proposal (additive, #1662)

`propose_policy_change` (Claude: `mcp__brain-ui__propose_policy_change`)
accepts exactly `{ content, rationale }`: complete governance.md, bounded to
1 MiB of UTF-8, and a trimmed nonempty one-line rationale of at most 500
characters. It is available only through an interactive hosted bridge,
including ordinary interactive dictation. It is absent from genuine voice
and autonomous rosters and excluded from bridge auto-allow lists.

The server validates the governance schema before raising a per-use approval
card. Invalid input returns errors and creates no card. The native permission
checkpoint delegates to this validation/write route; the eventual tool handler
reconciles the same tool-use identity rather than executing a second write.
A remembered tool grant cannot authorize a policy change. Speech never grants.

A valid card names the exact base hash (null for no file), frontmatter diff,
changed section names, body-change indicator/body diff and quoted agent
rationale. Decline writes nothing. Approve and write revalidates under
`BRAIN_LOCK_KEY` and checks current turn/principal authority, exact bytes and
anchored target topology again at publication. This is a server-owned write;
native and application policy-path restrictions remain unchanged. The
journal records actor `user`, class `policy`, and the server records a
`policy_change` governance event. The next admitted turn reads the new policy;
a running turn keeps its frozen policy.

The result is the same `PolicyChangeReview` the authenticated read-only receipt
route returns. Stale/invalid/refused consumes approval and needs a new proposal.
Unknown completion is reconciled with Check again on the original request;
it never resubmits a write. Duplicate identical requests return that request's
receipt; a changed input cannot borrow its identity or approval.
