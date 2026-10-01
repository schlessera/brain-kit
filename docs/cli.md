# CLI Reference — `brain`

Runs under Bun. Installed as the `brain` bin by `@schlessera/brain`; `brain setup`
symlinks it into `~/.local/bin`. Output is JSON when stdout is not a TTY;
`--json` / `--human` force either mode. Default exit codes: `0` success, `1`
usage error, `2` internal failure. Validation, sync and evaluation have the
additional outcomes described below. The `--json` envelope shapes marked ⚖ are part of
the [integration contract](integration-contract.md). `brain --version` prints
the installed `@schlessera/brain` version.

This reference follows `main`. Check your installed version and its changelog
before using additions marked 0.40.0; those are absent from the published
0.39.0 packages. The [quickstart](quickstart.md) uses the published template.

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
| `render <path\|->` | Render a document to PDF, PNG, or standalone HTML | `--format pdf\|png\|html` (default pdf), `--out`, `--scratch` (into `.brain/scratch/`, the default for stdin), `--as markdown\|html`, `--title`, `--no-running-title`, `--width`, repeatable `--allow-host`; frontmatter is stripped; `{input, output, format, bytes, pages, title, allowHosts, warnings}` (`pages` is `null` unless PDF). `--kind list`, `--kind <kind> --scaffold` and `--blocks [name…]` print the document kinds, a kind's skeleton and the component snippets instead of rendering |

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

The shell's stylesheet lays a PDF out as full-bleed A4, with the title and
"2 / 5" in the footer from page 2, and styles plain markdown into a finished
document. A designed document is composed from its components, never from CSS:
`brain render --kind list` names the kinds (itinerary, brief, report, how-to,
comparison, invoice, invitation, note), `--kind <kind> --scaffold` prints a
kind's skeleton to fill in, and `--blocks` prints every component's snippet.
The three print text and take no input path; `--kind list` follows the usual
JSON rule. A complete HTML document is not wrapped: the stylesheet is injected
into its `<head>` under the author's own rules, and `<meta name="brain-render"
content="bare">` opts out.

Every render is checked for what would come out wrong: a component class that
does not exist, an opener that is not first, a remote image or a stylesheet
that cannot load, a script, a placeholder left from a skeleton, a link to `#`.
The findings are printed and listed in `warnings`; `pages` counts the PDF's
pages. The `generate-pdf` skill treats zero warnings as done.

To use `chrome-headless-shell`, point `PUPPETEER_EXECUTABLE_PATH` at its
executable. Measure rendering time on your own documents and machine.

## Search + context

| Command | Does | Notes |
|---|---|---|
| `search "q"` ⚖ | Hybrid FTS + vector search | `{results, warnings}`; `--mode fts\|vector\|hybrid`, `--rerank none\|heuristic\|jev` (default: local heuristic; configured provider when `reranker.enabled` is true and available), `--rerank-dry-run` (print the reranker's request to stderr, send nothing), `--chunks` (each result's matching chunks), `--type/--tag/--relevance/--status/--include-archived/--assets-only/--limit`; date filters `--updated-since/--updated-before/--deadline-from/--deadline-to <YYYY-MM-DD>` (inclusive), `--sort score\|updated\|deadline`, `--upcoming` (= `--deadline-from <today> --sort deadline`); degrades to FTS with a warning when embeddings are unavailable, and to the retrieval order with a warning when the reranker does not run |
| `context "q"` ⚖ | Assemble a markdown context block for agent consumption | `--max-tokens N`; includes identity/current-focus canonicals when configured, first as their summary and lead, so a larger budget never holds fewer search hits; each search hit is placed as its snippet, then, with the budget left after every hit is placed, grown in rank order into the whole `##` section its best-matching chunk comes from, read from the file (a hit takes at most 40% of the budget; a longer section is cut at a block boundary; one with no block that fits stays a snippet); budget left after that grows identity and focus towards their whole body, and what is left after that goes to a `### Related` list of the top hits' neighbours (directory `_index.md`, then linked docs), summary lines only |
| `eval` ⚖ | Score a retrieval query set against this brain's index: hit@k, MRR@10 and an oracle row, overall and per class | `--set <file>` (default `evals/retrieval.jsonl`), `--mode fts\|vector\|hybrid\|all` (default hybrid), `--rerank none\|heuristic\|jev` (`meta.reranker` names the judgment reranker; an explicit `jev` flag or environment request while disabled or unavailable refuses the run), `--k 1,3,10` (at most 1000), `--now <ISO date>` (when the set's header does not pin one; selectors and recency use it), `--context` with `--budgets 1000,4000,8000` (also run each query through `brain context` at each budget: answer present, budget used), `--out <file>` (inside the brain; paths resolve against the brain root), `--strict` (refuse when an indexed document quotes the set's queries; without it they are `warnings`), `--lint` (validate the set and report `paraphrase` queries that share a word with an expected document's title, without scoring or the index), `--baseline <file>` (compare per query against a stored run: lost/gained per k and class; `--max-net-loss 2`, `--must-pass <classes>`, `--allow-set-change`; exit `1` when the gate fails, `3` when not comparable), `--redact` (no query text or paths); exits `2` on a usage error (unlike other commands, so `1` is only the gate) and without a score when a validity gate fails (missing set or path, a selector that selects nothing, stale index, a degraded lane). See [evaluating-search.md](evaluating-search.md) |
| `stats` ⚖ | Corpus counts, health figures and sizes | carries `health` (broken-link rate, embedding coverage, stale/orphan/untagged, the thresholds in force) and `size` (corpus bytes+files, `brain.db` bytes and row counts, free space); stale and orphan mean what `audit` means; an unmeasurable figure is `null`, never `0` — `embeddings` included, which is `null` when a vector table exists but could not be counted (sqlite-vec did not load) and `0` when there is no vector table; warn levels come from the [`stats` config block](configuration.md#stats). Human output prints health above the inventory and caps each breakdown at the top 5 by count plus a `+N more` remainder; `--all` prints every row. `--all` is human-only — `--json` always carries the full, uncapped breakdowns |

## Index + quality

| Command | Does | Notes |
|---|---|---|
| `index` ⚖ | Update the search index (incremental by default) | `--force` full rebuild (with `--embeddings`, a chunk whose embedding text is unchanged reuses its vector when the provider is the same); `--embeddings` runs the embedding pass and embeds only chunks without a vector; `--on-commit` (what the post-commit hook passes) adds that pass only when `hooks.embedOnCommit` is on and a provider is configured. That pass embeds every chunk without a vector, so the first commit after opting in pays for the backlog. If another embeddings run holds the lock, it falls back to the keyword pass, so an edit re-embeds only the chunks whose text changed; a changed embedding provider requires `--embeddings --force` (prints a cost warning, never silently re-embeds); `--forget-cache <path>` discards one document's or asset's cached contexts or description so the next `--embeddings` run generates them again (`{path, forgotten}`); `--compact` rebuilds the vector table from its live rows and `VACUUM`s, reclaiming the slots deleted vectors leave (no provider call, `{compacted, before, after}`) |
| `validate` ⚖ | Config, frontmatter, wiki-link, and index-drift validation | `{ok, issues, errors, warnings}`; exit 1 on error-level issues |
| `audit` ⚖ | Staleness/propagation/index-lag/orphan/type-mismatch/marker/broken-link/repeated-text/duplicate-title audit | `{issues, errors, warnings, infos, mustFix, informational}`; module hygiene checks appended. TODO and VERIFY markers are one `info` finding per document and kind, with `count` and the first three as `examples`; `verification: unverified` in the frontmatter is one `verify` finding on its own. An unresolved wiki-link is a `broken-link` warning, resolved exactly as `validate` resolves it. `mustFix` is errors plus warnings, `informational` is infos |
| `accept-mtime` | Baseline file mtimes so silent-edit detection stops flagging mechanical edits | |
| `tags` ⚖ | Tag hygiene report: variant groups with a proposed canonical tag, tags that repeat the document's type or directory, alias hits, out-of-vocabulary tags | read-only; reads frontmatter, not the index; configure with [`taxonomy.tags`](configuration.md#taxonomytags). `--apply` migrates the tags: every `aliases` entry and every variant group whose canonical is in `vocabulary` (`--groups`: all of them; `--redundant`: also drop redundant tags; `--only <old>`: one tag; `--dry-run`: report only). It edits only the `tags:` entries on the raw text, never bumps `updated`, reindexes, and accepts the touched files' mtimes. A file edited while it runs is skipped, and `--only` merges only the collisions its own rename causes |
| `hygiene reconcile\|list` ⚖ | The content-hygiene log under `context/hygiene/`: `reconcile` refreshes the index, detects issues (audit checks, silent edits, index table rows, `--extra` candidates), gives each a stable ID, applies the open/snoozed/resolved state machine and writes only the files that change; `list` reads the log | `reconcile --fixed <file>` records the skill's auto-fixes in `last-run.md`; `reconcile --dry-run` writes no log file (the index is still refreshed); `list --state open\|snoozed\|resolved`. Sections of the log it does not own are kept as written, each file is replaced atomically, and while a check cannot run (a module's check throws, fact-drift cannot read a canonical file) nothing that was not detected again is resolved. The `content-hygiene` skill calls both |
| `registry` ⚖ | Regenerate the registry table of every `_index.md` with a `registry:` frontmatter block, from its children's frontmatter, between `<!-- brain:generated:registry -->` markers | `--check` writes nothing and lists stale indexes (exit 1), and is the only form that runs in an uninitialized directory; an index or child that cannot be read or parsed is reported under `invalid` and left as it is; `updated` is bumped only on a file whose table changed; `{indexes, written, stale, invalid}` |
| `maintain` | Routine maintenance sequence: registry tables (as `brain registry`), incremental index, vector compaction (only when fewer than half the vector slots are live), audit snapshot (the same counts as `brain audit`, module hygiene checks included, with its must-fix and informational totals), stats recording (0.40.0+), tag report (counts only), git packing, scratch prune | exit 2 if any step failed (the tag report never fails it); the hosting container runs it daily. The git step runs git's non-destructive `loose-objects`, `incremental-repack` and `pack-refs` maintenance tasks when the brain is a git work tree (git's own gc counts loose objects, not bytes, so a content repo's large blobs can stay loose indefinitely); it never deletes a ref or expires a reflog; `--no-git` skips it. A brain with no chat server has no other periodic pass, so schedule it (cron) or the scratch area is pruned only when something writes into it |
| `scratch clean\|prune` | Empty the scratch area (`.brain/scratch/`), or prune it to 7 days and 1 GB | `{action, removed: [{path, bytes, reason}], failed: [{path, reason}], bytes, files}`; exit 2 when a file could not be removed; `render`, `image`, `okf export` and the UI's mask tool prune after writing there, and the chat server prunes hourly |
| `briefing` ⚖ | Mechanical daily briefing: deadlines, reviews due, silent edits | no LLM involved; the `/whatsup` skill layers interpretation on top. Opens with a `> **Warning:**` line for each `brain audit` finding about the focus document (review overdue, over its `canonicalPolicy` budget, past-dated lines). Overdue Reviews lists the 5 oldest, then `… and N more (brain audit)`; `--limit-reviews <n>` changes the cap. An **Upkeep** section, printed when `context/hygiene/last-run.md` or `open.md` exists, gives the last content-hygiene run, its age (`(overdue)` past 10 days) and the number of open entries |

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
Same-document heading links such as `[[#Section one]]` use the heading as their
visible label; an explicit pipe label takes precedence. Heading fragments are
preserved without checking whether the heading exists.

## Onboarding + health

| Command | Does | Notes |
|---|---|---|
| `setup` | Idempotent: install git hooks (`.githooks/` + `core.hooksPath`), sync skills, bin links | run explicitly with `bun run setup` in the template |
| `init --check` | Preflight JSON: bun/git/hooks/config/content dirs/key presence (booleans, never values) | consumed by `/brain-init` Stage 0 |
| `init --default` | Non-interactive minimal brain: `brain.config.json` (dependency-free), core dirs, root `_index.md`, empty sidecars, index + validate | the keyless Tier-0 path; idempotent |
| `doctor` ⚖ | Health battery: runtime, git-hooks (also warns when an installed hook differs from the one the package ships, as after an upgrade; `--fix` or `brain setup` reinstalls them), symlinks, shadowed-commands (a `.claude/commands` file a same-named skill overrides), instructions-weight (always-loaded tokens against `instructions.maxTokens`), config, db, embeddings, reranker (activation is off by default; when enabled, the configured provider resolves, its key is present and its model is pinned), mcp, deps, version, privacy (public-remote = loud fail), git-storage (loose objects over 100 MB; a `refs/original/` filter-branch backup, whose removal command is shown as text and never run), tracked-leftovers (committed OS, editor or LaTeX leftovers; the `git rm --cached` command is shown as text and never run), tracked-media (the five largest tracked binaries; warns on a tracked file over `media.maxTrackedBytes`), scratch, cache-merge (the sidecar caches and `.stats-history.jsonl` carry `merge=union` in `.gitattributes`; `--fix` appends the lines), eval-baseline (a reminder when `evals/baseline.json` was recorded with another version; never fails), search-language (`search.language` against the tokenizer the index was built with), macOS sqlite-vec | `{checks:[{id,status,detail,fix?}]}`; `--fix` applies auto-fixables |
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
| `sync` ⚖ | `sync run`, then the `/sync` skill only for what needs judgment | In 0.40.0+, machine mode (`--json` or non-TTY stdout) emits one `{run, agent}` result; human mode prints the report and any agent answer. Hands over to a configured runner for unresolved conflicts, `UNKNOWN` leftovers, or interactive `MEDIA`/`LARGE` leftovers. Without an invocation, preserves the run's exit code (`0` complete, `1` failed, `3` needs judgment); a successful agent invocation exits `0`, an agent failure `2`. On 0.39.0, bare sync always prints text; use `sync run --json` for the mechanical envelope |
| `sync run` | The whole sync without an agent: reconcile stashes, `assess --fix`, `commit`, `pull`, `resolve`, `conclude`, `stash`, `push` (up to three re-pulls on a rejected push), `post-sync`, then a report | `status` `complete` (exit 0), `failed` (exit 1) or `needs-judgment` (exit 3: a conflict is left in progress, or a file holds conflict markers; nothing pushed). Media, unknown files and names that only look like secrets are listed as leftovers, never committed. `--json`: `{status, reason?, steps, leftovers: {unresolved, unknown, media}, judge, timings, report}`, where each `steps` key holds that verb's envelopes in run order |
| `sync <verb>` | The steps on their own: `assess [--fix]`, `group`, `commit [--plan \| --plan-file <path>]`, `stash [--dry-run]`, `pull`, `resolve`, `conflicts`, `conclude`, `push`, `post-sync` | grouping is taxonomy-driven. `assess --fix` ignores artifacts and unmistakable secrets (`.env`, `.env.*`, `*.key`, `*.pem`) and holds other secret-shaped names back as `UNKNOWN`. `assess` classes a binary `MEDIA` and a file over `media.maxTrackedBytes` `LARGE`, each with its `bytes`; see [media.md](media.md). `resolve` merges each conflicted file by the strategy in [configuration.md](configuration.md#merge-strategies). `commit` leaves out, and exits 1 for, any file holding conflict markers |

Sync assessment and grouping preserve literal Git paths, including Unicode,
newlines, and rename destinations. Untracked directories are expanded so
sensitive files inside them receive their own classification.

Divergent sync pulls try rebasing unpublished local commits by default and
report `rebased` on success. A stopped rebase is aborted before the existing
merge path runs, keeping conflict stages local as OURS and remote as THEIRS.
[`sync.pull: "merge"`](configuration.md#sync) selects merge-only pulls for
`sync pull`, `sync run` and bare `sync`.

Module packages add ONE namespaced top-level command each (`brain jobs …`,
`brain finance …`, `brain image …`, `brain travel …`) — see [modules.md](modules.md).

`brain travel validate --json` checks canonical journey/trip/place formats,
references and relative assets: `{validation: {valid, files, issues}}`.
`brain travel migrate [--dry-run] --json` moves literal legacy speaking party
settings: `{migration: {path, changed, dry_run}}`. Refusals leave configuration
and content unchanged; see the [travel upgrade guide](../packages/module-travel/README.md#upgrade-from-speaking).

`brain travel photo <files> --to <dir> --json` creates reduced, oriented JPEG
copies inside the brain: `{photo: {files, errors}}`. It preserves originals and
existing outputs, strips input metadata, and reports original capture time/GPS
separately. Exit `2` means input failures alongside any successful copies;
argument/output-directory refusals exit `1`. See the [photo guide](../packages/module-travel/README.md#photo-copies)
for exact fields, collision naming, supported inputs and metadata semantics.

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

## Recorded corpus trends

Stats history (`--record`, `--history`, `--since`), the maintain `stats` step
and trend verdicts are additions in 0.40.0. These flags are unavailable in
published 0.39.0.

Stats JSON includes core-owned `trends` for embedding coverage, broken links
and orphans; `stats --history --json` and maintain's `stats` step carry the
same evidence. Human stats attaches each comparison to its health figure;
maintain and briefing print warning explanations only. The PWA merges
current-value and trend evidence for the same metric in one notice.

Compare seven UTC calendar days ending today with the preceding seven, using
ordinary medians and at least three valid daily observations in each.
The latest observation used must be within 48 hours; the earlier observations
still supply the two comparison windows. Gaps and unknown values are never zero.
Coverage warns for a fall of at least 0.05 below the configured floor;
broken links require rate rise at least 0.01, paired count rise at least 3,
and recent rate above the ceiling. Orphans require at least 5 more and a
relative rise of at least 20%; a zero baseline uses the absolute gate alone.
Floor/ceiling equality does not trigger those strict guards. Initial rules
are uncalibrated and describe movement, not its cause.

Insufficient, stale or incompatible provenance is explicit in JSON and
creates no new alert. In particular, development 0.39.0 coverage histories
cannot establish which side of the eligibility change they recorded.
Unknown versions are declined until reviewed. `--since` filters chart arrays,
not the comparison windows. Evaluation never writes history; `--record` and
maintain evaluate before their existing recording step. See the
[full trend contract](integration-contract.md#recorded-corpus-trend-verdicts-additive-in-0400)
and [decision](decisions/stats-trends.md).

## Queue intake on a UI server

`brain queue add --server https://example.org --key odysseus-route-1
--credential-file ./queue-credential.json --text "Plan Odysseus's route" --json`
queues a durable triage item without filing content. Keep the same key when
retrying: the server returns the same item for identical content and rejects
reuse for different content. `brain add` remains the content-capture command.

Use the existing signed principal cookie in a private (0600) JSON credential
file: `{ "server": "https://example.org", "cookie": "SIGNED_PRINCIPAL_COOKIE_VALUE" }`.
Its origin must match `--server`; redirects never forward it. Password mode
requires a usable owner or delegated cookie. Other authentication modes retain
the server's existing authority; omitting the credential file sends no cookie.
Only loopback supports plain HTTP. `--title`, `--text` and `--url` carry input;
at least one is required. The command needs no local index or brain config.
See the [exact JSON and error contract](integration-contract.md#durable-share-and-cli-intake-additive-679)
and [HTTP intake contract](http-api.md#authenticated-cli-intake-additive-679).
