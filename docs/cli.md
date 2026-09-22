# CLI Reference — `brain`

Runs under Bun. Installed as the `brain` bin by `@schlessera/brain`; `brain setup`
symlinks it into `~/.local/bin`. Output is JSON when stdout is not a TTY;
`--json` / `--human` force either mode. Exit codes: `0` success, `1` usage
error, `2` internal failure. The `--json` envelope shapes marked ⚖ are part of
the [integration contract](integration-contract.md). `brain --version` prints
the installed `@schlessera/brain` version.

```
Usage: brain <command> [args] [flags]
```

## Content commands

| Command | Does | Notes |
|---|---|---|
| `add "text"` | Quick capture: classify (heuristics + your classifier hints), title, tag, file into the taxonomy, reindex | content titled exactly after an existing doc of an `appendMatch` type appends to it; `--type/--title/--tags` override; `--smart` routes through the configured agent runner |
| `read <path>` | Print a document | |
| `list` | List/browse documents | `--type/--tag/--status`, `--json` = bare array |
| `process` | Assimilate an inbox note into proper brain content | uses the configured completions provider; degrades keyless |
| `archive <path>` | Set `status: archived`, move per convention, reindex | Refuses an occupied archive destination before modifying the source |
| `render <path\|->` | Render a document to PDF, PNG, or standalone HTML | `--format pdf\|png\|html` (default pdf), `--out`, `--as markdown\|html`, `--title`, `--width`, repeatable `--allow-host`; frontmatter is stripped |

### Rendering

`brain render` wraps content in the same document shell the UI's `/api/render`
uses ([`@schlessera/brain-render-template`](../packages/render-template)), so a
page shared from the app and a PDF produced here are identical for identical
input. The output path must stay inside the brain root, and defaults to the
input path with the format's extension.

PDF and PNG drive a headless browser through the optional
[`@schlessera/brain-render-puppeteer`](../packages/ui-render-puppeteer); install
it in the brain repo (`bun add @schlessera/brain-render-puppeteer`) and have
Chrome available. Without it the command explains what is missing and
`--format html` still works.

The page resolves no hostname by default, so remote images become a visible
`[alt — not embedded]` placeholder. `--allow-host <host>` opens specific image
hosts; `data:` URIs always render.

## Search + context

| Command | Does | Notes |
|---|---|---|
| `search "q"` ⚖ | Hybrid FTS + vector search | `{results, warnings}`; `--mode fts\|vector\|hybrid`, `--rerank`, `--type/--tag/--relevance/--status/--archived/--assets/--limit`; degrades to FTS with a warning when embeddings are unavailable |
| `context "q"` ⚖ | Assemble a markdown context block for agent consumption | `--max-tokens N`; includes identity/current-focus canonicals when configured |
| `stats` ⚖ | Corpus counts, health figures and sizes | carries `health` (broken-link rate, embedding coverage, stale/orphan/untagged, the thresholds in force) and `size` (corpus bytes+files, `brain.db` bytes and row counts, free space); stale and orphan mean what `audit` means; an unmeasurable figure is `null`, never `0`; warn levels come from the [`stats` config block](configuration.md#stats). Human output prints health above the inventory and caps each breakdown at the top 5 by count plus a `+N more` remainder; `--all` prints every row. `--all` is human-only — `--json` always carries the full, uncapped breakdowns |

## Index + quality

| Command | Does | Notes |
|---|---|---|
| `index` ⚖ | Update the search index (incremental by default) | `--force` full rebuild; `--embeddings` runs the embedding pass; a changed embedding provider requires `--embeddings --force` (prints a cost warning, never silently re-embeds) |
| `validate` ⚖ | Config, frontmatter, wiki-link, and index-drift validation | `{ok, issues, errors, warnings}`; exit 1 on error-level issues |
| `audit` ⚖ | Staleness/propagation/index-lag/orphan/type-mismatch/marker audit | `{issues, errors, warnings, infos}`; module hygiene checks appended |
| `accept-mtime` | Baseline file mtimes so silent-edit detection stops flagging mechanical edits | |
| `maintain` | Routine maintenance sequence | exit 2 if any step failed |
| `briefing` ⚖ | Mechanical daily briefing: deadlines, reviews due, silent edits | no LLM involved; the `/whatsup` skill layers interpretation on top |

## Graph

| Command | Does | Notes |
|---|---|---|
| `graph compute` ⚖ | Rebuild the derived wiki-link graph tables (metrics, communities, root distances, layout) from the index | `--root <path>` overrides the precomputed root; an override that resolves to nothing is a usage error, not an empty graph |
| `graph export --mode <mode>` ⚖ | Dump one graph view as `{nodes, edges, truncated}` | modes: `clusters` (`--community <n>`, `--no-isolates`), `local` (`--center <path>` required, `--depth 1-3`, `--direction in\|out\|both`), `discovery` (`--root`, `--depth 1-8`, `--direction`), `maintenance` (`--stale-days <n>`; returns orphans/unreachable/broken-links/stale instead of nodes+edges) |
| `graph stats` ⚖ | Node/edge/component counts, communities, root, computed-at | reports "not computed yet" until the first rebuild |

Index warnings (including skipped files and failed enrichment) go to stderr
even with `--json`; stdout retains the existing stats object. A successful
exit can represent a partial index, so automation should retain stderr.

Only one `index --embeddings` run can operate on a database at a time. A
second exits with a retry message before indexing or making paid calls. The
lock releases automatically if the process crashes; its empty
`brain.db.embedding-lock.db` sidecar is disposable and covered by the
template's `brain.db*` ignore rule. Plain `index` runs remain available during
embedding calls. If they change a chunk, its pending embedding is discarded
and a later `index --embeddings` run backfills it.

The graph tables are a derived cache, rebuilt wholesale when inputs change —
unchanged index runs preserve cached metrics and layout. The input fingerprint
includes document metadata, tags, resolved links, the resolved entry root, and
algorithm settings. `--force` always rebuilds. The tables stay empty until the
first index run on schema v8, and `graph compute` exists to rebuild them
without reindexing. The `--json` payloads are listed in
the [integration contract](integration-contract.md).

## OKF interchange

| Command | Does | Notes |
|---|---|---|
| `okf export` ⚖ | Build a deterministic Open Knowledge Format v0.1 bundle from the indexed content scope | defaults to `okf-dist/`; `--include <dir>` and `--exclude <dir>` are repeatable; `--no-assets` omits images/PDFs; review `topLevelDirectories` before sharing |
| `okf check [dir]` ⚖ | Check any OKF bundle for concept and reserved-file conformance | defaults to `okf-dist/`; broken internal links are warnings; exits 1 on conformance errors |

The export output directory must be inside the brain root and excluded from indexing.
A nonempty output directory must carry the exporter's `.brain-okf-export`
ownership marker. Existing bundles created before this safeguard need a new,
empty destination (or you can move the old bundle aside). Do not add a marker
to a directory containing other data: subsequent exports replace its contents.
Repository infrastructure such as `.git`, `.agents`, `scripts`, and `workspaces`
is always rejected, even when excluded from indexing.

`okf-dist` is excluded by default. Wiki-links are resolved against only the exported
file set, so links into excluded domains degrade to plain display text rather than
leaking paths.

## Onboarding + health

| Command | Does | Notes |
|---|---|---|
| `setup` | Idempotent: install git hooks (`.githooks/` + `core.hooksPath`), sync skills, bin links | run explicitly with `bun run setup` in the template |
| `init --check` | Preflight JSON: bun/git/hooks/config/content dirs/key presence (booleans, never values) | consumed by `/brain-init` Stage 0 |
| `init --default` | Non-interactive minimal brain: `brain.config.json` (dependency-free), core dirs, root `_index.md`, empty sidecars, index + validate | the keyless Tier-0 path; idempotent |
| `doctor` ⚖ | Health battery: runtime, git-hooks, symlinks, config, db, embeddings, mcp, deps, version, privacy (public-remote = loud fail), macOS sqlite-vec | `{checks:[{id,status,detail,fix?}]}`; `--fix` applies auto-fixables |
| `import --stamp <dir>` | Mechanical frontmatter stamping for imports (type note, status draft, title from H1/filename, dates from mtime) | skips files that already have frontmatter |
| `mcp` | Start the stdio MCP server in-process | register this command with an MCP client; see [mcp.md](mcp.md) |

## Skills, modules, config

| Command | Does | Notes |
|---|---|---|
| `skills sync` | Materialize core + module skills into `.agents/skills/`, run emitters | extra emitters via config `skills.emitters` |
| `skills lint` | Lint all skills (agent-agnostic rules) | unparseable SKILL.md frontmatter = error; exit 1 on errors |
| `module list` | Enabled + available modules with one-liners | |
| `module lint <name>` | Validate a module: manifest, skills, collisions, configSchema | quality gate for `/new-module` |
| `config check` | Validate config, print effective taxonomy summary | |
| `config get <dotted.path>` | Read a resolved config value | lets skills query module config |
| `sync <verb>` | Mechanical git-sync verbs: `assess`, `group`, `pull`, `conflicts`, `push`, `post-sync` | orchestrated by the `/sync` skill; grouping is taxonomy-driven |

Sync assessment and grouping preserve literal Git paths, including Unicode,
newlines, and rename destinations. Untracked directories are expanded so
sensitive files inside them receive their own classification.

Module packages add ONE namespaced top-level command each (`brain jobs …`,
`brain finance …`, `brain image …`) — see [modules.md](modules.md).

See also: [integration-contract.md](integration-contract.md) ·
[quickstart.md](quickstart.md) · [concepts.md](concepts.md)

### Capture collisions and search budgets

Quick capture appends only to a confirmed title match of an `appendMatch` type,
with no explicit type override. Otherwise it creates a new document: occupied
filenames receive numeric suffixes (`c.md`, `c-2.md`, …), Unicode titles retain
their letters, and titles made entirely of punctuation use `untitled`.
An explicit title override must also match before capture appends.

Hybrid search waits up to three seconds for query embedding, then returns
keyword results with a degradation warning. Vector-only search returns an empty
result and warning on timeout. Vector retrieval widens its candidate window
when duplicate chunks or filters leave too few documents, up to 500 chunks;
that bound can still produce fewer documents than `--limit` requests.
