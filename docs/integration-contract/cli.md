# Integration contract — cli

Authoritative component of the [integration contract](../integration-contract.md).
Its [shared scope and versioning policy](../integration-contract.md) apply to every section below.

<a id="operational-recovery-command-additive-686"></a>

## Operational recovery command (additive, #686)

The Bun-only `brain-ui-inbox` bin accepts `export` or `restore` with required
`--db <file>`, `--brain-root <directory>`, `--file <backup.json>` and optional
`--json`. Paths are explicit; there are no environment defaults.
Export protects database/sidecar/staging destinations through aliases. Restore
accepts a new database/empty staging target, or the unchanged pending target from the identical
interrupted restore. It never merges a populated target or opens `brain.db`.

With `--json`, stdout contains one JSON object and a newline:

| Outcome | Shape and exit |
| --- | --- |
| Export | `{ schema_version: 1, ok: true, command: "export", snapshot: { version: 1, checksum: string, created_at: number, recovery_point_hours: 24 } }`; exit 0. |
| Restore | `{ schema_version: 1, ok: true, command: "restore", recovered: number, resumed: boolean }`; exit 0. `recovered` counts restored claims released into bounded retry/dead-letter recovery. |
| Failure | `{ schema_version: 1, ok: false, error: { code: string } }`; exit 2 for `inbox_usage`, otherwise 1. JSON failure reports no private file paths or exception details. |

Consumers tolerate unknown error codes. Supported codes include
`inbox_snapshot_version`, `inbox_snapshot_checksum`, `inbox_snapshot_schema`,
`inbox_snapshot_relations`, `inbox_snapshot_projection`,
`inbox_snapshot_reservation`, `inbox_snapshot_staging`,
`inbox_snapshot_missing_staging`, `inbox_snapshot_changed`,
`inbox_snapshot_destination`, `inbox_restore_nonempty`, `inbox_restore_clock`,
`inbox_restore_staging_changed`, `inbox_restore_pending`,
`inbox_staging_symlink`, `inbox_staging_directory`, `inbox_staging_file`
and `inbox_operation_failed` for unclassified schema/SQLite/filesystem failures.
Without `--json`, success is human text; failures go to stderr.

The private artifact is strict format `"brain-ui-operational-backup"`, version
`1`: `{ format, version, createdAt, recoveryPointHours: 24, database:
{ data, sha256 }, directories: string[], files: [{ data, sha256, path }],
checksum }`. Times are UTC epoch milliseconds. Byte data is canonical base64;
digests are lowercase SHA-256 hex. Paths are flat files under sorted canonical
UUID staging directories, or their `.UUID.partial` directories. Directories
and files are sorted in bytewise path order.

The outer checksum hashes UTF-8 `JSON.stringify` of validated fields excluding
`checksum`, in the displayed key order; database/file byte objects use
`data, sha256`, with file `path` last. JSON whitespace and input object-key order
do not affect validation. SQLite WAL image header bytes 18/19 are normalized
to rollback mode in the copy for SQLite deserialization; live WAL is unchanged.
The complete image retains all UI state, including principal/authentication
records, Activity accounting, inbox relations and completed-call receipts.
Each staged file is included with its own digest; required references/manifests
must agree. An exact compatible SQLite schema/migration set is required.

Database publication holds a durable pending gate while staging is restored.
App/runtime startup, model claim/acquisition and compensation claims fail closed.
Active budget settlement and old-worker claim recovery commit with the gate
opening in one immediate transaction, preserving observed/conservative cost,
admission day, attempts and stable follow-up identities. Receipts restrict
replay under current authority. This neither enables production dispatch nor
promises to recover effects newer than the backup.

The [recovery guide](../inbox-recovery.md) defines the 24-hour objective, atomic
export publication, sensitive-artifact handling and same-artifact crash
resumption. The host must retain a successful complete export at least every
24 hours; content Markdown remains separately backed up in Git.

<a id="cli-conventions"></a>

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

<a id="stable---json-shapes"></a>

### Stable `--json` shapes

| Command | Shape |
|---------|-------|
| `brain search "q" --json` | `{ "results": SearchResult[], "warnings": string[] }` — `warnings` reports degraded modes (no vectors, model mismatch, missing key, a reranker that did not run). `--rerank none\|heuristic\|jev`: `jev` added in 0.39.0, additively; unset, the configured `reranker.provider` (judgment requires `reranker.enabled: true`; otherwise local `heuristic`, or `none` when selected). `--rerank-dry-run` (0.39.0) prints the reranker's outbound request to stderr and sends nothing, even while disabled or keyless. Date filters `--updated-since`, `--updated-before`, `--deadline-from`, `--deadline-to` (`YYYY-MM-DD`, inclusive; a deadline filter drops undated docs), `--sort score\|updated\|deadline` (default `score`; `updated` newest first, `deadline` earliest first with undated docs last) and `--upcoming` (= `--deadline-from <today, UTC> --sort deadline`) added in 0.38.0, additively. Stored dates are compared as their UTC day (sorts keep full timestamp precision). A stored value counts only as an ISO `YYYY-MM-DD`, optionally followed by `T` or a space, `HH:MM`, seconds, a fraction and a `Z` or `±HH:MM` offset. Anything else, `2026-02-30` and `now` included, counts as missing: it matches no bound and sorts last. With a query, a date sort picks the results by date from a candidate pool: the full-text lane's best `max(limit × 20, 500)` documents, plus the documents behind the vector lane's nearest chunks (at most that many documents, from at most 500 chunks). An invalid date or sort is a usage error (exit `1`) |
| `brain audit --json` | `{ "issues": AuditIssue[], "errors", "warnings", "infos", "mustFix", "informational" }` — markdown documents only (assets excluded). The three severity counts are the number of issues at each severity. `mustFix` is `errors + warnings` and `informational` is `infos` (both additive in 0.40.0): severity stays the one classification, and the two totals only name its halves. Every count is of issues, not of markers. **Breaking in 0.40.0:** `todo` and `verify` issues are grouped, one per document and category (see [`AuditIssue`](#auditissue)), and `verify` is `info` instead of `warning`, so a brain with markers reports fewer issues and fewer warnings than before for the same content. **Additive in 0.41.0:** `brain audit --fix --json` returns `AuditFixResult[]`, one result per finding in finding order: `{ path, issue, suggestion, canAutoFix, fix?, repair? }`. `path` is the finding path, `issue` its message, and `suggestion` its own advice (or "Manual review needed."); an unavailable `index-stale` instead names the failed repair premise, or says no registry content change is required. `canAutoFix` is true only for an actually available deterministic registry repair: safe contained path, valid opted-in registry with a content change, configured child types and no validation errors under the index directory. Available results also carry `repair: { capability: "registry", path: <index path> }`; all other categories and failed premises are manual with no `repair`. `repair` describes availability, grants no permission, and applies nothing. Optional `fix` means exact replacement text; this command never emits it. No completion provider is called, even if configured |
| `brain context "q" --max-tokens N` | assembled markdown context (text) |
| `brain read <path> [--section <heading>] [--max-tokens N]` | the document text; the flags behave as `brain_read`'s `section` and `max_tokens`, and an unknown section exits `1` (flags additive in 0.38.0) |
| `brain briefing` | briefing text (mechanical: deadlines, reviews due, silent edits — no LLM) |
| `brain index [--force] [--embeddings] --json` | `{ "total", "added", "updated", "deleted", "unchanged", "chunks", "embeddings", "assets", "graphMs", "graphNodes" }`, all numbers, each counting this run only. See [`brain index` counters](#brain-index-counters). Incremental by default, `--force` = full rebuild, `--incremental` accepted as no-op |
| `brain index --forget-cache <path> --json` | `{ "path", "forgotten" }` — `forgotten` is the number of sidecar lines removed for that document or asset (for an asset, every line for its bytes, whatever the title). Runs no index pass; the next `--embeddings` run regenerates what was forgotten. A path not in the index is a usage error (additive in 0.38.0) |
| `brain index --compact --json` | `{ "compacted", "before": { "live", "allocated" }, "after": { "live", "allocated" } }` — rebuilds `vec_chunks` from its live rows and runs `VACUUM`, reclaiming the slots deleted vectors leave behind; `before`/`after` have the shape of `brain stats` `size.db.vectorSlots`. `compacted` is `false` only when there is no vector table. Makes no provider call and runs no index pass (additive in 0.38.0) |
| `brain maintain --json` | `[{ "step", "result" }]` in run order: `registry`, `index`, `vectors`, `audit`, `stats`, `tags`, `git`, `scratch`. The `stats` step also carries additive `trends` (see "Recorded corpus trend verdicts"), evaluated before recording. The `stats` step (additive in 0.40.0) is `brain stats --record`: `ok — recorded <date> in .stats-history.jsonl (<n> snapshot(s) kept[, <m> older thinned])`, or `ok — replaced …` on a second run the same day. The `registry` step (additive in 0.38.0) is `brain registry`: `ok — <written> of <indexes> table(s) rewritten`, `FAILED — …` when an index's `registry:` block is invalid. `result` is a human-readable string that starts with `FAILED` when the step failed (and the exit code is `2`); the `tags` step never fails, and reports `skipped — …` instead. The `audit` step's result is `<errors> error(s), <warnings> warning(s), <infos> info(s); <mustFix> must-fix, <informational> informational`, the totals `brain audit --json` reports for the same run (the must-fix and informational part additive in 0.40.0; the counts follow the grouped `todo`/`verify` issues from 0.40.0). The `vectors` step (additive in 0.38.0) compacts the vector table the way `brain index --compact` does, only when fewer than half its slots are live and at least one internal chunk would be freed; otherwise it reports `ok — <live> of <allocated> slots live, nothing to reclaim`, and `skipped — …` when the slots cannot be read |
| `brain registry [--check] --json` | `{ "indexes", "written", "stale", "invalid": [{ "path", "error" }] }` (additive in 0.38.0). Regenerates the registry table of every `_index.md` whose frontmatter has a `registry:` block. `indexes` counts them, valid or not. `written` lists the files rewritten. `stale` lists out-of-date indexes left as they are: all of them under `--check`, which writes nothing, and otherwise one whose file changed between being read and being written (it is regenerated on the next run). `invalid` lists indexes that cannot be generated, which are left untouched: a `registry:` block that does not validate, an index or a child that cannot be read, whose frontmatter does not parse, or whose frontmatter opens and never closes (an `_index.md` whose frontmatter does not parse counts when it has a `registry:` line, quoted or not), or malformed region markers. Exit `1` under `--check` when anything is stale or invalid, `2` without it when anything is invalid, else `0` |
| `brain list --json` | `ListedDocument[]` — a bare array, newest `updated` first. Filters: `--type`, `--tag`, `--status`, `--relevance`. `--limit` is a whole number from `1` to `100`, default `20`; the whole argument must be an integer literal. Anything else (`abc`, `10abc`, `1.5`, `0`, `-1`, `101`, or `--limit` with no value) is a usage error (exit `1`, a message on stderr, nothing on stdout) in human and JSON modes, and no query runs. **Breaking in 0.41.0 (#1351):** `--limit` used to be read with `parseInt`, so `10abc` listed 10, `1.5` listed 1, `abc` was passed through as `NaN`, and values above 100 were honoured |
| `brain add "<content>" --json` | `{ "action": "created"\|"appended", "path", "title", "type", "indexed", "indexError"? }` — `path` is repo-relative. `indexed` is `false` when the file was written but the reindex after it failed, and `indexError` (a string) is present only then. `appended` means the content went under a new dated heading in an existing document of the same title and type. `--smart` hands the capture to the coding agent and prints its text instead |
| `brain sync` | `{ run, agent }` in machine mode (`--json`, or stdout not a TTY); its text report in human mode (`--human`, or a terminal). With no verb, `sync` runs `brain sync run`. When an agent runner is configured and the run needs one (a conflict no strategy merges, an `UNKNOWN` leftover, or a `MEDIA`/`LARGE` leftover with a terminal attached), it then runs the `/sync` skill and exits `0`. Without an agent runner the exit code is `run`'s: `0` complete, `1` failed, `3` something left for judgment: a conflict no strategy merges (left in progress, nothing pushed) or a file holding conflict markers (left uncommitted, never pushed). An agent run that fails exits `2`, its error on stderr. **Machine mode** prints exactly one JSON document on stdout, whatever the agent did, and nothing else: no report, no progress, no agent text beside it. `run` is the envelope `brain sync run --json` prints (its `status` and `report` are contract; its other fields drive the `/sync` skill and are not). `agent` is `{ invoked: false, reason: "not-needed" \| "no-runner" }` — `no-runner` when the run needed an agent and none was available — or `{ invoked: true, runner: string, outcome: "success" \| "failed", runtime: { name: string, version: string \| null } \| null, text: string \| null, error?: string }`. `runtime` is what that agent run reported about itself while it ran, never probed and never taken from another run: `null` when it reported nothing (a runner that does not report, or a run that ended first), `version: null` when it named itself without a version. The built-in `claude` runner reports `{ name: "claude-code", version }` from the Claude Code session's `system`/`init` event (`claude_code_version`), the field chat records as `runtime_observed`. A failed agent run still prints the result, with `outcome: "failed"`, `text: null`, `error`, and any runtime it reported before failing. Not invoking an agent says nothing about model cost: the sync judge and enrichment can call a model without one. **Human mode** prints the report, then the agent's final text when it ran, with tool progress on stderr. **Breaking in 0.40.0 (#290):** bare `sync` printed its text report in every output mode, so a caller that read stdout as text passes `--human`, or reads `run.report` and `agent.text`. **Breaking in 0.39.0:** it used to run the agent unconditionally, print only the agent's text, and exit `1` when no agent runner was available. The verb is the first positional argument, so output-mode flags may come before it: `brain sync --json` is still the bare form, and `brain sync --json assess` is `assess --json`. An unknown flag exits `1` (`Unknown flag: --x`). The mechanical verbs (`run`, `assess`, `group`, `commit`, `stash`, `pull`, `resolve`, `conflicts`, `conclude`, `push`, `post-sync`) follow the usual output mode — JSON when stdout is not a TTY or with `--json`, otherwise command-specific human-readable text — and their shapes, which exist for the `/sync` skill to drive, are not part of this contract |
| `brain module list --json` | `{ "enabled": [{ "name", "key", "description", "types", "commands", "tools": string[], "cron": [{ "name", "schedule", "command" }], "state": "active" \| "dormant", "contextTokens": number }], "available": [{ "key", "description", "enabled": false }] }` — Existing fields and envelope are retained. The historical `enabled` array includes every configured module, even dormant ones. `key` is the module's `brain.config` key. `types` and `commands` are its declared type names and CLI words; `tools` stays the declared canonical names. `description` is from package.json, or null. `available` lists declared packages absent from config. `cron` is shape-constrained and empty for dormant modules. `contextTokens` is a nonnegative integer active-context estimate (see Module dormancy below). |
| `brain module enable <name> --json` / `disable <name> --json` | `{ "module": string, "state": "active" \| "dormant", "changed": boolean, "context": { "entered": string[], "left": string[] } }` — Toggle a configured manifest name, preserving domain config and documents. Synchronize managed skills and owned instruction regions. Unchanged repeated commands return changed:false. Errors use the existing nonzero-exit/stderr convention. |
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
| `brain hygiene reconcile [--extra <file.json>] [--fixed <file.json>] [--dry-run] --json` | `{ "opened", "reopened", "resolved", "stillOpen", "snoozed", "changedFiles": string[], "detected": [{ "id", "category", "path", "message" }], "autoFixed", "failedChecks": string[] }`. The counts are this run's transitions: `opened` new issues, `reopened` issues back from resolved or an expired snooze, `resolved` issues no longer detected, `stillOpen` open issues still detected (or kept open while a check could not run), and `snoozed` the entries left snoozed. `changedFiles` lists the files under `context/hygiene/` written (or, with `--dry-run`, that would be); it is empty on a run that changes nothing. `detected` is every issue found this run, with its stable ID `{category}-{shortpath}-{hash4}` (hash4: SHA-1 over `{category}\|{path}\|{evidence}`). `--extra` is a JSON array of `{ "category", "path", "evidence", "message" }`, and `--fixed` a JSON array of `{ "path", "fix" }`, the auto-fixes to record in `last-run.md` (`autoFixed` counts them); a malformed one exits `1` and writes nothing. `failedChecks` names each check that could not run: a module whose hygiene check threw, or a core check that could not read its input (`fact-drift`, `tag-noise`); while any is named, no entry is resolved unless it was detected again. `--dry-run` writes no log file (the index is still refreshed). A log file that cannot be parsed safely (broken frontmatter, a section mixing entries with other text), or that changes while the command runs, exits `2` without writing it (a save in the instant between the last check and the rename can still be lost; there is no lock) (additive in 0.38.0). Additive in 0.41.0 (#1024): detection also runs `brain validate`'s corpus checks (`validation` in `failedChecks` when they cannot run), and candidates with one ID are one finding. Each `detected` item adds `"severity": "error"\|"warning"\|"info"\|null`, `"urgency": string\|null`, `"sources": [{ "source", "name", "severity" }]` (never empty) and `"fingerprint"` (12 hex digits). The envelope adds `"dismissed"` (entries left dismissed), `"invalidated"` (dispositions whose evidence changed this run) and `"invalidations": [{ "id", "disposition": "dismissed"\|"snoozed", "dispositionOn", "changed": string[], "previousId" }]`. `--extra` items may add `"severity"` and `"urgency"` (lowercase letters, digits and `-`). See [Hygiene review data](package-api.md#hygiene-review-data-additive-1024) |
| `brain hygiene next [--extra <file.json>] --json` | Reconcile + validation join, then one highest-priority eligible canonical finding: `{ "finding": object\|null, "counts": { "eligibleRemaining", "fixed", "dismissed", "snoozed", "nextSnoozeDueAt", "informationalNotShown" } }`. Exit `0` includes an empty backlog. Invalid configuration exits `1` with `{ "blocker": { "kind": "configuration", "message", "path", "line", "column" } }` before indexing or hygiene writes. Other unavailable checks exit `1` with `{ "blocker": { "kind": "checks", "failedChecks": string[] } }`. See [Hygiene selection](package-api.md#hygiene-selection-additive-1026) (additive in 0.41.0) |
| `brain hygiene list [--state open\|snoozed\|dismissed\|resolved] --json` | `{ "entries": [{ "id", "state": "open"\|"snoozed"\|"dismissed"\|"resolved", "path", "issue", "firstSeen", "lastSeen", "until", "dueAt", "resolvedBy", "resolvedOn", "sources", "severity", "fingerprint", "disposition", "invalidation" }] }`, the log as the files hold it; a field the entry does not carry is `null` (additive in 0.38.0). Additive in 0.41.0 (#1024): the `dismissed` state, `dueAt` (the instant a snooze is due, ISO), `sources` (`[]` for an entry written before sources were recorded), `severity`, `fingerprint` (as last detected), `disposition` `{ "kind": "dismissed"\|"snoozed", "on", "reason", "fingerprint" }` and `invalidation` `{ "on", "disposition", "dispositionOn", "changed": string[], "previousId" }`. `until` keeps its meaning: the snooze's day, `YYYY-MM-DD` |
| `brain hygiene dismiss <id> --expect-fingerprint <fp> [--reason <text>] [--extra <file.json>] --json` | `{ "status": "dismissed", "id", "fingerprint", "until": null, "reason", "changedFiles" }`. Reconciles, then moves the finding to `context/hygiene/dismissed.md` with the date and the fingerprint it applies to; it stays out of review until its evidence fingerprint changes. Refused with exit `1` and nothing written when the finding is not detected now or its fingerprint is not `<fp>`: `{ "status": "refused", "reason": "not-detected"\|"stale-fingerprint", "id", "expectedFingerprint", "currentFingerprint" }`. A finding reported through `reconcile --extra` is detected only when the same `--extra` file is given. A malformed argument exits `1` as a usage error (additive in 0.41.0) |
| `brain hygiene snooze <id> --until <date\|date-time> --expect-fingerprint <fp> [--reason <text>] [--extra <file.json>] --json` | As `dismiss`, with `"status": "snoozed"` and `"until"` as given, into `context/hygiene/snoozed.md`. `--until` is an ISO date (due at the start of that UTC day) or a date-time with `Z` or an offset (due at that instant), and must be in the future. The finding returns when due, or before then as soon as its fingerprint changes (additive in 0.41.0) |
| `brain travel validate --json` | `{ "validation": { "valid": boolean, "files": number, "issues": [{ "file", "level": "error", "message" }] } }` — read-only canonical format, reference and asset checks. `files` counts successfully parsed travel/trip/place documents. Exit `0` when valid, `1` on domain errors. File paths are root-relative; messages are prose |
| `brain travel migrate [--dry-run] --json` | `{ "migration": { "path", "changed": boolean, "dry_run": boolean } }` — `path` is `brain.config.ts` or `brain.config.json`; `changed` reports the proposed edit even during dry run. Reapplication reports false without a write. Refusals exit `1` with actionable stderr and no success envelope |
| `brain travel photo <files> --to <dir> [--name <descriptor>] [--date YYYY-MM-DD] [--force-date] --json` | `{ "photo": { "files": [{ "source", "output", "width", "height", "bytes", "captured_at": string \| null, "location": { "lat", "lon" } \| null, "date_source": "exif" \| "flag" \| "none" }], "errors": [{ "source", "message" }] } }` — [photo and naming contract](frontmatter.md#travel-photo-copies); exit `0` for complete success, `2` for input failures, `1` for usage/output-directory refusal without an envelope |
| `brain travel route <url\|file> --to <dir> [--name <label>] [--date YYYY-MM-DD] [--trim-start-m N] [--trim-end-m N] --json` | `{ "route": { "source_kind": "local_gpx" \| "gpx_url" \| "komoot_tour" \| "komoot_smarttour", "gpx": string, "date_source": "flag" \| "none", "distance_km": number, "ascent_m": number \| null, "altitude_min_m": number \| null, "altitude_max_m": number \| null, "shape": "loop" \| "one_way" \| "unknown", "recorded_duration_s": number \| null, "points": number, "segments": number, "trim": { "start_m": number, "end_m": number }, "warnings": string[] } }` — With `--name`, the stem is `[<date>-]<slug(label)>`; dates come only from a valid flag, never GPX timestamps. `date_source` is `flag` only when that date is applied to a requested name, otherwise `none`. Without `--name`, legacy names stay unchanged. Naming validation follows the [photo rules](frontmatter.md#travel-photo-copies). `gpx` is the new root-relative asset path. All metrics describe serialized retained geometry. Nonnegative cuts use metres, with a 1 mm minimum for a nonzero cut. Missing elevations/timestamps stay `null`; segment gaps are excluded. Exit `0` after creating a new file, `1` with stderr and no success envelope on refusal. Existing outputs and sources are preserved. Outdooractive URLs currently refuse pending written site permission (#568). [Metric and trimming semantics](../../packages/module-travel/README.md#route-import) are part of this contract; warnings are prose |
| `brain travel sync [--check] --json` | `{ "sync": { "check": boolean, "files": string[] } }` — regenerates the trip and place registry regions; `files` are the root-relative registries written (or stale, with `--check`). Exit `0` when written or current, `1` for `--check` with stale registries, and `1` with stderr and no envelope when a canonical record is invalid or a region is malformed; nothing is written then. [Registry contract](frontmatter.md#travel-registries) |
| `brain jobs scrape --json` | `{ "report": ScrapeReport }` — a module command, listed here because a hosting container runs it on a schedule (see Consumers). `sources[].status` added in 0.37.0 |

The nullable tag declaration correction (#702) is an approved pre-1.0
breaking minor: `SearchResult.tags` is `string | null`, and
`RerankCandidate.tags` is optional `string | null` (other sources may omit it).
TypeScript clients and external rerankers must handle null before using
string methods; for text display, use `result.tags ?? ""` locally. Runtime
CLI/MCP/HTTP values, injected reranker inputs and built-in Jev requests retain
their existing behavior. See [provider migration](../extending/rerankers.md#nullable-tags-migration).

`SearchResult` fields: `path`, `title`, `type`, `snippet`, `score`,
`tags` (comma-separated string or `null` when no tags),
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

<a id="auditissue"></a>

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
[decisions/audit-markers.md](../decisions/audit-markers.md)). A marker is a
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

<a id="brain-eval---json"></a>

#### `brain eval --json`

Added in 0.38.0. The query-set format and how to read the numbers are in
[evaluating-search.md](../evaluating-search.md).

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

<a id="brain-index-counters"></a>

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

<a id="embedding-eligibility-and-coverage-semantics"></a>

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
[eligibility decision](../decisions/embedding-eligibility.md).

<a id="recorded-corpus-trend-verdicts-additive-in-0400"></a>

### Recorded corpus trend verdicts (additive in 0.40.0)

`brain stats --json` and `--history --json` include `trends`, and the `stats`
entry of `brain maintain --json` carries the same object. Briefing retains
plain text and includes only warning explanations. The measurement itself
is current; the CLI enriches it with history. The library function behind it
is first-party only (#1053).

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
unsupported until reviewed. See the [trend decision](../decisions/stats-trends.md)
for provenance evidence and rejected alternatives. Old snapshots and
recording/retention rules are unchanged.

A current-value finding takes precedence for its metric; the PWA adds trend
evidence to that existing notice instead of a second warning. Complete
comparisons remain in receipts. An incomparable metric chart is replaced by
its explanation rather than connecting incompatible definitions.
Missing/stale/incomparable history produces
no alert or healthy claim there or in briefing. Malformed JSONL still follows
the reader's existing explicit-error behavior; it is never silently repaired.

<a id="stats-history-additive-in-0400"></a>

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

<a id="durable-share-and-cli-intake-additive-679"></a>

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
errors and recovery promises are specified in [HTTP API](../http-api.md#authenticated-cli-intake-additive-679).
Shares keep their existing 201 `ShareIntakeResult` envelope and interactive
confirmation flow, while the real app also records an untrusted triage item.
Unknown multipart authority fields are refused. Duplicate normalized shares
reuse the original staging result; source/principal provenance is server-owned,
immutable and separated from CLI dedup keys. Queue-backed staging is exempt
from legacy opportunistic pruning. Standalone staging retains its old lifetime.
No production autonomous dispatch is enabled by these additive surfaces.

