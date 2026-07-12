# CLI Reference — `brain`

Runs under Bun. Installed as the `brain` bin by `@brainform/core`; `brain setup`
symlinks it into `~/.local/bin`. Output is JSON when stdout is not a TTY;
`--json` / `--human` force either mode. Exit codes: `0` success, `1` usage
error, `2` internal failure. The `--json` envelope shapes marked ⚖ are part of
the [integration contract](integration-contract.md).

```
Usage: brain <command> [args] [flags]
```

## Content commands

| Command | Does | Notes |
|---|---|---|
| `add "text"` | Quick capture: classify (heuristics + your classifier hints), title, tag, file into the taxonomy, reindex | content titled exactly after an existing doc of an `appendMatch` type appends to it; `--type/--title/--path/--tags` override; `--smart` routes through the configured agent runner |
| `read <path>` | Print a document | |
| `list` | List/browse documents | `--type/--tag/--status`, `--json` = bare array |
| `process` | Assimilate an inbox note into proper brain content | uses the configured completions provider; degrades keyless |
| `archive <path>` | Set `status: archived`, move per convention, reindex | |

## Search + context

| Command | Does | Notes |
|---|---|---|
| `search "q"` ⚖ | Hybrid FTS + vector search | `{results, warnings}`; `--mode fts\|vector\|hybrid`, `--rerank`, `--type/--tag/--relevance/--status/--archived/--assets/--limit`; degrades to FTS with a warning when embeddings are unavailable |
| `context "q"` ⚖ | Assemble a markdown context block for agent consumption | `--max-tokens N`; includes identity/current-focus canonicals when configured |
| `stats` | Corpus statistics | |

## Index + quality

| Command | Does | Notes |
|---|---|---|
| `index` ⚖ | Update the search index (incremental by default) | `--force` full rebuild; `--embeddings` runs the embedding pass; a changed embedding provider requires `--embeddings --force` (prints a cost warning, never silently re-embeds) |
| `validate` ⚖ | Config, frontmatter, wiki-link, and index-drift validation | `{ok, issues, errors, warnings}`; exit 1 on error-level issues |
| `audit` ⚖ | Staleness/propagation/index-lag/orphan/type-mismatch/marker audit | `{issues, errors, warnings, infos}`; module hygiene checks appended |
| `accept-mtime` | Baseline file mtimes so silent-edit detection stops flagging mechanical edits | |
| `maintain` | Routine maintenance sequence | exit 2 if any step failed |
| `briefing` ⚖ | Mechanical daily briefing: deadlines, reviews due, silent edits | no LLM involved; the `/whatsup` skill layers interpretation on top |

## Onboarding + health

| Command | Does | Notes |
|---|---|---|
| `setup` | Idempotent: install git hooks (`.githooks/` + `core.hooksPath`), sync skills, bin links | run by the template's `prepare` script |
| `init --check` | Preflight JSON: bun/git/hooks/config/content dirs/key presence (booleans, never values) | consumed by `/brain-init` Stage 0 |
| `init --default` | Non-interactive minimal brain: `brain.config.json` (dependency-free), core dirs, root `_index.md`, empty sidecars, index + validate | the keyless Tier-0 path; idempotent |
| `doctor` ⚖ | Health battery: runtime, git-hooks, symlinks, config, db, embeddings, mcp, deps, version, privacy (public-remote = loud fail), macOS sqlite-vec | `{checks:[{id,status,detail,fix?}]}`; `--fix` applies auto-fixables |
| `import --stamp <dir>` | Mechanical frontmatter stamping for imports (type note, status draft, title from H1/filename, dates from mtime) | skips files that already have frontmatter |

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

Module packages add ONE namespaced top-level command each (e.g. `brain jobs …`,
`brain finance …`) — see [modules.md](modules.md).

See also: [integration-contract.md](integration-contract.md) ·
[quickstart.md](quickstart.md) · [concepts.md](concepts.md)
