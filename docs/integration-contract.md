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
| brain-ui (`packages/ui-server/src/brain/client.ts`, `packages/ui-server/src/graph/reader.ts`, `packages/ui-server/src/cron/emit.ts`) | CLI `--json` commands, brain.db reads (voice keyterms; the `links` and `graph_*` tables for the knowledge graph), file paths |
| Coding-agent sessions (MCP) | MCP server tools, CLI |
| Cron on a hosting container | `brain maintain`, module cron entries (`brain jobs scrape` …) |

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
| `brain search "q" --json` | `{ "results": SearchResult[], "warnings": string[] }` — `warnings` reports degraded modes (no vectors, model mismatch, missing key). Date filters `--updated-since`, `--updated-before`, `--deadline-from`, `--deadline-to` (`YYYY-MM-DD`, inclusive; a deadline filter drops undated docs), `--sort score\|updated\|deadline` (default `score`; `updated` newest first, `deadline` earliest first with undated docs last) and `--upcoming` (= `--deadline-from <today, UTC> --sort deadline`) added in 0.38.0, additively. Stored dates are compared as their UTC day (sorts keep full timestamp precision). A stored value counts only as an ISO `YYYY-MM-DD`, optionally followed by `T` or a space, `HH:MM`, seconds, a fraction and a `Z` or `±HH:MM` offset. Anything else, `2026-02-30` and `now` included, counts as missing: it matches no bound and sorts last. With a query, a date sort picks the results by date from a candidate pool: the full-text lane's best `max(limit × 20, 500)` documents, plus the documents behind the vector lane's nearest chunks (at most that many documents, from at most 500 chunks). An invalid date or sort is a usage error (exit `1`) |
| `brain audit --json` | `{ "issues": AuditIssue[], "errors", "warnings", "infos" }` — markdown documents only (assets excluded). The three counts are the number of issues at each severity. With `--fix` the command prints fix suggestions instead, in a shape that is not part of this contract |
| `brain context "q" --max-tokens N` | assembled markdown context (text) |
| `brain read <path> [--section <heading>] [--max-tokens N]` | the document text; the flags behave as `brain_read`'s `section` and `max_tokens`, and an unknown section exits `1` (flags additive in 0.38.0) |
| `brain briefing` | briefing text (mechanical: deadlines, reviews due, silent edits — no LLM) |
| `brain index [--force] [--embeddings] --json` | `{ "total", "added", "updated", "deleted", "unchanged", "chunks", "embeddings", "assets", "graphMs", "graphNodes" }`, all numbers, each counting this run only. See [`brain index` counters](#brain-index-counters). Incremental by default, `--force` = full rebuild, `--incremental` accepted as no-op |
| `brain index --forget-cache <path> --json` | `{ "path", "forgotten" }` — `forgotten` is the number of sidecar lines removed for that document or asset (for an asset, every line for its bytes, whatever the title). Runs no index pass; the next `--embeddings` run regenerates what was forgotten. A path not in the index is a usage error (additive in 0.38.0) |
| `brain index --compact --json` | `{ "compacted", "before": { "live", "allocated" }, "after": { "live", "allocated" } }` — rebuilds `vec_chunks` from its live rows and runs `VACUUM`, reclaiming the slots deleted vectors leave behind; `before`/`after` have the shape of `brain stats` `size.db.vectorSlots`. `compacted` is `false` only when there is no vector table. Makes no provider call and runs no index pass (additive in 0.38.0) |
| `brain maintain --json` | `[{ "step", "result" }]` in run order: `registry`, `index`, `vectors`, `audit`, `tags`, `git`, `scratch`. The `registry` step (additive in 0.38.0) is `brain registry`: `ok — <written> of <indexes> table(s) rewritten`, `FAILED — …` when an index's `registry:` block is invalid. `result` is a human-readable string that starts with `FAILED` when the step failed (and the exit code is `2`); the `tags` step never fails, and reports `skipped — …` instead. The `vectors` step (additive in 0.38.0) compacts the vector table the way `brain index --compact` does, only when fewer than half its slots are live and at least one internal chunk would be freed; otherwise it reports `ok — <live> of <allocated> slots live, nothing to reclaim`, and `skipped — …` when the slots cannot be read |
| `brain registry [--check] --json` | `{ "indexes", "written", "stale", "invalid": [{ "path", "error" }] }` (additive in 0.38.0). Regenerates the registry table of every `_index.md` whose frontmatter has a `registry:` block. `indexes` counts them, valid or not. `written` lists the files rewritten. `stale` lists out-of-date indexes left as they are: all of them under `--check`, which writes nothing, and otherwise one whose file changed between being read and being written (it is regenerated on the next run). `invalid` lists indexes that cannot be generated, which are left untouched: a `registry:` block that does not validate, an index or a child that cannot be read, whose frontmatter does not parse, or whose frontmatter opens and never closes (an `_index.md` whose frontmatter does not parse counts when it has a `registry:` line, quoted or not), or malformed region markers. Exit `1` under `--check` when anything is stale or invalid, `2` without it when anything is invalid, else `0` |
| `brain list --json` | `ListedDocument[]` — a bare array, newest `updated` first, `--limit` default 20. Filters: `--type`, `--tag`, `--status`, `--relevance` |
| `brain add "<content>" --json` | `{ "action": "created"\|"appended", "path", "title", "type", "indexed", "indexError"? }` — `path` is repo-relative. `indexed` is `false` when the file was written but the reindex after it failed, and `indexError` (a string) is present only then. `appended` means the content went under a new dated heading in an existing document of the same title and type. `--smart` hands the capture to the coding agent and prints its text instead |
| `brain sync` | no JSON. With no verb, `sync` runs the `/sync` skill through the configured coding agent and prints the agent's final text on stdout, whatever the output mode; exit `1` when no agent runner is available. The verb is the first positional argument, so output-mode flags may come before it: `brain sync --json` still runs the agent, and `brain sync --json assess` is `assess --json`. An unknown flag exits `1` (`Unknown flag: --x`). The mechanical verbs (`assess`, `group`, `pull`, `conflicts`, `push`, `post-sync`) follow the usual output mode — JSON when stdout is not a TTY or with `--json`, otherwise command-specific human-readable text — and their shapes, which exist for that skill to drive, are not part of this contract |
| `brain module list --json` | `{ "enabled": [{ "name", "key", "description", "types", "commands", "cron": [{ "name", "schedule", "command" }] }], "available": [{ "key", "description", "enabled": false }] }` — `key` is the module's `brain.config` key (a package name or `./path`). `types` and `commands` are the type names and CLI words it contributes. `description` comes from the module's `package.json` and is `null` when it has none. `available` lists `@schlessera/brain-module-*` packages the brain's `package.json` declares but its config does not enable; `description` is `null` there when the package is not installed. `cron` is shape-constrained (see [Guarantees](#guarantees-consumers-may-rely-on)) |
| `brain --version` | text: the core package's SemVer version and a newline, nothing else (`0.37.0`). `-v` is the same. Only as the first argument |
| `brain doctor --json` | `{ "checks": [{ "id", "status": "pass"\|"warn"\|"fail", "detail", "fix"? }] }` (new in brain-kit). Check ids other than `instructions-weight` are not part of this contract, and `detail` is prose. `instructions-weight` (added in 0.38.0, additively) estimates the tokens always loaded into a session (`CLAUDE.md` with its in-brain `@` imports, `AGENTS.md`, model-invocable skill descriptions), and is `warn` above the optional `brain.config` key `instructions.maxTokens` (default `8000`) |
| `brain init --check` | `{ "bun": { "version", "ok" }, "git": { "repo" }, "hooksPath": { "set", "value" }, "config": { "exists", "valid", "initialized", "path", "error"? }, "contentDirs": { "present", "missing" }, "keys": { "GEMINI_API_KEY", "ANTHROPIC_API_KEY" } }` (new in brain-kit). `bun.version` is `null` when not running under Bun. `git.repo` says whether the root is inside a git work tree. `hooksPath.value` is git's `core.hooksPath`, `null` when unset. `config.path` is `null` when there is no config, and `error` is present only when the config failed to load (`valid: false`). `initialized` is true only when the config declares something (profile, taxonomy, modules, embeddings), so a brain holding the template's empty starter config reads as `exists: true, initialized: false` (added in 0.37.0). `contentDirs` splits the core types' directories into those that exist and those that do not. Each `keys` entry is a boolean — whether that variable is set — never the key |
| `brain okf export --json` | `{ "outDir", "filesExported", "assetsCopied", "linksConverted", "linksDegraded", "degradedLinks", "indexFilesGenerated", "topLevelDirectories", "warnings" }` |
| `brain okf check [dir] --json` | `{ "directory", "ok", "filesChecked", "errors", "warnings", "issues": [{ "severity", "path", "message" }] }`; exit 1 when `errors > 0` |
| `brain scratch clean\|prune --json` | `{ "action": "clean"\|"prune", "removed": [{ "path", "bytes", "reason": "age"\|"size"\|"clean" }], "failed": [{ "path", "reason" }], "bytes", "files" }` — `path` is repo-relative; `failed` lists files the OS refused to remove (they are still there, and the exit code is `2`); `bytes` and `files` are what is left in the scratch area afterwards, those included (additive in 0.38.0) |
| `brain graph stats --json` | `{ "computedAt", "root", "nodes", "edges", "brokenLinks", "components", "reachable", "layoutSkipped", "algo", "communities" }` |
| `brain graph compute [--root <path>] --json` | `{ "nodes", "edges", "brokenLinks", "components", "communities", "root", "reachable", "layoutSkipped", "durationMs" }` |
| `brain graph export --mode clusters\|discovery\|local\|maintenance --json` | `{ "nodes", "edges", "truncated" }`, except `maintenance` → `{ "staleDays", "root", "orphans", "unreachable", "brokenLinks", "stale" }` |
| `brain stats --json` | `{ "documents", "byType", "byStatus", "byRelevance", "tags", "links", "brokenLinks", "chunks", "embeddings", "health", "size" }` — `health` and `size` added in 0.37.0, additively. **Breaking in 0.37.0:** `embeddings` is retyped from `number` to `number \| null` — `null` when a vector table exists but could not be counted, `0` when there is none. It also changed value: it reports the real vector count on an embedded brain, where before it read `0` on every brain. Every other earlier field keeps its name and type |
| `brain eval [--set <file>] [--mode fts\|vector\|hybrid\|all] --json` | `{ "schema_version", "meta", "rows", "per_query", "warnings" }` — retrieval scores for a query set against this brain's index (additive in 0.38.0). See [`brain eval --json`](#brain-eval---json). Exit `2`, with nothing on stdout, when a validity gate refuses the run. With `--lint` (additive in 0.38.0): `{ "schema_version", "meta": { "set", "set_sha256", "queries" }, "warnings" }`, where `warnings` lists `paraphrase` queries that share a content word with an expected document's title. It does not score, never opens `brain.db`, exits `0` with or without findings, and exits `2` naming the line on a malformed set |
| `brain tags --json` | `{ "tags", "documents", "variantGroups": [{ "canonical", "members": [{ "tag", "count" }] }], "redundant": [{ "path", "tag", "repeats": "type"\|"directory" }], "aliasHits": [{ "path", "tag", "canonical" }], "outOfVocabulary": [{ "tag", "count" }] \| null }` (additive in 0.38.0). Read-only. `tags` counts distinct tags and `documents` the markdown documents carrying one, both read from frontmatter, not the index. `members` is never empty, most used first, and includes `canonical`. `redundant` is `[]` under `taxonomy.tags.redundant: "off"`. `outOfVocabulary` is `null` when no `taxonomy.tags.vocabulary` is set, most used first otherwise. `path` is repo-relative |
| `brain tags --apply [--dry-run] [--only <old>] [--groups] [--redundant] --json` | `{ "files": [{ "path", "from": string[], "to": string[] }], "skipped": [{ "path", "reason" }], "warnings": string[] }`. `files` lists every document whose tags changed (or would, under `--dry-run`), in path order. `skipped` lists documents left alone: frontmatter that does not parse, a `tags:` entry the rewrite does not edit, a tag on an alias cycle, a file edited while the command ran (`"changed during apply"`), or a rewrite that would not read back as the planned tags. A `reason` starting `failed:` is a read or write error; the run goes on, and the command exits `2` after indexing and accepting the files it did rewrite. An index that cannot be opened stops the run before any file is rewritten: `files` is empty, `warnings` says why, and the exit code is `2`. Only the `tags:` entries change, on the raw text. `updated` is not bumped. The touched files are reindexed, and a file's mtime is accepted only when the index read exactly the bytes the rewrite wrote; `warnings` names each one that was not. Explicit aliases take precedence over variant groups, and a second run reports no `files`. `reason` and `warnings` are prose (additive in 0.38.0) |
| `brain hygiene reconcile [--extra <file.json>] [--fixed <file.json>] [--dry-run] --json` | `{ "opened", "reopened", "resolved", "stillOpen", "snoozed", "changedFiles": string[], "detected": [{ "id", "category", "path", "message" }], "autoFixed", "failedChecks": string[] }`. The counts are this run's transitions: `opened` new issues, `reopened` issues back from resolved or an expired snooze, `resolved` issues no longer detected, `stillOpen` open issues still detected (or kept open while a check could not run), and `snoozed` the entries left snoozed. `changedFiles` lists the files under `context/hygiene/` written (or, with `--dry-run`, that would be); it is empty on a run that changes nothing. `detected` is every issue found this run, with its stable ID `{category}-{shortpath}-{hash4}` (hash4: SHA-1 over `{category}\|{path}\|{evidence}`). `--extra` is a JSON array of `{ "category", "path", "evidence", "message" }`, and `--fixed` a JSON array of `{ "path", "fix" }`, the auto-fixes to record in `last-run.md` (`autoFixed` counts them); a malformed one exits `1` and writes nothing. `failedChecks` names each check that could not run: a module whose hygiene check threw, or a core check that could not read its input (`fact-drift`, `tag-noise`); while any is named, no entry is resolved unless it was detected again. `--dry-run` writes no log file (the index is still refreshed). A log file that cannot be parsed safely (broken frontmatter, a section mixing entries with other text), or that changes while the command runs, exits `2` without writing it (a save in the instant between the last check and the rename can still be lost; there is no lock) (additive in 0.38.0) |
| `brain hygiene list [--state open\|snoozed\|resolved] --json` | `{ "entries": [{ "id", "state": "open"\|"snoozed"\|"resolved", "path", "issue", "firstSeen", "lastSeen", "until", "resolvedBy", "resolvedOn" }] }`, the log as the files hold it; a field the entry does not carry is `null` (additive in 0.38.0) |
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

`AuditIssue` fields: `path`, a repo-relative document path or a
parenthesised sentinel for an issue that belongs to no one file — `"(corpus)"`
for the corpus-wide `tag-noise` check, `"(module)"` for a failing module check
— so a consumer must not open a `path` that starts with `(`; `severity`, one of `"error"`,
`"warning"`, `"info"`; `category`, a string naming the check; `message`; and
`suggestion`, a string present only when the check has one. Core categories are
`staleness`, `propagation`, `index-lag`, `stale-draft`, `tag-noise`, `todo`,
`verify`, `type-mismatch`, `orphan`, and, added in 0.38.0 additively,
`budget`, `review-overdue`, `past-date`, `fact-drift`, `repeated-text`,
`index-stale` and `duplicate-title`. `duplicate-title` is a non-archived
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
passed `next_review`, or a lapsed `canonicalPolicy.<key>.reviewDays` cadence.
`past-date` is a line in a canonical document with a policy that names an
earlier `YYYY-MM-DD` day, with the line number in `message`. All three are
`warning`. `taxonomy.canonicalPolicy` is an optional `brain.config` key,
defaulting to `{ currentFocus: { maxTokens: 1000 } }`. Modules add their own, and a failing
module check reports as `module-hygiene` with `path: "(module)"`, so treat the
set as open.

#### `brain eval --json`

Added in 0.38.0. The query-set format and how to read the numbers are in
[evaluating-search.md](evaluating-search.md).

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
    { "mode": "fts", "id": "dob", "class": "alias", "q": "the Dobsonian",
      "expected": ["studies/telescope-setup.md"],
      "rank": 2,                 // of the first expected path in the pool; null when absent
      "hit_at": { "1": false, "3": true, "10": true },  // null for no-answer
      "rr": 0.5,                 // 1/rank, 0 below rank 10; null for no-answer
      "top1_score": 4.02,        // null when the search returned nothing
      "top": ["studies/astronomy/overview.md", "studies/telescope-setup.md"],  // up to max(k) paths
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
    { "budget": 1000, "id": "dob", "class": "alias",
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
(`serverInstructions`, `packages/core/src/mcp-server.ts:75-87`). Tool descriptions are descriptive in the
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
| `brain_search` | `query`, `type?`, `tag?`, `relevance?`, `mode?` (`fts`\|`vector`\|`hybrid`, default `hybrid`), `rerank?` (`none`\|`heuristic`, default `heuristic`), `include_archived?` (default `false`), `assets_only?` (default `false`), `limit?` (default `10`), `updated_since?`, `updated_before?`, `deadline_from?`, `deadline_to?` (`YYYY-MM-DD`, inclusive), `sort?` (`score`\|`updated`\|`deadline`, default `score`), `upcoming?` (default `false`) — the six date inputs added in 0.38.0, additively; an invalid date is a tool error |
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
key; its tool names are equally stable. `ask_user`, `get_current_location`
and `request_image_mask` bridge to the connected browser. `query_activity`
(read-only) reads the host's activity record — scopes `running` | `recent` |
`run` | `rollups` | `inbox`; results are wrapped in a data-only delimiter
(nonce-suffixed per call) because they can contain free text from past runs.
`show_block` (side-effect free, always registered) renders one of the kit's
answer blocks inline in the answer, or the follow-ups the model offers under
it (`suggestions`); it validates its argument and echoes it.
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
| `show_block` | `{ block }`, the validated input echoed | the block, inline at the call's position in the answer; `suggestions` alone is drawn under the answer instead |

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
| `suggestions` (0.39.0) | `label?` (1-24), `items[1..2]{label (4-80, trimmed, one line), icon?}` | the app's closing row, from `SuggestionChips`' data minus `tone` |

Layout knobs the kit components take (`labelWidth`, `barWidth`, `height`,
`timeWidth`, …) are not part of the contract: the surface decides them.
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

- Check `index_metadata` first: `schema_version` (currently **14**),
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
  run adds the aliases.
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
raises more than one approval. The payload additionally carries `channel`
(`card` | `voice`, additive in 0.37.0) when the `tool_approval` / `tool_denial`
frame named the channel the decision was made on; absent means the client did
not say, and such a decision is stored exactly as before. A `tool_approval`
attributed to `voice` is refused — the request stays pending, nothing is
recorded, and the `tool_approval_request` is sent again to the connection that
replied, so its next answer is correlated — because the voice channel may deny and never grant
([decisions/voice-permission.md](decisions/voice-permission.md)), so a
voice-attributed grant in the record is by construction a bug.
An answered `ask_user` interaction appends an `ask_user_response` event carrying
the responder's `principalId`.
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

## File-layer contracts

- Markdown files: YAML frontmatter per `CONTRACT.md` (shipped in the package);
  `deadline` / `next_review` are ISO dates queried by briefing features.
- Optional `generated_from` (additive in 0.38.0): a non-empty string, either a
  repo-relative path to the document's source or a free-form tool name. It
  marks the document as produced by a tool or an agent pass, not written by
  hand. `brain validate` reports any other value as an error. `brain audit`
  reports a `propagation` issue when it names a markdown document updated
  after this one. The heuristic reranker weights a generated document ×0.85.
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

These nine seams are `@experimental` until 1.0: breaking changes are
minor-version events, announced in the CHANGELOG. Each declaration carries its
own `@experimental` tag. So do eight of the types they are made of:
`BackendBridge`, `BackendCapabilities`, `StartTurnRequest`, `RendererPack`,
`SpeechSession`, `AsrClientOptions`, `AdapterResult` and `ScrapeContext`.
Whether the other types in a seam's signature belong in the frozen set is open
in [#343](https://github.com/schlessera/brain-kit/issues/343).
[extending/README.md](extending/README.md#the-seams) says what each one swaps.

| Interface | Imported from |
|-----------|---------------|
| `EmbeddingProvider` | `@schlessera/brain` |
| `CompletionProvider` | `@schlessera/brain` |
| `AgentRunner` | `@schlessera/brain` |
| `SkillEmitter` | `@schlessera/brain` |
| `AgentBackend` | `@schlessera/brain-ui-sdk/server` |
| `SpeechProvider` | `@schlessera/brain-ui-sdk/server` |
| `AsrClient` | `@schlessera/brain-ui-sdk/client` |
| `ToolRenderer` | `@schlessera/brain-ui-sdk/client` |
| `SiteAdapter` | `@schlessera/brain-scrape` |

`tests/seam-list.test.ts` fails when this table, the one in
extending/README.md and the tags in the source disagree.

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
