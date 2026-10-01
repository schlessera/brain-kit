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

## Explicit autonomous backend turns (#675)

The optional server-only `StartTurnRequest.autonomous` request is additive. It
contains `{ origin: "autonomous", persistence: "none", allowedTools: string[],
systemPromptAppend: string }` selected by server code. It requires the enforced
no-grant posture and synchronous `BackendBridge.checkpointPermission`. It rejects
resume, invalid mode declarations and unsupported backends before runtime work.
`BackendCapabilities.autonomous?: boolean` advertises this specific turn support;
it does not advertise containment or enable autonomous dispatch.

Ordinary requests retain their persistence and `session_info`/terminal semantics.
Autonomous requests save no SDK session/history and advertise no interactive
session. Their runtime id reaches Activity via the additive
`BackendActivityEvent` variant `autonomous_identity`, and scopes content/result
frames internally. Exactly one terminal result ends an established runtime turn;
pre-identity failures may end on a bare error. Principal revocation aborts work
visibly. No client/model wire payload selects this mode or its authority.

The Activity origin vocabulary adds `"autonomous"` for spans and run rollups.
The SDK schemas accept it, and existing origin filtering selects these runs
without including interactive or cron work. Runtime identity, usage and principal
attribution remain recorded; unknown prices retain their existing unknown meaning.
The synchronous synthetic bridge captures escalation data before no-grant denial
and aborts without parking. Durable Action transitions, reservation admission,
containment and full-system enablement remain separate gated tasks.

## Autonomous admission configuration (additive, #678)

`ServerConfig.inbox.budget?` adds `{ spendUsd: number, turns: number,
emergencySpendUsd: number, emergencyTurns: number, timeZone: string,
unpricedUsdPerToken: number }`. It remains optional for embedded configurations.
`resolveServerConfig()` supplies defaults of 5 USD, 0 operations, zero emergency
capacity, UTC and 0.01 USD per unpriced token. The six `BRAIN_UI_AUTONOMOUS_*`
environment settings and validation are specified in [the budget guide](inbox-budget.md).
Omission or zero turns cannot enable autonomous dispatch.

The cap governs new admissions against charged spend plus active conservative
reservations; observed overruns are retained. It is not a provider-enforced
invoice ceiling. One separately dispatched model-bearing operation counts one
turn. Actual billing evidence, unknown-cost charging, frozen admission days and
crash recovery follow the [async decision](decisions/async-collaboration.md#scheduling-budgets-and-evidence).
The reservation ledger is internal operational storage. Existing HTTP, wire,
SDK turn-request, CLI/MCP and content-index shapes remain unchanged; full-v1
containment and system proof still gate production dispatch.

## Consumers

| Consumer | Surfaces used |
|----------|---------------|
| brain-ui (`packages/ui-server/src/brain/client.ts`, `packages/ui-server/src/graph/reader.ts`, `packages/ui-server/src/cron/emit.ts`) | CLI `--json` commands, brain.db reads (voice keyterms; the `links` and `graph_*` tables for the knowledge graph), file paths |
| Coding-agent sessions (MCP) | MCP server tools, CLI |
| Cron on a hosting container | `brain maintain`, module cron entries (`brain jobs scrape` …) |

## Model reranker activation

**Approved pre-1.0 breaking behavior change (#406):** judgment reranking now
requires `reranker.enabled: true` in canonical `brain.config.ts` or
`brain.config.json`. Omitted or false means off, even with credentials, a
provider, `--rerank jev`, MCP `rerank: "jev"` or `BRAIN_RERANK_MODE=jev`.
The boolean is runtime validated; provider is optional (default `jev`).
The same setting governs CLI search/context/process, MCP search/context,
eval and configured library/backend access. Direct `hybridSearch` injection
also requires `SearchDeps.rerankerEnabled: true`; provider construction through
`resolveReranker` alone does not activate it. `rerankSetup` forwards the flag.

Off uses local lifecycle `heuristic` ordering, or retrieval order for `none`.
An explicit model-mode request warns and falls back; eval refuses disabled
flag/environment requests with exit `2` and no score, including context eval.
Dry-run previews can be constructed while disabled or keyless and send
nothing. Enabled behavior retains missing-key fallback, deadlines,
cancellation, exclusions, provider-result validation and degraded warnings.
No JSON envelopes, MCP names/schemas or frontmatter fields change.

Migration: add `enabled: true` to retain former credential-triggered model
ordering. Toggling it off preserves provider/model/key-variable/exclusion and
bound fields; re-enabling reuses them. New CLI processes reload config;
running MCP/embedding hosts restart or rebuild their context from newly loaded
config (TypeScript imports require process restart). See
[configuration](configuration.md#reranker) and the
[decision](decisions/reranker-activation.md) for the retained provider seam
and measurement limits.

## Travel ownership and canonical content

**Approved pre-1.0 breaking ownership change (#566):**
`@schlessera/brain-module-speaking` contributes `talk` and `conference`;
`@schlessera/brain-module-travel` owns the existing `travel` type and
`plan-travel` skill, and adds `trip` and `place`. The
[maintainer ruling](https://github.com/schlessera/brain-kit/issues/60#issuecomment-5869107262)
requires existing content paths, type values, links and travel-party settings
to survive. Both modules retain the shared `status.md`, `itinerary.md` and
`outline.md` directory anchors; travel alone has no speaking deck exclusions.

Install and enable travel before indexing an upgraded speaking-only brain.
Run `brain travel migrate --dry-run --json`, then apply without `--dry-run`,
restart the process and sync skills. The explicit source migration moves the
complete literal `travelParty` field between the canonical package-keyed
config blocks; JSON and directly exported TS literals are supported.
Existing equal values are deduplicated, conflicting or dynamic values are
refused without writes. Content is never rewritten. Speaking temporarily
accepts deprecated `travelParty` and warns when it is nonempty. Existing
`settings/speaking.json` or `settings/travel.json` also causes refusal: #528
owns future JSON precedence and its shared writer. See the
[upgrade instructions](../packages/module-travel/README.md#upgrade-from-speaking).

Additive travel frontmatter: a `trip` has `trip_status` (`proposed`, `done`,
`dismissed`), optional routes and repeated visits; a done trip has at least
one visit. Visit identity is the owning document's root-relative `.md` path
plus its unique lowercase-slug `id`, independent of date or party. A nonempty
route list has unique labels and exactly one primary; visits name those
labels. `cover`, route GPX and visit tracks/photos resolve relative to their
document within the brain root. Places have `place_kind` (`country`, `city`,
`town`, `spot`), optional parent and coordinates, and references to canonical
visits. Country → city/town → spot ancestry must resolve without cycles.
An existing journey needs no new fields. The full
[field formats](../packages/module-travel/README.md#canonical-formats) apply.

Visit dates and coordinates stay omitted or null when unknown; `(0, 0)` is
valid. Place counts deduplicate canonical document/visit pairs, including
references from both places and journeys/trips. Stored `visit_count`,
`first_visit`, `last_visit` are display caches and never authority. Bounds
are null if any included date is unknown, and counts still include those
visits. Domain validation uses `brain travel validate`; ordinary
`brain validate` retains its common metadata and wiki-link checks. No schema
version, MCP tool, existing core envelope or database authority changes.
The [decision](decisions/travel-module.md) explains the boundary.

## Travel photo copies

**Additive CLI contract (#567):** `brain travel photo <files> --to <dir> --json`
returns `{photo: {files, errors}}`. Each file has `source: string`,
`output: string`, `width: number`, `height: number`, `bytes: number`,
`captured_at: string | null`, and `location: {lat: number, lon: number} | null`.
`source` is the unchanged input argument; `output` is a root-relative path with
forward slashes. Dimensions and byte length describe the completed JPEG.
Each error has `{source: string, message: string}`; messages are prose.
Both arrays preserve their inputs' relative order.

Capture values come from the original EXIF before stripping. `captured_at`
contains a real calendar date/time in ISO form, with written fractional seconds
and offset retained. Without a written offset it remains local ISO text; no
timezone is inferred. Missing/invalid dates are `null`. A location requires a
finite latitude/longitude pair in −90…90 and −180…180; valid zero values survive,
and unknown/invalid pairs are `null`. No sidecar or content record is written.

Sources resolve from the brain root, or from an explicit absolute path. Their
bytes are unchanged. Outputs stay inside the brain; symlinked output directories
and destination entries are refused. Copies apply EXIF orientation to pixels,
preserve aspect ratio, cap the long edge at 1600 without upscaling, flatten
transparency on white and encode sRGB JPEG with mozjpeg quality 80. Input EXIF,
GPS, XMP, ICC, IPTC and comments are removed. Unsupported raster codecs,
vector documents and animated/multi-page images produce input errors.

Names use the source basename with `.jpg`, then `-2.jpg`, `-3.jpg`, etc.
Exclusive publication of completed bytes preserves every existing destination,
including a source already in the output directory. Hard-link support is
required. Temporary cleanup failure after publication does not misreport a
completed copy as failed; a hidden sibling can remain.

Exit `0` means all inputs succeeded. Exit `2` means input failures, with the
same envelope containing any successful copies. Exit `1` means usage or
output-directory refusal before processing, with stderr and no success envelope.
`--human` displays paths/dimensions and stderr errors. `--` terminates options.
The [photo guide](../packages/module-travel/README.md#photo-copies) documents runtime
requirements. No schema version, MCP tool or existing envelope changes.

## Asynchronous UI startup

**Approved pre-1.0 breaking API change (#286):**
`createApp(options?: CreateAppOptions): Promise<BrainUiApp>` from
`@schlessera/brain-ui-server` replaces the synchronous factory. Consumers
must `await createApp(...)` before reading the handle or passing its `fetch`
and `websocket` to `Bun.serve`. Startup refusals now reject the promise, so
catch them around the awaited call. There is no synchronous compatibility API.

The experimental `BackendModule.probeRuntime?(context: BackendModuleContext)`
from `@schlessera/brain-ui-sdk/server` now returns
`Promise<BackendRuntimeReport>`. Descriptor authors make their implementation
asynchronous and reject when their required runtime is unavailable. The
server awaits active backend probes, then the brain CLI version probe, before
opening its database or starting application services. Injecting a registry
continues to bypass first-party backend probes without explicit backend
requirements, while retaining the brain CLI check and configuration validation.

Both built-in version probes run only `--version`, with a five-second deadline
and up to 250 ms of cleanup, subject to event-loop scheduling. At the deadline
cancellation sends `SIGKILL` through `killWrapped`, including the configured
group killer while the command is running. Killer-helper execution is bounded
to 200 ms for these probes. Probe settlement never waits indefinitely for exit,
inherited output pipes or the helper; incomplete cleanup is reported as
unconfirmed, not as proof that work stopped. Turn cancellation retains its
existing behavior. Printing a version before timing out does not count as
success. Claude runtime failure refuses startup; an unknown or unreadable
brain CLI version warns and continues by default, and a known incompatible
version refuses. Version report shapes and the default CLI floor are unchanged.

**Additive host requirements (#642):** `CreateAppOptions.versionRequirements`
accepts optional `brainCli` and `backends[backendId].sdk/runtime` full SemVer
minima. They cannot weaken package constraints. Validation and requested
identity checks precede app resource creation; unsupported injected backend
verification refuses startup explicitly. An explicit content-CLI minimum
refuses unknown versions and revalidates the actual executable before client
and streaming-sync invocations. Backend minima travel through the existing
`BackendModuleContext.versionRequirements` to probes and construction. The
shared server SDK helper retains every owner/declaration, upper bounds, OR
grouping and normal per-tuple prerelease opt-in. Compatibility remains separate
from measured status and index schemas; no wire/report fields change. Backend
factory and pre-prompt enforcement are the separately scoped #643.

## HTML renderer budgets

**Additive option (#558):** `linkPolicy?: "visible-destinations"` shares the
concrete template policy. Omitted preserves existing renderer/CLI behavior.
Enabled retains accepted web/mail navigation with validated visible destination
text, makes refused/unavailable targets inert and checks final screen/print
visibility with document scripts disabled. A destination still obscured/clipped,
or beyond the PNG capture bound, rejects rather than emitting an unchecked
artifact. PDF checks also cover the finished annotation's own complete tagged
disclosure, physical page bounds and a 9-point legibility floor; print clipping
or shrinkage rejects. Documents with accepted links also reject if a content
security policy blocks the protective stylesheet. Existing render budgets apply.
No target is fetched by this policy.
The app's `POST /api/render` always enables it server-side for both formats,
including raw/full/bare HTML; request content cannot opt out. Its injected
`AppRenderer` implementations must honor the supplied option's final-visibility
check. The request and response envelopes are unchanged.


The deliberately public `createRenderer` API of
`@schlessera/brain-render-puppeteer` accepts `RendererOptions` and returns a
`Renderer`: `renderPng({ html, width?, linkPolicy? })` and
`renderPdf({ html, width?, linkPolicy? })`
resolve to `Buffer`; `shutdown()` is terminal. Width is clamped to
320–4096 CSS pixels. The package README documents the remaining options.
This documents the renderer's intended API without classifying other exports;
the broader export inventory is tracked in #534.

**Pre-1.0 breaking behavior change (#72):** `renderTimeoutMs` now bounds page
creation, setup and PNG/PDF production, excluding queue waiting and browser
acquisition. `queueTimeoutMs` bounds waiting for a concurrency slot;
`browserTimeoutMs` bounds acquiring the shared browser, including a cold
launch. Defaults are 30_000, 60_000 and 30_000 ms respectively, so the maximum
request duration is their sum (120_000 ms), subject to event-loop scheduling.
Budgets are positive integers within the JavaScript timer range. Timeout errors
identify queue, browser acquisition or rendering; exact prose is not a machine
schema. Expired queue entries are removed and timed-out calls release capacity.
Shutdown rejects queued/new calls, drains active phases and bounds browser
closure to another 2_000 ms. It therefore completes within
`browserTimeoutMs + renderTimeoutMs + 2_000`, subject to scheduling. Default
network denial, disabled scripting and opt-in sandbox removal retain their
policy. The rationale and measurements are in
[renderer-budgets.md](decisions/renderer-budgets.md).

## CLI conventions

- Bin name: `brain` (stable). Runs under Bun.
- Output mode: JSON when stdout is not a TTY; force with `--json` / `--human`.
- Exit codes: `0` success · `1` usage error · `2` internal failure
  (`maintain` exits `2` if any step failed; `scratch clean|prune` exits `2`
  when a file could not be removed, with the JSON report still printed;
  `eval` exits `2` when a validity gate refuses the run, with nothing on
  stdout, and also on a usage error, so its `1` only ever means a failed
  `--baseline` gate; `3` is runs that are not comparable, the report still
  printed).
- Boolean flags never consume the following argument.
- End-of-options: a bare `--` stops flag parsing, and every later argument is
  positional verbatim. Output-mode and help flags after it are positional too
  (additive in 0.33.0).

### Stable `--json` shapes

| Command | Shape |
|---------|-------|
| `brain search "q" --json` | `{ "results": SearchResult[], "warnings": string[] }` — `warnings` reports degraded modes (no vectors, model mismatch, missing key, a reranker that did not run). `--rerank none\|heuristic\|jev`: `jev` added in 0.39.0, additively; unset, the configured `reranker.provider` (judgment requires `reranker.enabled: true`; otherwise local `heuristic`, or `none` when selected). `--rerank-dry-run` (0.39.0) prints the reranker's outbound request to stderr and sends nothing, even while disabled or keyless. Date filters `--updated-since`, `--updated-before`, `--deadline-from`, `--deadline-to` (`YYYY-MM-DD`, inclusive; a deadline filter drops undated docs), `--sort score\|updated\|deadline` (default `score`; `updated` newest first, `deadline` earliest first with undated docs last) and `--upcoming` (= `--deadline-from <today, UTC> --sort deadline`) added in 0.38.0, additively. Stored dates are compared as their UTC day (sorts keep full timestamp precision). A stored value counts only as an ISO `YYYY-MM-DD`, optionally followed by `T` or a space, `HH:MM`, seconds, a fraction and a `Z` or `±HH:MM` offset. Anything else, `2026-02-30` and `now` included, counts as missing: it matches no bound and sorts last. With a query, a date sort picks the results by date from a candidate pool: the full-text lane's best `max(limit × 20, 500)` documents, plus the documents behind the vector lane's nearest chunks (at most that many documents, from at most 500 chunks). An invalid date or sort is a usage error (exit `1`) |
| `brain audit --json` | `{ "issues": AuditIssue[], "errors", "warnings", "infos", "mustFix", "informational" }` — markdown documents only (assets excluded). The three severity counts are the number of issues at each severity. `mustFix` is `errors + warnings` and `informational` is `infos` (both additive in 0.40.0): severity stays the one classification, and the two totals only name its halves. Every count is of issues, not of markers. **Breaking in 0.40.0:** `todo` and `verify` issues are grouped, one per document and category (see [`AuditIssue`](#auditissue)), and `verify` is `info` instead of `warning`, so a brain with markers reports fewer issues and fewer warnings than before for the same content. With `--fix` the command prints fix suggestions instead, in a shape that is not part of this contract |
| `brain context "q" --max-tokens N` | assembled markdown context (text) |
| `brain read <path> [--section <heading>] [--max-tokens N]` | the document text; the flags behave as `brain_read`'s `section` and `max_tokens`, and an unknown section exits `1` (flags additive in 0.38.0) |
| `brain briefing` | briefing text (mechanical: deadlines, reviews due, silent edits — no LLM) |
| `brain index [--force] [--embeddings] --json` | `{ "total", "added", "updated", "deleted", "unchanged", "chunks", "embeddings", "assets", "graphMs", "graphNodes" }`, all numbers, each counting this run only. See [`brain index` counters](#brain-index-counters). Incremental by default, `--force` = full rebuild, `--incremental` accepted as no-op |
| `brain index --forget-cache <path> --json` | `{ "path", "forgotten" }` — `forgotten` is the number of sidecar lines removed for that document or asset (for an asset, every line for its bytes, whatever the title). Runs no index pass; the next `--embeddings` run regenerates what was forgotten. A path not in the index is a usage error (additive in 0.38.0) |
| `brain index --compact --json` | `{ "compacted", "before": { "live", "allocated" }, "after": { "live", "allocated" } }` — rebuilds `vec_chunks` from its live rows and runs `VACUUM`, reclaiming the slots deleted vectors leave behind; `before`/`after` have the shape of `brain stats` `size.db.vectorSlots`. `compacted` is `false` only when there is no vector table. Makes no provider call and runs no index pass (additive in 0.38.0) |
| `brain maintain --json` | `[{ "step", "result" }]` in run order: `registry`, `index`, `vectors`, `audit`, `stats`, `tags`, `git`, `scratch`. The `stats` step also carries additive `trends` (see "Recorded corpus trend verdicts"), evaluated before recording. The `stats` step (additive in 0.40.0) is `brain stats --record`: `ok — recorded <date> in .stats-history.jsonl (<n> snapshot(s) kept[, <m> older thinned])`, or `ok — replaced …` on a second run the same day. The `registry` step (additive in 0.38.0) is `brain registry`: `ok — <written> of <indexes> table(s) rewritten`, `FAILED — …` when an index's `registry:` block is invalid. `result` is a human-readable string that starts with `FAILED` when the step failed (and the exit code is `2`); the `tags` step never fails, and reports `skipped — …` instead. The `audit` step's result is `<errors> error(s), <warnings> warning(s), <infos> info(s); <mustFix> must-fix, <informational> informational`, the totals `brain audit --json` reports for the same run (the must-fix and informational part additive in 0.40.0; the counts follow the grouped `todo`/`verify` issues from 0.40.0). The `vectors` step (additive in 0.38.0) compacts the vector table the way `brain index --compact` does, only when fewer than half its slots are live and at least one internal chunk would be freed; otherwise it reports `ok — <live> of <allocated> slots live, nothing to reclaim`, and `skipped — …` when the slots cannot be read |
| `brain registry [--check] --json` | `{ "indexes", "written", "stale", "invalid": [{ "path", "error" }] }` (additive in 0.38.0). Regenerates the registry table of every `_index.md` whose frontmatter has a `registry:` block. `indexes` counts them, valid or not. `written` lists the files rewritten. `stale` lists out-of-date indexes left as they are: all of them under `--check`, which writes nothing, and otherwise one whose file changed between being read and being written (it is regenerated on the next run). `invalid` lists indexes that cannot be generated, which are left untouched: a `registry:` block that does not validate, an index or a child that cannot be read, whose frontmatter does not parse, or whose frontmatter opens and never closes (an `_index.md` whose frontmatter does not parse counts when it has a `registry:` line, quoted or not), or malformed region markers. Exit `1` under `--check` when anything is stale or invalid, `2` without it when anything is invalid, else `0` |
| `brain list --json` | `ListedDocument[]` — a bare array, newest `updated` first, `--limit` default 20. Filters: `--type`, `--tag`, `--status`, `--relevance` |
| `brain add "<content>" --json` | `{ "action": "created"\|"appended", "path", "title", "type", "indexed", "indexError"? }` — `path` is repo-relative. `indexed` is `false` when the file was written but the reindex after it failed, and `indexError` (a string) is present only then. `appended` means the content went under a new dated heading in an existing document of the same title and type. `--smart` hands the capture to the coding agent and prints its text instead |
| `brain sync` | `{ run, agent }` in machine mode (`--json`, or stdout not a TTY); its text report in human mode (`--human`, or a terminal). With no verb, `sync` runs `brain sync run`. When an agent runner is configured and the run needs one (a conflict no strategy merges, an `UNKNOWN` leftover, or a `MEDIA`/`LARGE` leftover with a terminal attached), it then runs the `/sync` skill and exits `0`. Without an agent runner the exit code is `run`'s: `0` complete, `1` failed, `3` something left for judgment: a conflict no strategy merges (left in progress, nothing pushed) or a file holding conflict markers (left uncommitted, never pushed). An agent run that fails exits `2`, its error on stderr. **Machine mode** prints exactly one JSON document on stdout, whatever the agent did, and nothing else: no report, no progress, no agent text beside it. `run` is the envelope `brain sync run --json` prints (its `status` and `report` are contract; its other fields drive the `/sync` skill and are not). `agent` is `{ invoked: false, reason: "not-needed" \| "no-runner" }` — `no-runner` when the run needed an agent and none was available — or `{ invoked: true, runner: string, outcome: "success" \| "failed", runtime: { name: string, version: string \| null } \| null, text: string \| null, error?: string }`. `runtime` is what that agent run reported about itself while it ran, never probed and never taken from another run: `null` when it reported nothing (a runner that does not report, or a run that ended first), `version: null` when it named itself without a version. The built-in `claude` runner reports `{ name: "claude-code", version }` from the Claude Code session's `system`/`init` event (`claude_code_version`), the field chat records as `runtime_observed`. A failed agent run still prints the result, with `outcome: "failed"`, `text: null`, `error`, and any runtime it reported before failing. Not invoking an agent says nothing about model cost: the sync judge and enrichment can call a model without one. **Human mode** prints the report, then the agent's final text when it ran, with tool progress on stderr. **Breaking in 0.40.0 (#290):** bare `sync` printed its text report in every output mode, so a caller that read stdout as text passes `--human`, or reads `run.report` and `agent.text`. **Breaking in 0.39.0:** it used to run the agent unconditionally, print only the agent's text, and exit `1` when no agent runner was available. The verb is the first positional argument, so output-mode flags may come before it: `brain sync --json` is still the bare form, and `brain sync --json assess` is `assess --json`. An unknown flag exits `1` (`Unknown flag: --x`). The mechanical verbs (`run`, `assess`, `group`, `commit`, `stash`, `pull`, `resolve`, `conflicts`, `conclude`, `push`, `post-sync`) follow the usual output mode — JSON when stdout is not a TTY or with `--json`, otherwise command-specific human-readable text — and their shapes, which exist for the `/sync` skill to drive, are not part of this contract |
| `brain module list --json` | `{ "enabled": [{ "name", "key", "description", "types", "commands", "tools": string[], "cron": [{ "name", "schedule", "command" }] }], "available": [{ "key", "description", "enabled": false }] }` — `key` is the module's `brain.config` key (a package name or `./path`). `types` and `commands` are the type names and CLI words it contributes. `description` comes from the module's `package.json` and is `null` when it has none. `available` lists `@schlessera/brain-module-*` packages the brain's `package.json` declares but its config does not enable; `description` is `null` there when the package is not installed. `cron` is shape-constrained (see [Guarantees](#guarantees-consumers-may-rely-on)) |
| `brain --version` | text: the core package's SemVer version and a newline, nothing else (`0.37.0`). `-v` is the same. Only as the first argument |
| `brain doctor --json` | `{ "checks": [{ "id", "status": "pass"\|"warn"\|"fail", "detail", "fix"? }] }` (new in brain-kit). Check ids other than `instructions-weight` are not part of this contract, and `detail` is prose. `instructions-weight` (added in 0.38.0, additively) estimates the tokens always loaded into a session (`CLAUDE.md` with its in-brain `@` imports, `AGENTS.md`, model-invocable skill descriptions), and is `warn` above the optional `brain.config` key `instructions.maxTokens` (default `8000`) |
| `brain init --check` | `{ "bun": { "version", "ok" }, "git": { "repo" }, "hooksPath": { "set", "value" }, "config": { "exists", "valid", "initialized", "path", "error"? }, "contentDirs": { "present", "missing" }, "keys": { "GEMINI_API_KEY", "ANTHROPIC_API_KEY" } }` (new in brain-kit). `bun.version` is `null` when not running under Bun. `git.repo` says whether the root is inside a git work tree. `hooksPath.value` is git's `core.hooksPath`, `null` when unset. `config.path` is `null` when there is no config, and `error` is present only when the config failed to load (`valid: false`). `initialized` is true only when the config declares something (profile, taxonomy, modules, embeddings), so a brain holding the template's empty starter config reads as `exists: true, initialized: false` (added in 0.37.0). `contentDirs` splits the core types' directories into those that exist and those that do not. Each `keys` entry is a boolean — whether that variable is set — never the key |
| `brain okf export --json` | `{ "outDir", "filesExported", "assetsCopied", "linksConverted", "linksDegraded", "degradedLinks", "indexFilesGenerated", "topLevelDirectories", "warnings" }` |
| `brain okf check [dir] --json` | `{ "directory", "ok", "filesChecked", "errors", "warnings", "issues": [{ "severity", "path", "message" }] }`; exit 1 when `errors > 0` |
| `brain scratch clean\|prune --json` | `{ "action": "clean"\|"prune", "removed": [{ "path", "bytes", "reason": "age"\|"size"\|"clean" }], "failed": [{ "path", "reason" }], "bytes", "files" }` — `path` is repo-relative; `failed` lists files the OS refused to remove (they are still there, and the exit code is `2`); `bytes` and `files` are what is left in the scratch area afterwards, those included (additive in 0.38.0) |
| `brain graph stats --json` | `{ "computedAt", "root", "nodes", "edges", "brokenLinks", "components", "reachable", "layoutSkipped", "algo", "communities" }` |
| `brain graph compute [--root <path>] --json` | `{ "nodes", "edges", "brokenLinks", "components", "communities", "root", "reachable", "layoutSkipped", "durationMs" }` |
| `brain graph export --mode clusters\|discovery\|local\|maintenance --json` | `{ "nodes", "edges", "truncated" }`, except `maintenance` → `{ "staleDays", "root", "orphans", "unreachable", "brokenLinks", "stale" }` |
| `brain stats --json` | `{ "documents", "byType", "byStatus", "byRelevance", "tags", "links", "brokenLinks", "chunks", "embeddings", "health", "size", "trends" }` — `trends` added in 0.40.0 (see "Recorded corpus trend verdicts"). `health` and `size` added in 0.37.0, additively. **Breaking in 0.37.0:** `embeddings` is retyped from `number` to `number \| null` — `null` when a vector table exists but could not be counted, `0` when there is none. It also changed value: it reports the real vector count on an embedded brain, where before it read `0` on every brain. Every other earlier field keeps its name and type |
| `brain stats --history --json` | `{ "dates", "recordedAt", "versions", "documents", "tags", "links", "brokenLinks", "chunks", "embeddings", "byType", "byStatus", "byRelevance", "health", "size", "trends" }` — `trends` is the core-owned comparison over the full recorded history; `--since` filters the arrays only. The snapshots `.stats-history.jsonl` holds, oldest first, as one array per field (additive in 0.40.0). `--since <YYYY-MM-DD>` keeps the ones on and after that day. See "Stats history" below |
| `brain eval [--set <file>] [--mode fts\|vector\|hybrid\|all] --json` | `{ "schema_version", "meta", "rows", "per_query", "warnings" }` — retrieval scores for a query set against this brain's index (additive in 0.38.0). See [`brain eval --json`](#brain-eval---json). Exit `2`, with nothing on stdout, when a validity gate refuses the run. With `--lint` (additive in 0.38.0): `{ "schema_version", "meta": { "set", "set_sha256", "queries" }, "warnings" }`, where `warnings` lists `paraphrase` queries that share a content word with an expected document's title. It does not score, never opens `brain.db`, exits `0` with or without findings, and exits `2` naming the line on a malformed set |
| `brain tags --json` | `{ "tags", "documents", "variantGroups": [{ "canonical", "members": [{ "tag", "count" }] }], "redundant": [{ "path", "tag", "repeats": "type"\|"directory" }], "aliasHits": [{ "path", "tag", "canonical" }], "outOfVocabulary": [{ "tag", "count" }] \| null }` (additive in 0.38.0). Read-only. `tags` counts distinct tags and `documents` the markdown documents carrying one, both read from frontmatter, not the index. `members` is never empty, most used first, and includes `canonical`. `redundant` is `[]` under `taxonomy.tags.redundant: "off"`. `outOfVocabulary` is `null` when no `taxonomy.tags.vocabulary` is set, most used first otherwise. `path` is repo-relative |
| `brain tags --apply [--dry-run] [--only <old>] [--groups] [--redundant] --json` | `{ "files": [{ "path", "from": string[], "to": string[] }], "skipped": [{ "path", "reason" }], "warnings": string[] }`. `files` lists every document whose tags changed (or would, under `--dry-run`), in path order. `skipped` lists documents left alone: frontmatter that does not parse, a `tags:` entry the rewrite does not edit, a tag on an alias cycle, a file edited while the command ran (`"changed during apply"`), or a rewrite that would not read back as the planned tags. A `reason` starting `failed:` is a read or write error; the run goes on, and the command exits `2` after indexing and accepting the files it did rewrite. An index that cannot be opened stops the run before any file is rewritten: `files` is empty, `warnings` says why, and the exit code is `2`. Only the `tags:` entries change, on the raw text. `updated` is not bumped. The touched files are reindexed, and a file's mtime is accepted only when the index read exactly the bytes the rewrite wrote; `warnings` names each one that was not. Explicit aliases take precedence over variant groups, and a second run reports no `files`. `reason` and `warnings` are prose (additive in 0.38.0) |
| `brain hygiene reconcile [--extra <file.json>] [--fixed <file.json>] [--dry-run] --json` | `{ "opened", "reopened", "resolved", "stillOpen", "snoozed", "changedFiles": string[], "detected": [{ "id", "category", "path", "message" }], "autoFixed", "failedChecks": string[] }`. The counts are this run's transitions: `opened` new issues, `reopened` issues back from resolved or an expired snooze, `resolved` issues no longer detected, `stillOpen` open issues still detected (or kept open while a check could not run), and `snoozed` the entries left snoozed. `changedFiles` lists the files under `context/hygiene/` written (or, with `--dry-run`, that would be); it is empty on a run that changes nothing. `detected` is every issue found this run, with its stable ID `{category}-{shortpath}-{hash4}` (hash4: SHA-1 over `{category}\|{path}\|{evidence}`). `--extra` is a JSON array of `{ "category", "path", "evidence", "message" }`, and `--fixed` a JSON array of `{ "path", "fix" }`, the auto-fixes to record in `last-run.md` (`autoFixed` counts them); a malformed one exits `1` and writes nothing. `failedChecks` names each check that could not run: a module whose hygiene check threw, or a core check that could not read its input (`fact-drift`, `tag-noise`); while any is named, no entry is resolved unless it was detected again. `--dry-run` writes no log file (the index is still refreshed). A log file that cannot be parsed safely (broken frontmatter, a section mixing entries with other text), or that changes while the command runs, exits `2` without writing it (a save in the instant between the last check and the rename can still be lost; there is no lock) (additive in 0.38.0) |
| `brain hygiene list [--state open\|snoozed\|resolved] --json` | `{ "entries": [{ "id", "state": "open"\|"snoozed"\|"resolved", "path", "issue", "firstSeen", "lastSeen", "until", "resolvedBy", "resolvedOn" }] }`, the log as the files hold it; a field the entry does not carry is `null` (additive in 0.38.0) |
| `brain travel validate --json` | `{ "validation": { "valid": boolean, "files": number, "issues": [{ "file", "level": "error", "message" }] } }` — read-only canonical format, reference and asset checks. `files` counts successfully parsed travel/trip/place documents. Exit `0` when valid, `1` on domain errors. File paths are root-relative; messages are prose |
| `brain travel migrate [--dry-run] --json` | `{ "migration": { "path", "changed": boolean, "dry_run": boolean } }` — `path` is `brain.config.ts` or `brain.config.json`; `changed` reports the proposed edit even during dry run. Reapplication reports false without a write. Refusals exit `1` with actionable stderr and no success envelope |
| `brain travel photo <files> --to <dir> --json` | `{ "photo": { "files": [{ "source", "output", "width", "height", "bytes", "captured_at": string \| null, "location": { "lat", "lon" } \| null }], "errors": [{ "source", "message" }] } }` — [photo contract](#travel-photo-copies); exit `0` for complete success, `2` for input failures, `1` for usage/output-directory refusal without an envelope |
| `brain travel route <url\|file> --to <dir> [--trim-start-m N] [--trim-end-m N] --json` | `{ "route": { "source_kind": "local_gpx" \| "gpx_url" \| "komoot_tour" \| "komoot_smarttour", "gpx": string, "distance_km": number, "ascent_m": number \| null, "altitude_min_m": number \| null, "altitude_max_m": number \| null, "shape": "loop" \| "one_way" \| "unknown", "recorded_duration_s": number \| null, "points": number, "segments": number, "trim": { "start_m": number, "end_m": number }, "warnings": string[] } }` — `gpx` is the new root-relative asset path. All metrics describe serialized retained geometry. Nonnegative cuts use metres, with a 1 mm minimum for a nonzero cut. Missing elevations/timestamps stay `null`; segment gaps are excluded. Exit `0` after creating a new file, `1` with stderr and no success envelope on refusal. Existing outputs and sources are preserved. Outdooractive URLs currently refuse pending written site permission (#568). [Metric and trimming semantics](../packages/module-travel/README.md#route-import) are part of this contract; warnings are prose |
| `brain jobs scrape --json` | `{ "report": ScrapeReport }` — a module command, listed here because a hosting container runs it on a schedule (see Consumers). `sources[].status` added in 0.37.0 |

`SearchResult` fields: `path`, `title`, `type`, `snippet`, `score`, `tags`,
`status`, `relevance`, `updated` (`YYYY-MM-DD`), `summary` (string or
`null`), `deadline` (`YYYY-MM-DD` or `null`; additive in 0.38.0),
`generatedFrom` (the document's `generated_from`, string or `null`; additive in
0.38.0), `supersededBy` (present only on a document another one
`supersedes`: that document's path; additive in 0.38.0), plus ranking
metadata. With `brain search --chunks` (additive in 0.38.0), each result also
carries `chunks`: its indexed chunks that match the query as the full-text
lane reads it (the same tokenizer, `search.language` and stopwords), best
first, as `{ "path", "chunk_index", "heading", "content", "score" }`. `heading`
is the section the chunk comes from (`(intro)` before the first, `Section
(cont.)` and `Section › Sub` for the pieces of a long one); `score` is the
chunk's BM25 relevance (heading weighted 2, content 1), higher is better. A
result with no such chunk, every result of a filter-only search or of a query
with no word in it, and every result on an index from before schema 12 have an
empty list. If chunk matching fails, the results stand with empty lists and
`warnings` says so, as for a failed search lane. Without `--chunks` there is
no `chunks` key. Treat unknown fields as
additive; never rely on field order.

`ListedDocument` fields: `path`, `title`, `type`, `relevance`, `status` and
`updated` (strings); `summary` (string or `null`); `deadline` (`YYYY-MM-DD`,
or `null` when the frontmatter sets none; additive in 0.38.0); `tags` (the document's tags
joined with `", "`, or `null` when it has none — a string, not an array);
`score` (always `0`, since a filter has nothing to rank) and `snippet` (always
`""`).

#### `AuditIssue`

`AuditIssue` fields: `path`, a repo-relative document path or a
parenthesised sentinel for an issue that belongs to no one file — `"(corpus)"`
for the corpus-wide `tag-noise` check, `"(module)"` for a failing module check
— so a consumer must not open a `path` that starts with `(`; `severity`, one of `"error"`,
`"warning"`, `"info"`; `category`, a string naming the check; `message`; and
`suggestion`, a string present only when the check has one. Three optional
fields are additive in 0.40.0, each present only on the categories named:
`count` (a number) and `examples` (strings) on `todo` and `verify`, and
`target` (a string, the wiki-link target as written) on `broken-link`. Core
categories are `staleness`, `propagation`, `index-lag`, `stale-draft`,
`tag-noise`, `todo`, `verify`, `type-mismatch`, `orphan`, added in 0.38.0
additively, `budget`, `review-overdue`, `past-date`, `fact-drift`,
`repeated-text`, `index-stale` and `duplicate-title`, and added in 0.40.0
additively, `broken-link`.

`todo` and `verify` are one issue per document and category, both `info`
(**breaking in 0.40.0**: they were one issue per marker, and `verify` was a
`warning`; the maintainer ruling is on
[#394](https://github.com/schlessera/brain-kit/issues/394), the reasoning in
[decisions/audit-markers.md](decisions/audit-markers.md)). A marker is a
`[TODO: …]` or `[VERIFY: …]` span in the body, as before. `count` is the
number of markers of that kind in the document, and `examples` the first
three of them, in source order, each as written. A document with both kinds
has two issues. `message` is `<n> TODO marker(s): <examples>` (with `, the
first 3` after the count when there are more than three), and the same for
`VERIFY`. A document whose frontmatter declares `verification: unverified` has
exactly one `verify` issue, markers or not: its `message` starts `Declared
verification: unverified`, followed by `; ` and the marker summary when it also
has inline markers, and its `count` is the number of inline markers, `0` when
it has none. A document that does not declare it is judged by its markers
alone; the absence of the declaration never means verified. Migration: a
consumer that counted `todo` or `verify` issues to count markers should sum
`count` instead, and one that treated a `verify` issue as must-fix should read
it as informational.

`broken-link` is a wiki-link in a document's body that resolves to nothing,
one `warning` per source document and target, with the target in `target`
and a `message` worded exactly as `brain validate` words the same link
(`Unresolved wiki-link: [[x]]`, or `Ambiguous wiki-link: …` when the name
matches several documents and none is a same-directory sibling). Resolution
is the indexer's own, the one `brain validate` uses: path suffixes,
basenames, same-directory disambiguation, directory anchors, `[[target#heading]]`
and `[[target|label]]`, then `aliases`. So a link `brain validate` accepts is
never a `broken-link`, and on a current index the issues are the rows
`brain stats` counts as `brokenLinks`.

`duplicate-title` is a non-archived
markdown document whose exact title another non-archived one shares, one
`info` issue on each, with the others' paths in `message`.
`fact-drift` is a document that restates a keyed fact (`taxonomy.facts`) with a value other than
the one in its source's `facts:` frontmatter, one issue per document per fact,
`warning`, with `message: "<key>: found <x>, canonical <y>"`; the source is
never reported, nor a document that lists the key in `facts_ignore`. `repeated-text` is a
top-level paragraph of at least 200 characters (whitespace collapsed; code, a
list, a quote or a heading is not a paragraph) that at least 5 documents
carry, one `info` issue per paragraph with `path: "(corpus)"`, the document
count, the first three paths and the paragraph's first 80 characters in
`message`. `index-stale` is an `_index.md` with a `registry:` block whose
generated table no longer matches its children (or whose block is invalid),
`warning`; such an index is never reported as `index-lag`. `budget` is a canonical document
over its `taxonomy.canonicalPolicy.<key>.maxTokens`. `review-overdue` is a
passed `next_review` (strictly before today; a review due today is not
overdue), or a lapsed `canonicalPolicy.<key>.reviewDays` cadence, never on an
archived document, and one issue per document.
`past-date` is a line in a canonical document with a policy that names an
earlier `YYYY-MM-DD` day, with the line number in `message`. All three are
`warning`. `taxonomy.canonicalPolicy` is an optional `brain.config` key,
defaulting to `{ currentFocus: { maxTokens: 1000 } }`. Modules add their own, and a failing
module check reports as `module-hygiene` with `path: "(module)"`, so treat the
set as open.

#### `brain eval --json`

Added in 0.38.0. The query-set format and how to read the numbers are in
[evaluating-search.md](evaluating-search.md).

The values below illustrate the envelope. Actual fixture ranks are recorded
in `packages/core/fixtures/corpus/evals/expected-ranks.json`.

```jsonc
{
  "schema_version": 1,           // bumped when a field below changes meaning
  "meta": {
    "version": "0.38.0",         // the installed @schlessera/brain
    "source": null,              // the core package's directory when it runs
                                 // from a checkout; null when installed
    "set": "evals/retrieval.jsonl", // brain-relative when inside the root
    "set_sha256": "1dcc…",       // of the set file's bytes
    "queries": 27,
    "documents": 25,             // rows in the index, assets included
    "embedding_model": null,     // the provider id when a vector lane ran
    "modes": ["fts"],            // --mode all → ["fts", "vector", "hybrid"]
    "rerank": "heuristic",
    "reranker": null,            // the judgment reranker's id with its pinned
                                 // model ("jev:jev-1.13.0") when rerank is jev
                                 // (additive in 0.39.0)
    "k": [1, 3, 10],
    "pool": 20,                  // results fetched per query: max(20, k)
    "now": "2026-07-12T09:00:00.000Z" // the instant recency and selectors were
                                 // measured from: the set header's now, else
                                 // --now, else the wall clock
  },
  "rows": [
    // Per mode: one overall row over the answerable queries (class null),
    // then one row per class in the set's first-seen order.
    { "mode": "fts", "class": null, "n": 26,
      "hit_at": { "1": 0.73, "3": 0.88, "10": 0.96 },  // keyed by each k
      "mrr_at_10": 0.81,
      "oracle": 0.96,            // share with an expected path in the pool
      "top1_score_median": 3.84,
      "current_first": 0.5 },    // share of the row's queries with `stale` paths
                                 // that rank the current one first; null when
                                 // none has any (additive in 0.38.0)
    // A no-answer class is never scored: hit_at, mrr_at_10, oracle and
    // current_first are null.
    { "mode": "fts", "class": "no-answer", "n": 1,
      "hit_at": null, "mrr_at_10": null, "oracle": null, "top1_score_median": 1.37,
      "current_first": null }
  ],
  "per_query": [
    { "mode": "fts", "id": "calypso-guide", "class": "alias", "q": "the Calypso guide",
      "expected": ["studies/star-bearings.md"],
      "rank": 2,                 // of the first expected path in the pool; null when absent
      "hit_at": { "1": false, "3": true, "10": true },  // null for no-answer
      "rr": 0.5,                 // 1/rank, 0 below rank 10; null for no-answer
      "top1_score": 4.02,        // null when the search returned nothing
      "top": ["studies/navigation/overview.md", "studies/star-bearings.md"],  // up to max(k) paths
      "current_first": null }    // with `stale`: the first expected path ranks above
                                 // every stale one, or no stale path is in the top
                                 // max(k); null without `stale` (additive in 0.38.0)
  ],
  "warnings": []                 // findings that do not refuse the run
}
```

Every `row` carries the same eight keys and every `per_query` entry the same
eleven; a consumer must treat an unknown additional key as additive. `hit_at`
keys are the `--k` values as strings. A query set of only `no-answer` queries
has no overall row.

The command refuses, exiting `2` with the reason on stderr and nothing on
stdout or in `--out`, when the set is missing or empty, an expected or `stale`
path is outside the brain (symlinks followed), not a file, or not in the index,
a selector selects no document, the index is older than the markdown on disk or
an indexed file cannot be read to tell, or a requested lane degraded (any
`warnings` from the search, such as `--mode vector` with no embedding
provider). Usage errors exit `2` as well under `brain eval` (every other
command keeps `1`), so `1` only ever means a failed `--baseline` gate: a
malformed set line (named by number), a value option given no value, a `--k`
cutoff above 1000, an `--now` that is not an ISO date, and an `--out` outside
the brain, which is refused before any search runs. `--set` and `--out` resolve against the brain root.

The query-set format (additive in 0.38.0): the optional first-line header
takes `now` (an ISO date or timestamp), and no other key. A query gives either
`expected` or `expect.select`, a selector `{ type?, field, after? | before?,
order, take }` over frontmatter dates, whose resolved paths are printed as that
query's `expected` in `per_query`; it considers only documents the indexer
indexes (with `title` and `type`) and real calendar dates, and a `now` or bound
naming a day that does not exist is refused. An optional `stale` list of paths feeds
`current_first`. When the header sets `now` and `--now` differs, the header
wins and `warnings` says the flag was ignored.

`warnings` names each indexed document that contains the set's queries, as
`contamination: <path> contains the text of <n> of the set's queries (<ids>)`,
when it contains one query of four or more words or three queries of any
length, not counting queries that list that document among their expected
answers; a query matches as whole words, ignoring case and collapsing
whitespace, in the same bytes the freshness check read. With `--strict`, such
a document refuses the run (exit `2`) instead (additive in 0.38.0).

With `--context [--budgets 1000,4000,8000]` the envelope gains a `context`
block (additive in 0.38.0); every other key is unchanged. Each query runs
through the assembler `brain context` uses, at each budget, with the run's
`now`:

```jsonc
"context": {
  "budgets": [1000, 4000, 8000],
  "rows": [                       // one per budget
    { "budget": 1000,
      "n": 26,                    // answerable queries, the denominator below
      "answer_present": 0.81,     // null when n is 0
      "budget_used": { "median": 0.97, "p10": 0.9, "p90": 0.99 } }  // nearest rank over all
                                  // queries; an even sample's median is the lower middle value
  ],
  "per_query": [                  // one per query and budget
    { "budget": 1000, "id": "calypso-guide", "class": "alias",
      "answer_present": true,     // null for a no-answer query
      "budget_used": 0.97,        // the assembler's estimateTokens(output) / budget
      "sections": { "identity": 1, "focus": 1, "results": 5, "related": 3 } }  // related: documents listed
  ]
}
```

`answer_present` is true when an expected path is one the assembler reports it
included as a search hit, or as the source of the identity or current-focus
section. The assembler reports its own sections, so text inside a document (a
quoted heading, a fenced example) never counts. A document in the `### Related`
list does not count either: only its summary line is there. A query's optional `answer` string makes it look for that text
instead, ignoring case and whitespace; a `no-answer` query may not carry one.
`--budgets` without `--context` is a usage error. Search warnings from the
assembler (a keyless brain has no vector lane) are reported once each in
`warnings`, prefixed `context: `, and never refuse the run.

`--baseline <file>` compares the run, query by query, against a stored one (a
`--json` envelope written with `--out`), and adds a `baseline` block (additive
in 0.38.0):

```jsonc
"baseline": {
  "file": "evals/baseline.json",   // null under --redact
  "version": "0.38.0",             // the version the baseline was recorded with
  "comparable": true,
  "not_comparable": [],            // why not, when comparable is false
  "only_in_baseline": [],          // query IDs one run lacks (--allow-set-change)
  "only_in_run": [],
  "modes": [
    { "mode": "fts",
      "hit_at": { "1": { "lost": ["knee"], "gained": [], "unchanged": 25, "sign_test_p": 1 } },  // per k
      "per_class": [ { "class": "exact", "hit_at": { "1": { "lost": ["knee"], "gained": [], "unchanged": 4 } } } ] }
  ],
  "gate": { "max_net_loss": 2, "must_pass": [], "failed": false, "reasons": [] }
}
```

`lost` and `gained` list query IDs that hit at k in one run and not the other;
a no-answer query is never compared. `sign_test_p` is the exact two-sided sign
test over the discordant queries, reported for information only. The gate
fails (exit `1`) when lost minus gained on hit@1 reaches `--max-net-loss`
(default 2) in any mode, or when a query in a `--must-pass` class (comma
separated) is lost. The runs are not comparable (exit `3`) when their schema,
modes, embedding model or k differ, or, without `--allow-set-change`, their
set hash or query IDs do; with it, only the queries both runs have are
compared. A missing or unreadable baseline is refused (exit `2`) before any
search runs, `--k` must include 1, and the gate flags need `--baseline`.

`--redact` removes `q`, `expected` and `top` from each `per_query` entry,
nulls `meta.set`, `meta.source` and `baseline.file`, and replaces `warnings`
(which name documents) with a count, in the output (`--json` and the human
report alike) and in `--out`. With `--lint` it nulls `meta.set` and replaces
`warnings` (which quote titles and query words) with a count. On stderr, a refusal keeps its reason, which
carries counts and query IDs, and replaces its details (which name documents)
with a count, and a malformed set or baseline is named by file and line
without the parser's words. An error that repeats a path given on the command
line (`--set`, `--baseline`, `--out`) still names it. A redacted run still
works as a baseline. A baseline is refused (exit `2`) unless every query
appears once in every mode it names, keeps its class across modes, and has a
hit or miss at every k, with `hit_at` null exactly for the `no-answer` class.

#### `brain index` counters

Each counter describes this run, not the index as a whole, and they do not
partition one another:

- `total` — markdown files the scan found. It includes files the run then
  skipped as unreadable or missing `title`/`type` (each skip is a `SKIP:`
  warning on stderr), so `added + updated + unchanged` can be less than it.
- `added` / `updated` — markdown documents written this run that were not /
  were already in the index. Under `--force` every parsed file is one or the
  other.
- `unchanged` — markdown documents left alone because their content hash
  matched. Always `0` under `--force`.
- `deleted` — index rows the deletion sweep removed because their file is
  gone, markdown and assets alike. It is not part of `total`: deleting the
  last document reads `total: 0, deleted: 1`. Under `--force` every markdown
  row is wiped before the sweep runs, so a markdown file removed since the
  last run is not counted (`deleted: 0`); only removed assets are.
- `chunks` — chunks written this run: those of the added and updated
  documents, plus one per asset indexed.
- `embeddings` — vectors written this run, text chunks and assets together.
- `assets` — images and PDFs (re)indexed this run. Assets are only indexed
  on an `--embeddings` run, so it is `0` otherwise. Since 0.38.0 an asset git
  ignores is never indexed, so it is not counted here, and one that becomes
  ignored is removed and counted in `deleted`, like a deleted file. Ignored
  markdown is still indexed. `brain stats` `size.corpus` leaves ignored assets
  out by the same rule.
- `graphMs` / `graphNodes` — the graph rebuild's wall time and node count.
  Both are `0` when this run did not rebuild the graph: either nothing it
  depends on changed and the previous tables were reused, or the rebuild
  failed, which also prints `Graph precompute failed: …` on stderr and keeps
  the previous tables. The JSON alone does not tell those two apart.

`brain stats --json` grew two nested blocks in 0.37.0. Nothing was removed or
renamed, so a consumer reading only the flat counts other than `embeddings`
needs no change.

One flat count changed in 0.37.0, and it is the one breaking change in this
shape: `embeddings`, which was a `number` and is now `number | null`.

It changed value first. Before 0.37.0 the command counted `vec_chunks` on a
read-only connection that had never loaded sqlite-vec, so the query raised
`no such module: vec0` and a bare `catch` reported `embeddings: 0` — on a fully
embedded brain as much as on a keyless one. It now loads the extension before
counting, so on any host where sqlite-vec loads, `embeddings` is the real number
of stored vectors. A consumer that treated `0` as "this brain does not embed"
was reading a measurement failure, and will now see the true count; one that
charted the figure over time will see a step at this version, not a
re-embedding run.

It also changed type. When the brain has a `vec_chunks` table and sqlite-vec
will not load on this host, the count cannot be taken, and `embeddings` is
`null` rather than a `0` that reads exactly like a brain holding no vectors. A
brain with no `vec_chunks` at all still reports `0`: there is nothing to count,
and that is known. A consumer doing arithmetic on the field must handle `null`
(the maintainer ruling is on
[#169](https://github.com/schlessera/brain-kit/issues/169)). When the cause is
the extension, `brain stats` also prints `sqlite-vec not available: <cause>` on
stderr, never on stdout.

```jsonc
{
  // health: what needs attention. A figure that cannot be known is null,
  // never 0 — an unmeasurable ratio must not read as a failing one.
  "health": {
    "brokenLinkRate": 0.054,       // brokenLinks / links; null when there are no links
    "embeddingCoverage": null,     // eligible chunks with vectors / eligible chunks; null when this brain neither
                                   // embeds nor holds vectors, has no eligible chunks, or vectors cannot be read
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
    "db": {
      "bytes": 453208,
      "tables": { "documents": 25, "links": 37 },
      // Live vectors against the slots sqlite-vec has allocated for them.
      // Deleted vectors leave slots it never reuses; `brain index --compact`
      // (and `brain maintain`, when fewer than half are live) reclaims them.
      // Each is nullable on its own. `live` is null when the vector table
      // exists and sqlite-vec will not load, so it cannot be counted.
      // `allocated` is null then too, and also when the extension loads but
      // its chunk table is not in the shape this version knows — so `live`
      // can be a number while `allocated` is null. Both are 0 when there is
      // no vector table. Additive in 0.38.0.
      "vectorSlots": { "live": 3030, "allocated": 7168 }
    },
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

### Embedding eligibility and coverage semantics

`taxonomy.types.<type>.embed` is an optional boolean. With no effective value,
it defaults to `true`. `false` keeps the document/chunk keyword indexes,
links, audit and ordinary counts, but excludes that type from chunk-context
and vector generation. It also removes existing vectors on the next index
pass, even without `--embeddings` or a content change. Enabling the type again
makes missing vectors eligible for the next embeddings pass. The policy
applies to markdown and image/PDF vectors, including cache and carried-vector
reuse; asset description enrichment remains independent.

`health.embeddingCoverage` is **eligible chunks with vectors / eligible
chunks**, using the current resolved taxonomy for both sides. Stored vectors
for opted-out types cannot inflate the numerator. `chunks` and `embeddings`
remain total inventory counts; they must not be divided to reconstruct this
health ratio. Zero eligible chunks returns `null` and carries no coverage-floor
verdict. An unavailable/unreadable vector store is still unknown (`null`), as
is a brain that neither embeds nor holds vectors. The field remains
`number | null`; no competing coverage ratio is added.

**Migration note:** this is an approved pre-1.0 semantic break
([maintainer ruling](https://github.com/schlessera/brain-kit/issues/429#issuecomment-5906802435)).
Previously coverage used all stored vectors / all chunks. Consumers must use
the supplied health field and handle its null cases. A coverage increase after
opting out a type reflects the new denominator, rather than new embeddings.
Older committed stats-history snapshots retain their recorded semantics; an
index rebuild does not rewrite them. See the
[eligibility decision](decisions/embedding-eligibility.md).

### Recorded corpus trend verdicts (additive in 0.40.0)

`brain stats --json` and `--history --json` include `trends`, and the `stats`
entry of `brain maintain --json` carries the same object. Briefing retains
plain text and includes only warning explanations. Ordinary library
`collectStats` remains a current measurement; the CLI enriches it with history.

`trends` is `{ evaluatedAt: <ISO timestamp>, verdicts: [...] }`, with exactly
one verdict for each `metric`: `embeddingCoverage`, `brokenLinks`, `orphans`.
Each verdict has:

- `state`: `warning`, `measured-no-warning`, `insufficient`, `stale`, or
  `incomparable`. An unusable comparison never becomes a healthy verdict.
- `baseline` and `recent`: `{ start, end, dates, samples, median, countMedian,
  versions }`. Dates are inclusive UTC calendar dates; `dates` lists the
  actual valid daily observations and `samples` their count. Missing or
  invalid values are excluded, not zero. `versions` lists known strings used
  (a missing version still causes incomparability). `countMedian` is only
  populated for the paired broken-link counts, otherwise null. Coverage and
  broken-link `median` values are ratios, not percentages.
- `latestAt`: the latest used recording timestamp, or null. Future dates and
  recordings, and timestamps inconsistent with their stated UTC day, are
  excluded. Duplicate days use the existing history reader's semantics.
- `change`: recent minus baseline median; `countChange`: the paired
  broken-link count delta; `relativeChange`: the orphan delta / baseline,
  null at a zero baseline. Inapplicable fields and changes for unusable
  comparisons are null. Partial window medians remain available as evidence.
- `rule`: `{ minimumSamples: 3, maximumAgeHours: 48, minimumChange,
  minimumCountChange, minimumRelativeChange, currentThreshold }`, naming the
  effective fixed rule and configured floor/ceiling. Inapplicable fields are
  null. `message` is the core-owned explanation, reused verbatim by consumers.

Recent is today minus 6 days through today; baseline is today minus 13
through minus 7. Each needs at least 3 valid days. Medians use the ordinary
mean of the middle two values for even samples. Freshness is inclusive at
48 hours. State precedence is insufficient samples, incompatible provenance,
stale observations, then measured classification. A `--since` filter does
not change the evaluation windows or sample membership.

Coverage warns for a fall >= 0.05 and recent strictly below `coverageFloor`.
Broken links warn for rate rise >= 0.01, count rise >= 3 and recent rate
strictly above `brokenLinkCeiling`; rate and count use the same valid paired
rows, with a positive link denominator and a recorded rate matching count /
links. Orphans warn for absolute rise >= 5 and relative rise >= 0.20; from
zero only the absolute gate applies. Decisions use unrounded values; numeric
evidence and the explanation preserve enough precision to separate boundaries.
These are initial uncalibrated policy thresholds, not inferred causes.

Version compatibility is conservative and explicit. Reviewed 0.37.0/0.38.0
coverage uses total chunks; 0.40.0 uses eligible chunks. They cannot be mixed.
Development histories labelled 0.39.0 can contain either definition, so their
coverage is incomparable. Broken-link/orphan definitions are compatible
across those four exact versions. Other, missing or prerelease versions are
unsupported until reviewed. See the [trend decision](decisions/stats-trends.md)
for provenance evidence and rejected alternatives. Old snapshots and
recording/retention rules are unchanged.

A current-value finding takes precedence for its metric; the PWA adds trend
evidence to that existing notice instead of a second warning. Complete
comparisons remain in receipts. An incomparable metric chart is replaced by
its explanation rather than connecting incompatible definitions.
Missing/stale/incomparable history produces
no alert or healthy claim there or in briefing. Malformed JSONL still follows
the reader's existing explicit-error behavior; it is never silently repaired.

### Stats history (additive in 0.40.0)

`brain stats --record`, and the `stats` step of `brain maintain`, keep the
day's figures as one line of `.stats-history.jsonl` at the brain root. The
file is committed with the brain: `brain.db` is disposable, so the history
cannot live there, and `brain index --force` never touches it. Nothing indexes,
validates or audits it, and `size.corpus` does not count it.

- One snapshot per UTC day. A second recording the same day replaces that
  day's line. Every recording rewrites the file sorted by date, one line per
  day, and the file is `merge=union` in `.gitattributes`, so a merge of two
  clones' histories never conflicts; two lines for one day resolve to the
  later `at`.
- Retention: every day for the last 90 days, then the latest snapshot of each
  ISO week.
- A line that is not a JSON object with a `YYYY-MM-DD` `date` (a conflict
  marker left by a merge, say) fails both the recording and `--history`, and
  the file is left untouched to be fixed by hand.
- Recording does not change current figures in `brain stats --json`; trend
  evidence uses history available before the write. A later command can see
  the newly recorded day. The recording note goes to stderr.

A line holds `date`, `at` (ISO timestamp), `version` (the brain-kit version
that recorded it), the flat counts and breakdowns of `brain stats --json`,
`health` without `thresholds`, and `size` flattened to totals: `corpusBytes`,
`corpusFiles`, `dbBytes`, `dbRows` (the sum of `size.db.tables`),
`vectorsLive`, `vectorsAllocated`, `freeBytes`. The line format is not the
contract; `--history --json` is:

```jsonc
{
  "dates": ["2026-09-28", "2026-09-29"],       // index i of every array is one snapshot
  "recordedAt": ["2026-09-28T03:00:00.000Z", "2026-09-29T03:00:00.000Z"],
  "versions": ["0.40.0", "0.40.0"],
  "documents": [24, 25], "tags": [43, 43], "links": [37, 37],
  "brokenLinks": [2, 2], "chunks": [24, 25], "embeddings": [0, 0],
  // Every key any snapshot had. A key missing from a snapshot that has the
  // breakdown is 0 there; a snapshot without the breakdown reads null.
  "byType": { "note": [2, 3], "project": [6, 6] },
  "byStatus": { "active": [22, 23] },
  "byRelevance": { "primary": [15, 16] },
  "health": {
    "brokenLinkRate": [0.054, 0.054], "embeddingCoverage": [null, null],
    "stale": [11, 11], "orphans": [1, 1], "untagged": [1, 1]
  },
  "size": {
    "corpusBytes": [22101, 22647], "corpusFiles": [28, 29], "dbBytes": [344064, 344064],
    "dbRows": [340, 352], "vectorsLive": [0, 0], "vectorsAllocated": [0, 0],
    "freeBytes": [30714716160, 30714716160]
  }
}
```

A field a snapshot does not carry, because the version that recorded it did
not have it, reads `null` in that snapshot's slot, never `0`; so does a figure
`brain stats` reported as `null`. No history is empty arrays, not an error.

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
        "source": "weworkremotely",
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
        // Detail-page enrichment (#36), added in 0.37.0 alongside `status`.
        // Counts of ROWS, never a claim about whether the board was read, so
        // none of them moves `status`. A non-zero `enrichment_failed` or
        // `enrichment_truncated` also has a line in `errors`;
        // `jobs_enriched` does not, since it is not a finding.
        //   jobs_enriched         rows with no description that got one from
        //                         their own detail page this run
        //   enrichment_failed     detail pages fetched that failed or carried
        //                         no description; those rows are still stored
        //   enrichment_truncated  rows left undescribed because the run's cap
        //                         on detail pages was reached
        "jobs_enriched": 0,
        "enrichment_failed": 0,
        "enrichment_truncated": 0,
        "errors": ["We Work Remotely https://weworkremotely.com/remote-jobs.rss: parsed 0 jobs from a page that does not say it is empty — selector drift, a challenge page, or markup that is not this board's"],
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

The three enrichment counts are additive in the same way `status` was: nothing
earlier was renamed or retyped. A row the listing already described, or one an
earlier run stored with a description, is not fetched and appears in none of
them. A `--dry-run` fetches no detail pages, so they are all 0 there. A row
whose adapter never returned carries 0 in all three.

Every selected board gets a row, including one whose adapter never returned: it
appears with `status: "not_run"` rather than dropping out of `sources`, because
a missing row reads as a board that was never asked for.

The jobs database records the same judgement in `scrape_runs.status`: `ok` and
`empty` are `completed`, `unparseable` and `not_run` are `failed`. A board that
could not be read therefore stops advancing its cursor even when it threw
nothing.

## Browser scraping navigation policy

`@schlessera/brain-scrape`'s `BrowserSession.load` checks robots.txt and applies
per-host pacing before dispatching each HTTP(S) main-frame navigation: the
initial URL, every redirect target and subsequent navigation during the load.
`BrowserSessionOptions.userAgent` is both the sent identity and the robots
matching token, defaulting to the package's identifying User-Agent.
Scripts, images, child frames and page-generated API requests are outside
these checks and pacing. The existing rule against intentional circumvention
still applies; this is not a browser network sandbox.

`PageRequest.allowDisallowed` is an explicit per-call option, default false,
for an owned host or written site permission. It authorizes only the
requested URL's original origin, never a cross-origin redirect, and never
persists into another call. Ordinary pacing and usable Crawl-delay still
apply. HTTP's `respectRobots`/`SCRAPE_RESPECT_ROBOTS` opt-out does not disable
browser enforcement. No session-wide browser override is provided.

Sessions own a robots cache and limiter by default; optional `robots` and
`rateLimiter` inputs share the run's objects. `ScrapeClient` exposes readonly
`robots`, `rateLimiter` and `userAgent` for this purpose. `runAdapters` and
the jobs runner share these objects when constructing the browser. A supplied
preconstructed BrowserSession retains the policy state chosen by its caller.
`RateLimiter.acquire(host, delayMs?, signal?)` and an injected clock's
`sleep(ms, signal?)` accept cancellation without granting a request or
letting another waiter overtake a preceding acquisition.

`pageBudgetMs` bounds the whole page operation after concurrency admission,
including acquisition, policy waits, navigation and extraction. A refusal
or timeout rejects the load, closes its page and releases capacity. Jobs
report a board whose pages are all refused as `not_run` with errors and
persist `failed`, using the existing JSON/status shapes above.

This pre-1.0 tightening replaces unenforced browser navigation and the
implicit Chrome User-Agent. Consumers needing a disallowed navigation must
provide the authorized per-call option; HTTP behavior is preserved. The
[scraping-politeness record](decisions/scraping-politeness.md#browser-enforcement-ruling)
records the approved request boundary and override policy.

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
caps: `brain_search` `limit` at 50, `brain_list` `limit` at 100, and
`brain_graph` `depth` at 5.

The input schemas, as `tools/list` reports them, are pinned in
[`packages/core/tests/mcp-input-schemas.json`](../packages/core/tests/mcp-input-schemas.json)
with descriptions left out; `mcp-contract.test.ts` fails when a tool's schema
drifts from it. `?` marks an optional input; a default is given where the tool
applies one:

| Tool | Inputs |
|------|--------|
| `brain_search` | `query`, `type?`, `tag?`, `relevance?`, `mode?` (`fts`\|`vector`\|`hybrid`, default `hybrid`), `rerank?` (`none`\|`heuristic`\|`jev`; omitted → the configured provider when `reranker.enabled` is true and available, otherwise local heuristic. An explicit `jev` cannot enable judgment while off; it warns and falls back. 0.39.0 added `jev` and dropped the schema default of `heuristic`), `include_archived?` (default `false`), `assets_only?` (default `false`), `limit?` (default `10`), `updated_since?`, `updated_before?`, `deadline_from?`, `deadline_to?` (`YYYY-MM-DD`, inclusive), `sort?` (`score`\|`updated`\|`deadline`, default `score`), `upcoming?` (default `false`) — the six date inputs added in 0.38.0, additively; an invalid date is a tool error |
| `brain_context` | `query`, `max_tokens?` (default `4000`), `include_identity?` (default `true`), `include_current_focus?` (default `true`) |
| `brain_read` | `path`, `section?` (a heading's visible text, compared under Unicode canonical caseless matching (full case folding); the body is parsed as GFM, and only top-level ATX and setext headings count, never one inside code, HTML, a table, a list or a blockquote; the section runs to the next heading of the same or higher level; of two equal headings the first is returned; an unknown one is an error naming the document's headings), `max_tokens?` (positive safe integer; the threshold for the outline, not an output cap; no default, so the whole file comes back unless it is given). Both additive in 0.38.0 |
| `brain_list` | `type?`, `tag?`, `status?`, `relevance?`, `limit?` (default `20`) |
| `brain_graph` | `path`, `depth?` (default `1`), `direction?` (`outgoing`\|`incoming`\|`both`, default `both`) |
| `brain_add` | `content`, `type?`, `title?`, `tags?` (comma-separated) |
| `brain_update` | `path`, `summary?`, `status?` (`active`\|`archived`\|`draft`), `relevance?` (`primary`\|`secondary`\|`historical`), `tags?` (comma-separated, replaces), `deadline?`, `next_review?` (ISO 8601; `""` removes), `append_content?`. Setting `status: "archived"` applies `brain_archive`'s relevance rule to the effective relevance (the `relevance` passed in the same call, else the document's): a `primary` or missing one becomes `historical` and `"relevance"` is listed in `changes`; an explicit `secondary` or `historical` stays (additive in 0.38.0) |
| `brain_archive` | `path`, `dry_run?` (default `false`) |

Read tools append an index-staleness warning when markdown files are newer
than their `indexed_at`.

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
address the link policy refuses.
The eight bridge tools are declared once as **tool contracts** in
`@schlessera/brain-ui-sdk/tool-contracts` (also re-exported from `/server` and
`/client`); their names and Claude-side input schemas are stable.

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
| `map` | `title?` (≤60), `places[1..30]{label (1-80), lat? (-90..90), lon? (-180..180), meta? (≤40), source? (≤80), accuracyM? (>0, ≤100000)}`; `lat` and `lon` come together or not at all (additive in 0.39.0) | `PlaceMap`, planned by `planPlaces` |
| `link` (0.39.0) | `url` (1-2048), `title?` (1-100), `description?` (≤240) | `LinkPreviewCard` (link mode) |
| `suggestions` (0.39.0) | `label?` (1-24), `items[1..2]{label (4-80, trimmed, one line), icon?}` | the app's closing row, from `SuggestionChips`' data minus `tone` |

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
is dropped rather than rejected. `show_block` is the one payload parsed with
its **input** schema rather than a loose one: the payload is the model's own
argument echoed back, so a field the client's schema does not know is dropped
from the rendered block rather than kept, and the block still renders.

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

## ui-server HTTP routes

The [supported HTTP specification and complete inventory](http-api.md) are part
of this contract. They deliberately select routes for independent clients and
integrations, preserve existing promises and SDK dependencies, and explicitly
exclude internal UI transport from independent raw-HTTP compatibility guarantees.
Support is separate from public accessibility: authenticated APIs can be
supported, while a UI-only probe can be internal. Authentication, inputs,
outputs, errors and specified behavior on supported rows follow the versioning
rules at the top of this document. The [selection decision](decisions/http-api-boundary.md)
records #343 Q6; no route redesign or immediate 1.0 freeze is implied.

The detailed stats promises below remain binding. The specification calls out
observed implementation/client gaps with linked tasks; an implementation gap
does not revoke a documented guarantee.

### Internal Queue poke (additive)

The supported `POST /api/internal/inbox/poke` operation uses an independent
boot-minted bearer token and the actual loopback socket, before general API
authentication in every auth mode. Forwarding headers never authorize it.
Its runtime-file configuration, rotation, exact success/error shapes and
bounded stopped-interval recovery are specified in [inbox-runtime.md](inbox-runtime.md).
The generated host consumes this operation; its `/internal` path does not
exclude it from HTTP compatibility. The shipped app wiring performs recovery
and heartbeat work with no production dispatcher. An unavailable or closed
runtime never grants access to ordinary APIs or enables autonomous execution.

### Corpus stats history (`GET /api/brain/stats/history`, additive in 0.40.0)

Passes `brain stats --history --json` through untouched, behind the auth
guard with the other `/api/brain/*` routes; the shape is under "Stats
history" above. A brain CLI older than 0.40.0 rejects the flag, and the route
answers `500` with `{ error }`. A consumer treats that, and a 404 from an
older server, as no history.

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

## Content-index query API

The concrete synchronous `@schlessera/brain/queries` entry supports
`readGraphMeta`, `readGraphClusters`, `readGraphNeighborhood`,
`readGraphDiscovery`, `readGraphMaintenance`, `readLinkWalk`,
`readVoiceVocabulary`, `listIndexDocuments` and `findIndexDocuments`.
Its [complete API specification](content-index-queries.md) is part of this
contract: signatures/reachable exports, validation/defaults/caps/order,
detached result and safe error envelopes, feature compatibility, read-only
per-operation snapshot lifetime and replacement behavior. Ordinary conditional
exports ship TypeScript source, JavaScript and declarations from the same build.
Supported result/behavior additions ship in a minor; changes follow this file's
versioning policy. The [SQL-boundary ruling](decisions/index-query-api.md) keeps
the direct-SQL guarantees below binding during the separate consumer migrations.
No SQL/handle/provider interface is exposed by the query entry.

The pi backend's `brain_list` and `brain_graph` use these results in process,
without loading executable config or providers for those two reads. Their
existing pi text/details envelopes, listing default `20`/cap `100`, graph
default `1`/cap `4`, direction, ordering and truncation remain unchanged.
An absent indexed graph path still returns empty `edges` and `nodes`.
Index compatibility, WAL snapshot consistency and per-call replacement checks
belong to core. Missing indexes retain the `brain index` instruction; incompatible
or corrupt indexes request `brain index --force`; busy indexes request a retry;
unavailable indexes and invalid inputs produce generic errors. Pi throws these
sanitized errors through its existing tool executor error path, never SQLite
diagnostics. Query input validation follows the linked API specification.

`@schlessera/brain/internal` is an explicitly unsupported first-party entry,
with no compatibility guarantee; use the same lockstep package version. Its
`archiveDocument`, `assembleContext`, `hybridSearch`, `indexAll`, `ingest`,
`loadVecSupport` and `openDatabase` exports serve pi's remaining search/context
and write implementation. They may accept native handles and are not supported
query APIs. This scoped classification adds the internal entry and migrates
pi's imports; #534 owns removal of existing accidental ordinary exports.
Existing direct-SQL guarantees remain binding until the explicit retirement.

## brain.db (direct SQL reads)

Prefer the CLI/MCP. If reading directly:

- Check `index_metadata` first: `schema_version` (currently **15**),
  `embedding_model`, `embedding_dimensions`, `vec_schema`, and `fts_tokenizer`
  (additive in 0.38.0): the FTS5 tokenizer `documents_fts` was built with,
  `porter unicode61` for `search.language: english` (the default) or
  `unicode61 remove_diacritics 2` for `none`. It can be absent on an index no
  run has touched since it was added; the table's own definition in
  `sqlite_master` is then the answer. A rebuild for another language writes
  the new table, all its rows and `fts_tokenizer` in one transaction. Schema 9 adds only
  an index on `links(target_id)`; no table or column changed from 8, so a
  reader that accepts 8 reads 9 unchanged. Schema 10 (0.38.0) adds only the
  column `documents.chunker_version`: the chunker version a markdown
  document's chunks came from, `NULL` for assets and for rows written before
  it existed. A reader that accepts 9 reads 10 unchanged.
  Schema 11 (0.38.0) adds only the nullable `documents.generated_from`
  column, so a reader that accepts 10 reads 11 unchanged. The migration also
  clears the markdown rows' `content_hash`, so the next index run re-reads
  every file and fills it. Schema 12 (0.38.0) adds only the table
  `supersedes` (source_id, target, target_id): a document's `supersedes`
  targets as written, and the document each resolves to (`NULL` when none),
  rebuilt by every index run like `links`. A reader that accepts 11 reads 12
  unchanged. Its migration clears `content_hash` the same way.
  Schema 13 (0.38.0) adds only the FTS5 table `chunks_fts` (heading,
  content), an external-content index over `chunks` kept in step by the
  triggers `chunks_fts_insert`, `chunks_fts_delete` and `chunks_fts_update`,
  and built from the existing chunk rows when a writable open migrates the
  database. No table or column a reader selects changed, so a reader that
  accepts 12 reads 13 unchanged. A writer that inserts, updates or deletes
  `chunks` rows keeps the index current through those triggers; it must not
  drop them. `chunks_fts` uses the same tokenizer as `documents_fts`, and a
  `search.language` rebuild recreates it from `chunks` in the same
  transaction. Schema 14 (0.38.0) recreates `documents_fts` with a fifth
  column, `aliases` (a document's aliases, one per line), and no longer
  writes them into its `tags` column. No table or column a reader selects
  changed, so a reader that accepts 13 reads 14 unchanged. The migration
  refills the table from `documents` and clears the markdown rows'
  `content_hash`, so the next index run writes each row again with its
  aliases. It also adds `name_keys` (key, document_id): each markdown
  document's title and aliases, case-folded with whitespace collapsed, the
  lookup exact-name search uses. Titles are keyed at migration; the next index
  run adds the aliases. Schema 15 (0.40.0) adds only the nullable
  `documents.verification` column: a markdown document's `verification`
  frontmatter as written when it is a non-empty string, else `NULL`. A reader
  that accepts 14 reads 15 unchanged. Its migration clears the markdown rows'
  `content_hash`, as schema 11's did, so the next index run fills it.
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

The client/server wire protocol, published as
`@schlessera/brain-ui-sdk/protocol`, is a **machine compatibility contract now**,
distinct from the experimental extension interfaces. Its frames, validation
policies and documented behavior follow this document's versioning rules:

- Additive changes ship in minors.
- Before 1.0, a break ships in a minor only after a maintainer ruling recorded
  before implementation, with the `breaking` label and a changeset naming it.
- From 1.0, a break requires a major.

Every contract change needs `CONTRACT:` and a same-commit contract update.
This classification does not freeze the experimental seams or schedule 1.0.
See the [wire-protocol decision](decisions/contract-versioning.md#wire-protocol-classification--2026-09-28).

Revision negotiation determines which rules apply to a connection; incrementing
the revision does not waive compatibility guarantees or semantic versioning.
The legacy tolerance and validation policies below remain binding.

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
  clients. Unknown object keys are preserved in both directions, except the new strict
  durable-inbox client commands described below. Existing frames retain their
  validation policy.

A third-party client may rely on that: adding a frame type, or an optional
field to an existing one, is not a breaking change. `BrainUiClient`
(`@schlessera/brain-ui-sdk/client`) implements this policy and is the supported
way to speak the protocol without reimplementing it.

### Durable Queue and Actions (additive)

The SDK defines the durable inbox wire shapes separately from Activity's
notification acknowledgement inbox. A host advertises optional
`server_hello.capabilities.inbox: true` only when durable subscriptions are
implemented. Missing/false means unsupported. Clients explicitly opt in with
`inbox_subscribe { view: "queue" | "actions", threadId? }`; the matching
`inbox_unsubscribe` ends that view/filter subscription. No `client_hello` or
new capability declaration is required for existing chat/Activity flow.
`createApp()` implements this stream on its existing authenticated WebSocket.
A `WsHost` without an attached inbox omits the capability and answers subscribe/
unsubscribe with `INBOX_UNAVAILABLE`; ordinary chat and Activity negotiation
keep their existing behavior.

`inbox_snapshot` contains the view/filter, `threads`, `items`, per-thread
`highWaterSeq`, global `cursor`, and optional `append` for chunk continuation.
`inbox_delta` contains its view and one `InboxChange`. Changes carry an explicit
`threadId`, global `changeId` and per-thread `seq`; `upsert_thread` carries the
thread, `upsert_item` carries `itemId` and the item, `remove_item` carries
`itemId`, and `remove_thread` needs no joined row. Clients discard deltas
before a snapshot and at/below that thread's high-water mark; reconnect
starts a fresh snapshot. The server captures rows, high waters and cursor in
one read transaction. Every subscription owns that boundary; a later subscriber
cannot advance the shared change scan past deltas owed to an earlier subscriber.
A 100 ms poll while subscribed discovers writes from other database connections.
Each pump scans at most five batches of 200 changes; later ticks continue the
backlog. Overlapping subscriptions on one socket receive each delta once per view.

Snapshots include all live threads and that view's items. A `threadId` filter
restricts threads, items and high waters to a currently existing thread; a
missing/deleted thread yields `INBOX_SCOPE_NOT_FOUND` rather than a global
subscription. Thread updates and tombstones reach both views; item upserts
reach their own view. Item tombstones carry scope without joining a deleted row.
An item's optional `runId` is display correlation, never a client-selected
access filter. Strict subscription schemas refuse injected run/authority fields.

Snapshot chunks and deltas preserve complete records within 512,000 UTF-8
bytes, including their envelope. The first chunk replaces a projection; subsequent
`append: true` chunks merge rows and high-water entries at the same cursor.
The high-water map is itself chunked. All chunks precede that subscription's
deltas. Clients merge high-water entries from every continuation. A single
record exceeding the limit produces `INBOX_FRAME_TOO_LARGE` and closes the
connection with code 1009; the server preflights every snapshot chunk before
sending its first frame. It never clips a field or silently omits a row.
A connection permits 64 distinct view/filter subscriptions; further scopes
receive `INBOX_SUBSCRIPTION_LIMIT`. Repeating a scope sends a fresh snapshot.

Subscriptions bind to the server-owned authorization context, using the
existing single-owner principal model. Delivery and idle polling recheck the
durable principal for revocation/expiry; unusable principals receive no further
operational records and close with 1008. Explicit revocation, socket close,
unsubscribe and application close release subscriptions and authorization
leases. With no subscribers the inbox poller stops. A dropped/throwing transport
ends the connection (1011), allowing recovery through a fresh snapshot;
queued backpressure remains a valid delivery.

Threads carry immutable server-assigned `trustClass` (`trusted`/`untrusted`),
`source` (`share`/`cli`), `status` (`open`/`closed`), the derived `stateMd`
projection (4 KB UTF-8 maximum), stakes (0–3), optional deadline, and creation/
last-seen times. Item metadata carries identity, thread, dedup key, creation/
update/expiry times, version, optional wait time and Activity run ID. All times
are UTC epoch milliseconds. Queue items (`triage`, `execute`,
`cleanup_pending`) carry attempt/lease/block metadata and use only
`scheduled | ready | claimed | done | blocked | failed | superseded | expired | dropped`.
Actions (`approve`, `choose`, `fyi`) carry title/detail and stored options,
and use only `pending | snoozed | resolved | dismissed | expired | dropped`.
FYIs carry no options. The store owns guarded transitions; defining these
vocabularies does not implement claims or resolution.

Each option carries a closed `ResolutionEffect`:

| Kind | Payload | Availability |
| --- | --- | --- |
| `enqueue` | `payload { instruction, operation? { toolName, input, targetPath } }` | v1 |
| `cancel_blocked` | No additional fields | v1 |
| `snooze` | No additional fields; timing is server-derived | v1 |
| `dismiss` | Optional `reason` | v1 |
| `write_policy` | `policy { slug, content }` | Deferred v2 data only |
| `open_session` | `seed { prompt }` | Deferred v2 data only |

`V1ResolutionEffect` and `v1ResolutionEffectSchema` exclude both deferred
kinds. `resolutionEffectSchema` describes all six kinds as data; it is not
an execution validator. `inboxOperationSchema`, `inboxWorkPayloadSchema`,
`inboxOptionSchema` and effect schemas reject unknown fields, including trust,
profile, principal and tool-policy injections. Arbitrary tool input is inert
JSON and also rejects nested authority fields. `targetPath` must be a canonical
brain-relative path. `validateResolutionEffect(value, allowedOperations)`
validates v1 data and binds any requested operation to one exact server-owned
tool/input/target tuple, independent of JSON object key order. The server must
revalidate current principal/thread authority at creation and application;
this helper neither grants permission nor proves filesystem/egress containment.
An instruction without an operation remains inside the restricted envelope.

Clients send `inbox_resolve { itemId, optionId, reason? }` to select a stored
option, or `inbox_snooze { itemId }` to request deterministic snooze. They cannot
submit effects, scheduling overrides or authority. Reasons are optional
`dont_ask_again | wrong_call | need_more_info | no_longer_relevant` feedback,
never standing grants. These four new client frame schemas are strict,
including subscribe/unsubscribe. New server projections preserve unknown keys
recursively for additive display compatibility; applying any displayed effect
requires the strict v1 validator again. The actual client/server parsers cover
all new frame kinds. These definitions enable later server work; they do not
enable unattended execution, policy formation or session creation.

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
raises more than one approval. The payload additionally carries `channel`
(`card` | `voice`, additive in 0.37.0) when the `tool_approval` / `tool_denial`
frame named the channel the decision was made on; absent means the client did
not say, and such a decision is stored exactly as before. A `tool_approval`
attributed to `voice` is refused — the request stays pending, nothing is
recorded, and the `tool_approval_request` is sent again to the connection that
replied, so its next answer is correlated — because the voice channel may deny and never grant
([decisions/voice-permission.md](decisions/voice-permission.md)), so a
voice-attributed grant in the record is by construction a bug.
An answered `ask_user`, `ask_user_list` or `ask_user_rank` interaction appends an
`ask_user_response` event carrying the responder's `principalId`.
A run's root span may additionally carry what the backend's runtime reported
about itself (additive in 0.37.0): `brain.runtime.name` / `brain.runtime.version`
(the runtime that actually ran, e.g. `claude-code` / `2.1.278`),
`brain.sdk.name` / `brain.sdk.version`, `brain.runtime.measured` (whether that
pair is the one the backend's behaviour was measured against), `brain.credential`
(the credential fields the runtime selected, in its own names),
`brain.billing_observed` (`subscription` | `api` | `unknown`, derived from that
credential) and `brain.billing_policy` (what the run's profile requires). When
the two disagree the root also carries `brain.billing_policy_violation` (a
sentence) and a `billing_policy_violation` event. A run that failed to
authenticate carries `brain.failure_class` (the runtime's own class, e.g.
`authentication_failed`, or `subscription_required` when the backend refused
the turn before sending it) and an `auth_failure` event. Absent means the
backend did not report it; older clients may ignore all of them.
A scheduled `brain sync` run (a `cron` root span with `jobName` `sync`,
written by the in-process scheduler or the container cron wrapper; additive in
0.40.0, #290) carries `brain.sync.agent`: `not-invoked`, `invoked`, or
`unknown` when the run ended without a readable `brain sync --json` result.
It may also carry `brain.sync.run_status` (the result's `run.status`),
`brain.sync.agent_reason` (`not-needed` | `no-runner`), and for an invoked
agent `brain.sync.agent_runner` and `brain.sync.agent_outcome` (`success` |
`failed`). `brain.runtime.name` / `brain.runtime.version` mean what they mean
on a chat run, and are set only from that sync run's own result: an agent not
invoked, a runtime that did not report, a version it did not give, and an
unreadable result write none. A span still open has none of these yet.
Authenticated `GET /api/status` reports them as `runtime.sync` beside chat's
`runtime.lastObserved`: `latest` is the most recent sync run
(`{ runId, startedAt, endedAt, outcome, agent, runtime }`, `agent` also
`pending` while the run is open, `runtime` null when that run recorded none),
and `lastObserved` is the most recent sync run that recorded a version
(`{ runId, startedAt, endedAt, runtime: { name, version }, latestRun }`,
`latestRun` false when a newer run did not). Either is null when no such run
is in the activity record; the runtime is read from what ran, so it may differ
from chat's.
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

### Per-message reasoning effort (additive, #543)

`chat_message.thinkingLevel?: ThinkingLevel` overrides effort for that message
only, including a resumed session. Its seven values are `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, and `max`; an invalid value is rejected by
frame validation before routing or backend execution. `StartTurnRequest`
accepts the same optional field. Each turn resolves request override → saved
profile override → configured profile/backend default → backend default.
Effort is re-read on resumes; model/session ownership remains pinned.

Claude's built-in profile uses `claude-opus-5-5` at `medium`. The Claude module
accepts `config.defaultThinkingLevel` beside `defaultModel`; the shipped host
sets it from `BRAIN_UI_CLAUDE_DEFAULT_THINKING_LEVEL` (default `medium`).
Declared profiles can supply `thinkingLevel` and `supportedThinkingLevels`.
Claude passes the resolved supported choice as the Agent SDK's `effort`.
`off` and `minimal` map to `low`; otherwise an unsupported choice resolves to
the nearest lower supported level, or the lowest supported level. Pi uses the
same downward resolution before setting its session effort, without writing
the global default. Unknown effort-less models omit the option.

`ProviderInfo` and `ModelCatalogEntry` optionally carry
`supportedThinkingLevels: ThinkingLevel[]` and the effective default
`thinkingLevel`. Claude now exposes these too, and `PUT /api/models/thinking`
accepts effort-capable Claude profile ids. A saved unsupported override stays
in `thinkingOverride`; `thinkingLevel` reports what it resolves to. Discovery
uses Models API effort capabilities; absent metadata uses conservative known
model capabilities. A proxy/unknown model may declare its supported choices.

Hosts supporting this path advertise `server_hello.capabilities.chatRequestAck`.
An optional `chat_message.requestId` is echoed on `session_info` when that turn
starts, on `status: queued` when parked, and on correlated refusals (`error`).
It is correlation, not durable deduplication. Clients clear a sent draft and
its override only on matching acceptance; a refusal keeps them. Messages with
`requestId` or `thinkingLevel` sent during a run queue as distinct next turns,
so they cannot alter a running turn's effort. Older messages without either
field retain native follow-up behavior. Clients on older hosts omit these
fields and keep their prior send behavior. If acceptance cannot be confirmed
across a disconnect or an uncorrelated frame refusal, the draft and override
remain editable with an explicit unconfirmed-send notice; reconnection never
resends them automatically.

`session_info`, effort-reporting `status` frames, and replayed user
`SessionHistoryMessage` may carry the requested `thinkingLevel` and a
runtime-confirmed `effectiveThinkingLevel`. Absent effective effort means
unconfirmed, not equal: consumers render “requested” until confirmed. Pi reads
its actual session level; Claude observes the main-turn Stop hook's active
effort after managed settings clamp it. Default-effort messages omit this
provenance. The host keeps it beside message source metadata in its UI database
and joins it on replay by exact text and ordinal. Retry retains the original
effort override; an accepted `retry_receipt` may echo `thinkingLevel` for the
new user row. No wire revision or required field changes.

### Message source (additive in 0.39.0)

`chat_message` may carry `source` — `typed` | `voice-dictate` |
`voice-conversation` — saying how the user produced the message. The host
keeps it beside the session and returns it as `source` on the replayed
`role: "user"` `SessionHistoryMessage`, so a dictated message still reads as
dictated after a reload or on another device.

- **Absent means `typed`**, in both directions: a client that does not send
  it is stored as typed, and a consumer that finds no `source` on a history
  message treats it as typed. A consumer that does not know the field
  ignores it.
- **A value the receiver does not know reads as absent.** It never costs the
  frame: a host still runs the message, and a client still renders the
  history.
- **The join is by text.** The host matches a replayed message to what it
  stored by the session, the exact text the backend replays, and the
  message's ordinal among identical texts. A message whose replayed text is
  not what the client sent (a pi `/skill:` or prompt-template command, which
  pi stores expanded) comes back without `source`.

### Local exchanges (additive in 0.40.0)

A command the client answers itself, without a turn (`/stats`), can be kept
as part of the session (#582). The exchange is
`LocalExchange = { id, command, prompt, answer, context }`: `id` is
client-minted (`[A-Za-z0-9_-]`, at most 128), `command` names it (`stats`),
`prompt` is the user's side as the transcript shows it (`Stats`), `answer` is
JSON the command owns and the host never reads (at most 64,000 characters
serialized), and `context` is the same figures as plain text for the agent
(at most `MAX_LOCAL_CONTEXT_CHARS`, 4,000, and never containing
`</local-answer>`).

```
client → { type: "local_exchange", sessionId, exchange: LocalExchange }
server → { type: "local_exchange_result", sessionId, exchangeId, saved, reason? }
chat_message.localExchanges?: LocalExchange[]          // at most 8
SessionHistoryMessage.localAnswer?: { exchangeId, command, answer }
```

- **An existing session** records an exchange with `local_exchange`. The
  host answers the sending connection with `local_exchange_result`;
  `saved: false` means the exchange is not part of the session, and a
  consumer must say so rather than drop it silently.
- **A new conversation** sends its exchanges as `localExchanges` on the
  `chat_message` that starts it. The host records them once `session_info`
  names the session and sends each client a `local_exchange_result`, which
  names the exchange by id, not by the transcript it lands in.
- **The agent sees an exchange once**, with the next prompt the host hands
  the backend in that session: its `context` travels in a
  `<local-answer command="…" id="…">` block after the user's text. From then
  on it is in the backend's transcript like anything else the user said.
- **Replay puts it back where it happened.** The host strips the block from
  the user message that carried it and replays the exchange just before that
  message: a `role: "user"` message whose `content` is `prompt`, then a
  `role: "assistant"` message with empty `content` and `localAnswer`. An
  exchange no prompt has carried yet replays at the end. A consumer that
  does not know `localAnswer` shows an empty answer; a session with no
  exchanges replays exactly as it did before they existed.
- **Recording an id twice keeps the first**, so a client may resend an
  exchange it is unsure was kept.

### Turn failures (additive in 0.40.0)

A turn whose model call failed says so on its terminal frame, in one shape
for every backend (#575). A turn that is retrying a failed call says that
while it runs.

```
TurnFailure = { errorClass, status?, message, authAction?, attempts?, resetsAt? }
TurnRetry   = { attempt, maxAttempts?, delayMs?, errorClass?, status? }

result.failure?: TurnFailure                  // on outcome: "error" only
error.failure?: TurnFailure                   // a bare error that ends a turn with no session
status.retry?: TurnRetry                      // on status: "thinking"
SessionHistoryMessage.failure?: TurnFailure   // on the assistant message the failure ended
```

- **`errorClass`** uses the Claude Agent SDK's class names
  (`authentication_failed`, `rate_limit`, `overloaded`, `invalid_request`,
  `model_not_found`, `server_error`, …), plus `subscription_required` for a
  turn the backend refused before sending it. It is free-form, so a new value
  is not a breaking change. `unknown` means the backend could not tell, and is
  never a guess. **`status`** is the provider's HTTP status. Absent means
  unknown, not "no status". **`message`** is the runtime's own text.
- **`authAction`** is set only on a Claude subscription's auth failure:
  `relogin`, `check_account` or `check_config`, as
  `subscriptionAuthAction(errorClass)` maps it, with
  `SUBSCRIPTION_AUTH_INSTRUCTIONS` for the wording (exported from
  `@schlessera/brain-ui-sdk/protocol`, and still from `/server`). A profile
  that bills its own API credential never gets one.
- **`attempts`** is a positive integer of observed retries before the terminal
  failure, not a guessed total including an initial call. Claude counts the
  turn's `api_retry` observations; pi keeps the last `auto_retry_start.attempt`
  it reports. No retry observation means the field is absent, including on
  unrecorded legacy history. A later successful turn carries no failure.
- **`resetsAt`** is an observed limit reset in epoch milliseconds (a nonnegative
  safe integer). Claude reads it only from a rejected `rate_limit_event` in
  that turn and converts the runtime's epoch seconds to milliseconds. It never
  derives a reset from retry delays. pi reports no reset time, so omits it.
  Absent means unknown; a reported past reset remains the observed timestamp.
- **One failure is reported once.** It rides the turn's terminal frame, and
  no other frame of the turn carries it. A diagnostic `error` sent before the
  `result` does not carry it. A consumer that shows both the diagnostic and the
  terminal failure must show them as one.
- **A partial answer is kept.** Text streamed before the failure stays the
  turn's text. `usage` and `costUsd` on a failed turn are what the turn spent,
  counted once.
- **`retry`** fields are present only when the runtime reported them.
  `detail` on the same frame says the same thing in words ("Retrying
  (attempt 2 of 10) in 5s after rate_limit, HTTP 429"), for a client that does
  not read `retry`.
- **Replay** carries `failure` on the assistant message the failure ended,
  after any partial answer, with the failure's text removed from `content`.
  The host retains the live terminal failure in its own UI database and joins
  it before inserting local exchanges or classified blocks. The key is the
  session, backend and assistant ordinal in that backend's normalized history,
  observed after the turn settles; it is not a text hash or host turn count.
  An ordered transcript-prefix digest and exact fallback failure text guard
  the position against changed transcripts. Identical failure texts at separate
  positions keep their own class, status, message, `authAction`, observed
  `attempts` and `resetsAt`. Reconnect
  history waits for the in-flight write; metadata survives host restart.
  A turn with no new stored assistant, or a read/write failure, retains the
  backend fallback rather than relabeling an older answer. Sessions without
  host records also retain that fallback. Claude recognizes its runtime's
  `<synthetic>` API-error messages by wording: the fallback can be `unknown`,
  with status/auth action only where the text supplies them. pi replays its
  failed answer's text and omits attempts that pi retried.
- **Tolerance.** A client that does not know these fields behaves exactly as
  before. A client that validates with `@schlessera/brain-ui-sdk/schemas`
  drops an unreadable `failure` or `retry` and keeps the frame, because the
  frame is a turn's terminal. An unreadable `attempts` or `resetsAt` is dropped
  independently while keeping the rest of the failure and its frame.

### Manual retry receipts (additive in 0.40.0)

```
result.retryOfTurnId?: string
SessionHistoryMessage.retryOfTurnId?: string
client → { type: "retry_turn", sessionId, failedTurnId, requestId }
client → { type: "retry_status", sessionId, requestId }
server → { type: "retry_receipt", sessionId, requestId,
           state: "accepted" | "refused" | "unknown", message?,
           text?, attachmentCount?, source? }
```

A handle identifies the latest failed turn whose original request the host
retains. It is absent when that request is unavailable, another input was
accepted, native follow-up injection made it ambiguous, or an unclassified
failure already received one manual retry. Historical cards cannot resend.
The host binds eligibility to the original principal and session. It retains
only one eligible request per session in the UI catalog, including original
image bytes, client options and the effective prompt. The next accepted
input removes those bytes; deleting the catalog session cascades them.

Retry starts a distinct turn in the same session. Prior actions may run
again: this is no rollback or guarantee against repeating tool effects.
Before dispatch the host atomically consumes eligibility and persists a
receipt. Repeating the same request id returns its receipt without executing
again. `accepted` means accepted for dispatch, not successful execution; a
host interruption can occur after recording it and before execution.
`refused` means this request was not dispatched. `unknown` means the host
cannot confirm its delivery, not that it was never sent.

Only the initial acceptance carries `text`, `attachmentCount` and `source`
for the client's new user row; receipts retain no prompt or image bytes.
After a lost acknowledgement, clients query `retry_status` with their stored
request id and reconcile accepted delivery through `session_resume`.
They must not blindly resend an unconfirmed request. Receipt lookup is bound
to the caller and session; another principal receives `unknown`.
Unreadable optional handles are dropped while preserving the failure frame.
Older peers ignore these additions and show the failure without Retry.

## File-layer contracts

- Markdown files: YAML frontmatter per `CONTRACT.md` (shipped in the package);
  `deadline` / `next_review` are ISO dates queried by briefing features.
- Optional `generated_from` (additive in 0.38.0): a non-empty string, either a
  repo-relative path to the document's source or a free-form tool name. It
  marks the document as produced by a tool or an agent pass, not written by
  hand. `brain validate` reports any other value as an error. `brain audit`
  reports a `propagation` issue when it names a markdown document updated
  after this one. The heuristic reranker weights a generated document ×0.85.
- Optional `verification` (additive in 0.40.0): `verification: unverified`
  declares the whole document unverified. `brain audit` then reports exactly
  one `verify` issue (`info`) for it, however many inline `[VERIFY: …]`
  markers it has. It is a declaration, not a state machine: there is no
  `verified` value, and a document without the field is not thereby verified.
  `brain validate` warns on any other value.
- Optional `supersedes` (additive in 0.38.0): on a newer document, the
  document or documents it replaces, as a wiki-link target (`"[[plan]]"` or
  `plan`) or an inline list of them, resolved like a body wiki-link, aliases
  included. Search multiplies a superseded document's score by 0.85 after
  fusion and reranking, in every mode and with `rerank: none`, and marks the
  result with `supersededBy`; the document stays in the results. `brain
  validate` reports as errors a value that is not one complete target or a
  non-empty list of them (an empty, blank or null entry, an unclosed `[[`, an
  empty `[[]]`), an unresolved target, and every document on a cycle (a
  document superseding itself through a chain), naming the others. A
  filter-only search (no query) marks `supersededBy` too, without reordering.
- `brain archive` / `brain_archive` set `status: archived` and bump `updated`.
  Since 0.38.0 they also set `relevance: historical` when relevance is
  `primary` or missing, and leave an explicit `secondary` or `historical`
  alone (additive). `brain validate` warns on `status: archived` with
  `relevance: primary`.
- The configured inbox dir (default `notes/`) with `status: active` =
  unprocessed inbox (capture targets this).
- Committed sidecars `.context-cache.jsonl` / `.asset-cache.jsonl`:
  content-hash-keyed `{k,v}` JSONL, appended from the db after embeddings
  runs — a committed value is never overwritten, a duplicated key resolves to
  its first line in sorted order, and a run with nothing new does not write
  the file. Machine-managed, union-merge on conflict, never hand-edit.
  Templates ship them empty.
- Committed `.stats-history.jsonl` (additive in 0.40.0): one `brain stats`
  snapshot per day, written by `brain maintain` and `brain stats --record`
  (see "Stats history"). Machine-managed; a brain gains it on its first
  recording, so templates need not ship it. `brain sync` commits it with the
  `config` group. It is union-merged like the sidecars: the template's
  `.gitattributes` carries `.stats-history.jsonl merge=union`, and `brain
  doctor --fix` appends the line to a brain without it. After a union merge,
  two lines for one day resolve to the later recording.
- Generated regions (additive in 0.38.0): content a command derives and keeps
  inside a hand-written markdown file sits between
  `<!-- brain:generated:{name} -->` and `<!-- /brain:generated:{name} -->`.
  Everything outside the markers is the author's and is never rewritten, byte
  for byte, trailing whitespace and line endings included; a region is
  rewritten, and the file's `updated:` bumped, only when its content changed. A
  marker counts only on a line of its own and outside code, so one quoted
  inside a line or in a fenced example is text.
  A file with a stray, doubled or out-of-order marker line is not rewritten;
  the command reports it instead, as it does a file whose frontmatter never
  closes. Generated values, the registry's cells and module-finance's alike,
  render a line break as a space, `|` as `\|` and `<!--` as `&lt;!--`
  (`inertGeneratedText`). `brain registry` owns the `registry` region of an
  `_index.md`, and module-finance the `finance` region of its ledgers and dashboard (which
  replaced its older `BEGIN GENERATED` / `END GENERATED` markers; those are
  still read and are rewritten to the region on the next `brain finance sync`).
- An `_index.md` opts in to a generated registry table with a `registry:`
  frontmatter block (additive in 0.38.0): `columns` (frontmatter keys, plus
  `title`, `path` relative to the index, and `link` as a `[[wiki-link]]`),
  optional `where: { key: [values] }`, optional `sort` (a column key, `-` for
  descending) and optional `split`: a key (one table per value), or
  `{ key, tables: { Label: [values] } }` (one table per label, in the listed
  order, left out when empty, then one per value no label took; a label that
  is a whole number, such as `"2"`, is rejected, since it would not keep its
  listed order; additive in 0.38.0). Its children
  are every markdown file under the index's directory, at any depth, other than
  an `_index.md`.
- module-jobs' opportunity `status.md` records the pipeline in frontmatter
  (additive in 0.38.0): `stage` (`researching`, `applied`, `screening`,
  `interviewing`, `offer`, `closed`), `fit` (`strong`, `medium`, `weak`),
  `applied` (a date), `next_step` (a string, whose date is the core `deadline`)
  and `closed_reason` (a string). A closed opportunity also carries
  `relevance: historical`. `brain jobs pipeline` generates the opportunities'
  `_index.md` from these fields; its audit checks report category `jobs-stage`.
- Module data files (e.g. module-jobs' `jobs.db`) are documented by the module
  that owns them.
- The scratch area `.brain/scratch/` (additive in 0.38.0) holds transient
  output and is never canonical: excluded from the index, stats and OKF
  export, and pruned to 7 days and 1 GB. Four writers are held to its rules
  and prune after writing: `brain render` (`--scratch`, stdin without `--out`,
  or `--out` into it), `brain image` (`--scratch` or `--out` into it),
  `brain okf export --out` into it, and the chat UI's `request_image_mask`
  beside a draft there. Each refuses to write until git excludes the
  directory itself (`brain doctor --fix` adds the line; a rule on the files
  alone does not count) and refuses a `.brain` or `.brain/scratch` that is a
  symlink. Other commands that write where a caller points them (`add`,
  `import`, pi's `write_file`, module data files) are canonical-content
  writers and are not held to scratch rules. The periodic pass is `brain
  maintain` (the hosting container runs it daily), `brain scratch prune`, and
  the chat server hourly. A file there may vanish at any time; a consumer that
  wants to keep one moves it out.

## Extension interfaces

These ten seams are `@experimental` until 1.0: breaking changes are
minor-version events, announced in the CHANGELOG. Each declaration carries its
own `@experimental` tag. Related experimental declarations include:
`BackendBridge`, `BackendCapabilities`, `StartTurnRequest`, `RendererPack`,
`SpeechSession`, `AsrClientOptions`, `AdapterResult`, `ScrapeContext`,
`RerankCandidate`, `RerankRequest`, `Ranked`, `AdapterStatus`,
`AdapterRunOptions`, `RunAdaptersOptions`, `AdapterOutcome` and jobs `JobAdapter`.
[#343](https://github.com/schlessera/brain-kit/issues/343) selects deliberate
public signatures, including their reachable types, for 1.0 stability; final
package-wide export curation is tracked in #534.
[extending/README.md](extending/README.md#the-seams) says what each one swaps.

The client/server wire protocol is a machine contract rather than an
experimental extension interface, including when an experimental backend
implements it. Its [revision negotiation](#revision-negotiation) and documented
compatibility guarantees follow the contract-versioning rules above.

| Interface | Imported from |
|-----------|---------------|
| `EmbeddingProvider` | `@schlessera/brain` |
| `CompletionProvider` | `@schlessera/brain` |
| `AgentRunner` | `@schlessera/brain` |
| `SkillEmitter` | `@schlessera/brain` |
| `Reranker` | `@schlessera/brain` |
| `AgentBackend` | `@schlessera/brain-ui-sdk/server` |
| `SpeechProvider` | `@schlessera/brain-ui-sdk/server` |
| `AsrClient` | `@schlessera/brain-ui-sdk/client` |
| `ToolRenderer` | `@schlessera/brain-ui-sdk/client` |
| `SiteAdapter` | `@schlessera/brain-scrape` |

`tests/seam-list.test.ts` fails when this table, the one in
extending/README.md and the tags in the source disagree.

### SiteAdapter conformance and migration

Under the [2026-09-28 adoption ruling](https://github.com/schlessera/brain-kit/issues/344#issuecomment-5866304745),
all ten jobs boards implement `SiteAdapter<RawJob>` and production jobs
scraping uses the shared `runAdapters` runner. The seam remains experimental
until 1.0; the [decision](decisions/site-adapter-adoption.md) records the
boundary and alternatives.

- `scrape(ctx, options)` returns `AdapterResult<T>` with `items`, required
  `status`, optional opaque `cursor`, and `errors`. `AdapterStatus` is `ok`,
  `empty`, `unparseable` or `not_run`. `ok` permits partial items with errors;
  `empty` requires positive readable-page evidence, never only zero items.
  Readable but unrecognized pages are `unparseable`; no readable result is
  `not_run`. Jobs retains its existing `PageLedger` checks and diagnostic text.
- `AdapterRunOptions` supplies `incremental`, previous `cursor`, `queries`,
  `proxy` and per-site `fetch` overrides. Adapters forward applicable options
  per request; one source's options never mutate the shared HTTP client. Jobs
  preserves explicit board pacing floors; a run may request a longer delay.
- `runAdapters` executes in selection order, supplies the shared HTTP client,
  and supplies browser context only to adapters declaring `needsBrowser`.
  Unavailable required transports, thrown options or adapter failures yield
  `not_run` without aborting later sources. A browser created by the runner is
  closed in `finally`; a caller-supplied session stays caller-owned. Constructed
  browsers share the HTTP client's robots cache, limiter and User-Agent unless
  their explicit browser options override them. Browser navigation retains
  the [existing policy](#browser-scraping-navigation-policy).
- `JobAdapter` in module-jobs extends the generic contract with source, tier,
  detail-host allowlists and detail-fetch metadata. Jobs owns cursor/logging,
  enrichment, scoring and database cleanup. Every selected source still has
  the existing CLI report row and status/error/cursor semantics above.

The approved pre-1.0 API break requires consumers to add `AdapterResult.status`,
use `JobAdapter` instead of removed `ScraperAdapter`, and use generic
`AdapterResult<RawJob>` instead of removed jobs `ScrapeResult`. Call
`scrape(ctx, options)` instead of `bind(ctx).scrape(opts)`, pass `cursor` instead
of `lastCursor`, read `items` instead of `jobs`, and take source identity from
the adapter or runner outcome. `ok([])` reports diagnostic `unparseable`, not
confirmed empty. The CLI `{ report }` envelope does not change.

### AgentBackend conformance baseline

Every conforming `AgentBackend` must honor a requested
`StartTurnRequest.enforceAllowedTools` or `StartTurnRequest.noGrantSurface`, or
reject an unsupported restricted turn with `BackendRequestError` before
runtime acquisition, protocol frames or effects. Silently ignoring either is
nonconforming. Both inputs remain optional; absent or false retains ordinary
turn defaults. This pre-1.0 tightening follows the
[maintainer's ruling](https://github.com/schlessera/brain-kit/issues/341#issuecomment-5866237390)
and [decision record](decisions/backend-conformance.md); it does not freeze all
experimental extension interfaces.

Enforcement requires a permission decision for an off-allowlist tool, including
runtime auto-approval shortcuts. Such requests carry
`outsideEnforcedAllowlist: true`; a denial prevents the tool body from running
and reaches the model as a denial. `noGrantSurface` is valid only with
`enforceAllowedTools: true`; otherwise the turn rejects before execution. In a
valid no-grant turn, both tool grants and command confirmations are denied
promptly without an unanswered bridge request, with a named tool error and
`permission_denied` activity evidence.

`runBackendContract` in `@schlessera/brain-ui-sdk/testing` checks this baseline
with a required permission probe and observable tool-body effects. Both
first-party backends demonstrate enforcement with keyless scripted runtimes,
rather than passing solely by rejecting every restricted turn.
`runBackendModuleContract` checks a `defineBackendModule` descriptor's nonempty
profile parsing and resolution, confirmation-pattern defaults/disablement,
typed invalid-JSON failures and occupied-id collisions. A backend that passed
the earlier suite may fail these stricter cases; the testing harness's
`permission` member is newly required.

Module manifests are two-phase: `defineModule({ name, configSchema?, setup })`,
where `setup(validatedConfig)` returns the contribution. The contribution is
schema-validated at load — unknown keys are load errors — and module commands
receive `{ root, json, config, taxonomy }`, so a command must NOT re-read
`brain.config` itself. The explicit `brain travel migrate` source-edit job
above is an exception: it never computes effective configuration or
serializes evaluated TypeScript. See [modules.md](modules.md).

## Module tools

`ModuleContribution.tools` declares lazy MCP definitions by local name.
`brain mcp` imports these definitions at startup and serves them after the
eight core tools, in module config order and then declaration order. A loader
may resolve a `ModuleTool` directly or an object with a `default` tool export.
Other CLI commands do not import the definitions.

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
[module-tool decision](decisions/module-mcp-tools.md) for the full specification.

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

## Configuration exclusions

`exclude.files` contains exact relative file paths; `exclude.dirs` excludes
directories and their descendants, and `exclude.segments` excludes matching
directory segments at any depth. Directory pruning and output-directory
authorization consult only directory/segment rules, never exact-file rules.

**Breaking in the next minor release (approved in #224):** configuration
loading rejects `exclude.files` entries ending in `/`, which were previously
accepted and could make stats disagree with indexing. The error identifies
the field and value and directs the author to `exclude.dirs`. To exclude a
whole directory, replace `files: ["drafts/"]` with `dirs: ["drafts"]`.
Valid exact-file, directory and segment exclusions keep their semantics;
CLI JSON shapes are unchanged.

## Backend confirmation-pattern initialization

**Pre-1.0 breaking tightening (#251):** `compileConfirmPatterns` and both
first-party backend constructors reject a nonempty `confirmBashPatterns` list
if no regex compiles, before turn or tool activity. The server's
`BRAIN_UI_CONFIRM_BASH` regex list follows the same initialization rule. The
error names both configuration fields, preserves invalid-source diagnostics,
and directs the caller to repair the list or intentionally use `[]`; exact
error prose is not a machine schema.

Missing backend configuration still uses the shipped defaults, and explicit
`[]` still disables confirmation. Mixed lists report and skip invalid entries,
preserving the valid patterns, their matching order and effects. The server's
existing malformed-JSON and structural-entry fallback retains its semantics.
The rationale is recorded in [confirm-patterns.md](decisions/confirm-patterns.md).

## Nullable asset enrichment

**Approved pre-1.0 breaking API change (#411):** `Enrichment.describeAsset`
from `@schlessera/brain` now returns `Promise<string | null>` rather than
`Promise<string>`. `createEnrichment` returns `null` when its completion
provider lacks vision (without calling `complete`) or returns empty/whitespace
text for an image or PDF. Non-empty output is trimmed and accepted even if it
equals the title. Errors still reject; `CompletionProvider.complete` and
`Enrichment.generateChunkContext` retain their string return types.

Callers handle `null` before persisting, caching or embedding a description.
Custom implementations return `null` for no description and non-empty strings
for success; always-successful implementations may retain `Promise<string>`.
The shipped `@schlessera/brain/testing` completion contract suite now asserts
`null` and zero completion calls for no vision, and `null` for empty output.
[Caller migration guidance](extending/completions.md#migrating-asset-enrichment)
includes an example.

The indexer leaves undescribed assets on their document/chunk/FTS placeholders,
keeps them findable by title, and queues neither description cache entries nor
embeddings for them. A later `--embeddings` run retries unchanged assets. A
`null` report says only that no description was returned, without attributing
a cause. Existing cached strings are preserved, including title-equal strings;
this change prevents new fallback entries and does not identify old ones.
Use [`--forget-cache <path>` then `--embeddings`](concepts.md#sidecar-caches)
to regenerate a known bad entry; forgetting resets sidecar and database state
for all assets sharing its bytes. Rebuilding only `brain.db` can reuse the old
sidecar and is insufficient.

## Backend-authoring permission toolkit

The deliberate toolkit is exported from `@schlessera/brain-ui-sdk/server`:

| Operation | Public signature types / result |
| --- | --- |
| `decideToolPermission` | `ToolPermissionDecisionInput` → `ToolPermissionApproval | null` |
| `createToolPermissionRequest` | `CreateToolPermissionRequestInput` → `PermissionRequest` |
| `requestToolPermission` | `Pick<BackendBridge, "requestPermission" | "activity"> | null | undefined`, `PermissionRequest`, optional `RequestToolPermissionOptions` → `Promise<PermissionDecision>` |
| `checkEditedApproval` | `EditedApprovalCheckInput` → refusal message `string | null` |
| `compileConfirmPatterns` | `readonly ConfirmPatternSource[]`, invalid-source callback → `CompiledConfirmPattern[]` |

These operations, their exported types and every signature-reachable bridge,
activity and protocol type are intentional authoring surface. They remain
experimental until 1.0, then stabilize under the existing versioning policy;
this does not schedule or freeze 1.0 early. The API report records the complete
signatures and reachable types. The
[authoring guide](extending/agent-backends.md#the-public-permission-toolkit)
shows the binding, and the
[decision inventory](decisions/backend-authoring-toolkit.md) records the exact
public/internal classifications under #343 Q1/Q2.

Adapters decide before dispatch, honor denial and use the same snapshotted
`updatedInput` for checking and application. Missing bridges and no-grant
surfaces deny; no-grant surfaces never ask the host. A throwing denial-activity
reporter cannot change the decision. Bridge rejections remain rejections for
the adapter to translate. Edits introducing a per-use confirmation absent from
the original input are rejected, including a changed full shell command or
archive target; an own `__proto__` key is rejected. Allowed safe edits and
unchanged confirmed inputs may execute.

Confirmation sources accept strings and `{ pattern, effect }`, compiled
case-insensitively in source order. Mixed lists report invalid entries and
retain valid ones; a nonempty all-invalid list throws. `[]` is the intentional
opt-out. Explicit tool-name matching, tool grants versus command confirmations,
archive checks and enforced-turn posture remain promised behavior.

Bundled defaults can change with documented user-visible release notes while
preserving those guarantees. Their precise entries and wording are not frozen;
policy formats and behavioral guarantees are not exempt from versioning.
Subscription-auth action values, mapping and actionable instruction helpers
remain public under the existing wire contract; instruction wording may improve.

Pre-1.0 import migration: the SDK's `DEFAULT_CONFIRM_BASH_PATTERNS`,
`ARCHIVING_UPDATE_REASON`, `archivesDocument`, `bashCommand`,
`SubprocessEnvAudience`, `SUBPROCESS_ENV`, `filterSubprocessEnv` and
`parseSubprocessEnvExtra` move from `/server` to `/internal`. Claude's
`DEFAULT_CONFIRM_BASH_PATTERNS` alias and `VOICE_ALLOWED_TOOLS`, and pi's
`DEFAULT_PI_ALLOWED_TOOLS` and `TOOL_RISK`, move from their ordinary entries to
those packages' `/internal` entries. These explicit internal paths are for
first-party implementation sharing at the same lockstep version, with no
compatibility guarantee. Their existence does not define another extension
seam or classify the other exports covered by the package-wide inventory.
Operator environment configuration retains its documented meaning; the
subprocess implementation table is internal.

## Durable share and CLI intake (additive, #679)

`brain queue add --server ORIGIN --key KEY [--credential-file FILE]
[--title TITLE] [--text TEXT] [--url URL] --json` queues intake on the UI server.
It does not replace `brain add`, index content or mutate the local brain.
It runs without a local brain configuration. At least one nonempty content
field is required, and the explicit key must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`.

The exact success envelope is `{ "queued": true, "created": boolean,
"threadId": string, "itemId": string, "stagingId": string }`, exit 0. Duplicate
key/content returns the original IDs with `created: false`. A different payload
for that key is refused. Queueing only creates a thread and triage item; neither
queueing nor `trusted` provenance authorizes filing or inference.

Transport failures in JSON mode are `{ "queued": false, "error": {
"code": string, "message": string } }`. Codes are `credential_file_invalid`
(exit 1), `unauthorized` (1), `key_conflict` (1), `queue_failed` (2 for a 5xx,
otherwise 1), `invalid_response` (2), and `server_unavailable` (2). The exact
unavailable-server result is `{ "queued": false, "error": {
"code": "server_unavailable", "message": "Queue server unavailable; retry with
the same --key." } }`. Normal CLI argument/usage errors keep the existing
stderr/exit-1 convention. Human success explicitly says content has not been filed.

`--server` must be an HTTP(S) origin, with no credentials, path, query or
fragment. HTTP is allowed only for loopback; other origins require HTTPS.
The optional private credential file contains exactly `{ "server": "ORIGIN",
"cookie": "SIGNED_PRINCIPAL_COOKIE_VALUE" }`, at most 4096 bytes, a regular
file with no group/other permission bits; symlinks are refused. Its normalized
server origin must match `--server` before any request. The cookie is the
existing `brain_ui_session` principal cookie, including a delegated credential
returned by `POST /api/auth/principals`; it retains its existing expiry and
revocation semantics. Cookie authentication applies in password mode; other
server auth modes keep their existing configured authority. No provider key,
ambient cookie environment variable or credential for another audience is read.
Requests have a 10-second timeout and never follow redirects; response JSON is
bounded to 64 KiB. The cookie is never emitted in an error or result.

The transport is protected `POST /api/queue`, whose strict request, response,
errors and recovery promises are specified in [HTTP API](http-api.md#authenticated-cli-intake-additive-679).
Shares keep their existing 201 `ShareIntakeResult` envelope and interactive
confirmation flow, while the real app also records an untrusted triage item.
Unknown multipart authority fields are refused. Duplicate normalized shares
reuse the original staging result; source/principal provenance is server-owned,
immutable and separated from CLI dedup keys. Queue-backed staging is exempt
from legacy opportunistic pruning. Standalone staging retains its old lifetime.
No production autonomous dispatch is enabled by these additive surfaces.
