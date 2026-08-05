# brain-kit Integration Contract

The machine-readable surface other systems (primarily **brain-ui**) may depend
on. Anything NOT listed here is an internal implementation detail and can
change without notice. Contract changes require a `CONTRACT:` commit prefix, a
same-commit update of this file, and a major version bump of `@schlessera/brain-*`.

Lineage: this is the public successor of the private brain's
`scripts/INTEGRATION.md`; shapes are unchanged unless marked.

## Consumers

| Consumer | Surfaces used |
|----------|---------------|
| brain-ui (`server/src/brain/client.ts`) | CLI `--json` commands, brain.db reads (voice keyterms), file paths |
| Coding-agent sessions (MCP) | MCP server tools, CLI |
| Cron on a hosting container | `brain maintain`, module cron entries (`brain jobs scrape` …) |

## CLI conventions

- Bin name: `brain` (stable). Runs under Bun.
- Output mode: JSON when stdout is not a TTY; force with `--json` / `--human`.
- Exit codes: `0` success · `1` usage error · `2` internal failure
  (`maintain` exits `2` if any step failed).
- Boolean flags never consume the following argument.

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

## brain.db (direct SQL reads)

Prefer the CLI/MCP. If reading directly:

- Check `index_metadata` first: `schema_version` (currently **7**),
  `embedding_model`, `embedding_dimensions`, `vec_schema`.
- Semi-stable tables: `documents` (path, title, type, status, relevance,
  content, deadline, next_review, …), `chunks`, `tags`/`document_tags`,
  `links`. Columns are only ever ADDED within a schema_version line.
- `vec_chunks` is a sqlite-vec virtual table — unreadable without loading the
  extension; do not depend on it externally. Its dimension follows the
  configured embedding provider (default 1536).
- Open read-only. Writers must set `PRAGMA busy_timeout` (core uses 5000ms).
- **Do not write to brain.db from outside** — markdown is the source of truth.

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
