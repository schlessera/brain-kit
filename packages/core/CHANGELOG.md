# @schlessera/brain

## 0.40.0

### Minor Changes

- b1b83cd: Report deterministic recorded coverage, broken-link and orphan trend verdicts
  through stats, maintain, briefing and the PWA, with comparison evidence and
  explicit insufficient, stale and incomparable states.
- e977423: **Breaking (pre-1.0, ruled on #394):** `brain audit` reports TODO and VERIFY markers as one finding per document and kind instead of one per marker, and a `verify` finding is `info` instead of `warning`. Each carries `count` (the markers of that kind in the document) and `examples` (the first three, in source order). A document with both kinds has two findings. A consumer that counted `todo` or `verify` issues to count markers should sum `count`; one that treated `verify` as must-fix should read it as informational. `brain hygiene` keys `todo` and `verify` entries on the document, so an existing log resolves its per-marker entries once and opens one entry per document and kind.

  Additive:

  - The optional frontmatter `verification: unverified` declares a whole document unverified: exactly one `verify` finding, inline markers or not. There is no `verified` value, and a document without the field is not thereby verified. `brain validate` warns on any other value.
  - A `broken-link` warning for each wiki-link that resolves to nothing, resolved exactly as `brain validate` resolves it (paths, basenames, directory anchors, `#heading`, `|label`, aliases) and worded the same, with the target in `target`.
  - `brain audit --json` gains `mustFix` (errors plus warnings) and `informational` (infos). `brain maintain`'s audit step appends `; <n> must-fix, <n> informational` to its counts.

  **Schema 15.** `brain.db` gains the nullable `documents.verification` column; the next `brain index` fills it.

- fe5c751: Add the supported `@schlessera/brain/queries` entry for graph modes, link walks,
  voice vocabulary, bounded listing and complete hygiene metadata selection. Each
  operation reads a validated read-only snapshot and returns detached results or
  safe typed errors. Existing CLI/MCP behavior and SQL guarantees remain unchanged.
- c926d42: Skip dormant modules when registering MCP tools at server startup, without importing their tool definitions. Keep declared tools visible in module listings and preserve the registered tool set until the running server restarts.
- f19da8b: Add authenticated `brain queue add` intake with explicit replay keys and scoped
  principal-cookie transport. Shares now create durable untrusted triage work,
  deduplicate normalized content, preserve server-owned provenance, and reconcile
  failed staging/database writes. Queueing does not file content or enable
  autonomous execution.
- 22ed27c: Breaking: configuration loading now rejects `exclude.files` entries ending in `/`; replace `files: ["drafts/"]` with `dirs: ["drafts"]` to exclude the directory. Directory checks ignore exact-file rules, keeping stats consistent with indexing and preventing OKF output from remaining indexable.
- c8e81ad: Add module dormancy, context estimates and source-preserving CLI toggles with explicit instruction ownership and legacy migration checks.
- a39b7bc: Let modules contribute namespaced MCP tools with typed contexts, strict input
  and output schemas, and startup validation that isolates a module's definition
  failures while keeping core and other modules available.
- 4503591: Add schema-driven module Settings with per-module JSON overrides, validated revision-guarded saves, explicit source-preserving migrations and separate lifecycle/actions. Jobs exposes its complete scoring format, adapter choices and execution settings, preserving legacy scoring representation during migration and edits.
- fb992c8: List declared canonical module MCP tool names in `brain module list --json`,
  validate tool definitions and author documentation in `brain module lint`,
  and guide module authors through shared CLI/MCP operations.
- 2898ef1: BREAKING: `Enrichment.describeAsset` now returns `Promise<string | null>`.
  No vision capability or empty/whitespace completion output returns `null`
  instead of an asset title; callers must handle `null`, and custom enrichment
  implementations should return it when no description was produced. The shipped
  completion contract suite now asserts these results and zero calls for no vision.

  Undescribed images and PDFs keep searchable placeholders, stay out of description
  caches and embeddings, and retry on later indexing runs without file changes.
  Real non-empty descriptions may equal the title. Historical cache strings remain
  untouched; regenerate a known bad entry with `brain index --forget-cache <path>`
  followed by `brain index --embeddings` to reset both sidecar and database state.

- 2480efe: Move pi graph and listing reads to supported core query results with safe index errors, and route remaining native-handle helpers through the unsupported core internal entry.
- d981938: BREAKING: model search reranking now requires `reranker.enabled: true` in canonical brain config. Omitted or false keeps judgment off even with credentials, a custom provider, `--rerank jev` or `BRAIN_RERANK_MODE=jev`. Add the boolean to retain former credential-triggered ordering; turning it off preserves provider settings. Direct `hybridSearch` injection also requires `rerankerEnabled: true`. Explicit disabled model requests warn and use local heuristic results, while eval refuses to score flag/environment fallback. Dry-run previews remain available while disabled or keyless and send nothing.
- ac34a83: Sync pulls rebase unpublished local commits by default, falling back to merge after aborting any stopped attempt; set `sync.pull: "merge"` for merge-only history.
- 67c7403: Add the shared geo library with explicit GPX recovery and unit-bearing track summaries, normalized-track recovery and directional proximity measurements while retaining strict travel parsing and measurements.

  Add configured Nominatim geocoding with qualified candidates, explicit service failures, disk cache/source age and shared operator admission across CLI/server processes.

  Add configured prepared-dataset routing and explicit eligible FOSSGIS fallback, with honest source/transfer/cache metadata and nullable provider estimates.

  Add bounded Overpass POI queries near points or along retained track sections, mapped opening-hours unknowns, ordered fallback and persistent admission refusal handling.

  Share the existing SDK coastline/land/road geometry through geo, keeping compatibility exports/result-or-empty behavior while adding canonical configuration, cached layer sources and shared admission.

  Route SDK reverse geocoding through the shared client while retaining its nullable address result. Public Nominatim now requires explicit informed eligibility; the location tool keeps raw coordinates when eligibility is absent. Both first-party backends expose the opt-in setting.

  Add canonical geo configuration to brain config and the UI server adapter, preserving legacy endpoint/privacy switches and keeping disposable response caches separate from permanent geometry caches and global operator admission.

  Add deterministic vector static PNG maps with bundled fonts, preserved track gaps, numbered stops, complete legends and source/attribution evidence. Wide or unavailable backgrounds yield plain maps; unsupported projection, glyphs or image budgets retain complete text without changing source geometry.

  Add brain geo geocode, route, poi, track and map with one-document JSON contracts and qualified human output. Commands share canonical service configuration and cache/admission, retain original track evidence and protect local map writes through brain/scratch containment.

- 878e6cf: Record `brain stats` over time (#581). `brain maintain` gains a `stats` step, run after the index and audit, that keeps the day's figures as one line of `.stats-history.jsonl` at the brain root: the counts, the health figures and the size totals, one snapshot per UTC day (a second run the same day replaces it), every day for 90 days and then one per week. The file is committed with the brain, so `brain index --force` and a fresh clone keep it; nothing indexes, validates or audits it. `brain stats --record` records on demand, and `brain stats --history [--since YYYY-MM-DD] [--json]` reads the snapshots back oldest first, one array per field, with `null` where a snapshot has no figure. `brain stats --json` is unchanged.

  `GET /api/brain/stats/history` passes the history through, and the PWA's /stats answer draws trend charts for documents, orphans, stale documents, embedding coverage and the broken-link rate once two snapshots exist, and nothing with fewer.

- e977423: **Breaking:** `brain sync` with no verb now prints one JSON result in machine mode (`--json`, or stdout not a TTY), where it used to print its text report whatever the output mode (#290). The result is `{ run, agent }`: `run` is the envelope `brain sync run --json` prints, report included, and `agent` says whether the `/sync` agent was invoked — `{ invoked: false, reason: "not-needed" | "no-runner" }`, or `{ invoked: true, runner, outcome, runtime, text, error? }`, where `runtime` is what that run reported about itself (`{ name, version }`, `version` null when it gave none) and null when it reported nothing. The built-in `claude` runner reports the Claude Code version from the session's `init` event; nothing is ever probed. Human mode (`--human`, or a terminal) is unchanged, and so are the exit codes and when the agent is called. A machine-mode agent failure prints the result as well as its error, and still exits `2`. Migration: a caller that read bare `brain sync` stdout as text passes `--human`, or reads `run.report` and `agent.text` from the result.

  `AgentRunner.run` and `runStreaming` accept an optional `onRuntime` callback, which a runner calls with what executed the run (experimental seam; runners that do not call it keep working).

  The server's sync paths ask for the result and record it on their own run's root span with the attributes chat's `runtime_observed` writes (`brain.runtime.name`/`version`), plus `brain.sync.agent`: the in-process scheduler now writes a root span for each of its runs, and the container cron wrapper reads the result of the base `sync` job only — the crontab line becomes `sh -c 'brain sync --json && brain index >&2'`, and the log still gets the readable report. `/api/status` adds `runtime.sync`: the latest sync run's own invocation state and runtime, and the last run that observed a version, with its run id and times. The UI's manual sync passes `--human`.

- 502d6d9: Add standalone travel with canonical journey, day-trip and place formats and a lossless configuration migration.

  Pre-1.0 break: speaking stops contributing travel taxonomy and plan-travel. Install and enable the matching travel module, migrate travelParty with `brain travel migrate`, then restart and sync skills; existing document paths, types and links are preserved.

- fa6a62c: Add optional `embed: false` type policies that retain keyword search, links and
  audit while skipping chunk contexts and Markdown/image/PDF vectors. Ordinary
  indexing removes existing vectors after a type opts out, even for unchanged
  files; opting back in takes effect on the next embedding-enabled index.

  Change nullable `health.embedding_coverage` to count only eligible chunks and
  their vectors. Total chunk/vector inventory fields keep their meaning, and
  zero eligible chunks remain unmeasured. This is an approved pre-1.0 semantic
  contract change: consumers should use the supplied ratio rather than divide
  the total counters. CLI and chat stats wording now names eligible chunks.

### Patch Changes

- 113fa0a: Show the current audit must-fix count in briefing, including module findings and excluding informational markers, even without hygiene logs.
- 6b311b2: Finish CLI stdout and stderr writes before exiting so large piped responses remain complete, while unrelated provider sockets and timers cannot delay a finished command.
- eac3e7a: Correct the brain_context tool description to explain existing source-section expansion, per-hit limits and snippet fallback within the estimated token budget.
- 5df68f6: Resolve same-document heading wiki-links so index, validate, stats and audit no longer report them as broken.
- 9c830e4: Frontmatter parsing no longer goes through gray-matter's process-wide cache. Two byte-identical documents parsed in one process now get independent data, so changing one can no longer change what is read for the other. Broken frontmatter is reported as invalid on every parse, not only the first; before, a second parse of the same bytes in a long-lived process read as an empty success. The cache also kept every distinct document string in memory for the life of the process, and that is gone. Frontmatter semantics and formatting are unchanged.
- 36ad7da: Give Gemini the installed brain agent contract in GEMINI.md during skills sync,
  replacing the redundant legacy Skills index. Preserve all text outside managed
  blocks, refuse ambiguous markers, and refresh the contract after package upgrades
  without rewriting unchanged files.
- 523ffa8: Exclude root GEMINI.md instructions from content indexing and validation by default.
- 619ee2b: Use the Odysseus world consistently in fixture corpora, package guidance and examples.
- a4cc575: Preserve concurrently created destinations when file replacement is disabled.
- 56a9005: Preserve arriving scratch destinations when replacement is disabled.
- a5e1ecf: Reject unknown and retired job boards before execution or settings writes; honor explicit empty selections and retain settings diagnostics during CLI dispatch.
- 17146c4: Keep heading text visible when exporting bare same-document wiki-links to OKF, while preserving explicit labels and heading fragments.
- Updated dependencies [67c7403]
- Updated dependencies [3f0870d]
- Updated dependencies [4c1a424]
  - @schlessera/brain-geo@0.40.0
  - @schlessera/brain-render-template@0.40.0

## 0.39.0

### Minor Changes

- 0c19962: `brain sync` runs without an agent. The new `brain sync run` does the whole sync the `/sync` skill used to walk an agent through: it reconciles stash entries, ignores artifacts and unmistakable secrets (`.env`, `.env.*`, `*.key`, `*.pem`) in one `.gitignore` commit, bumps `updated` on edited notes, commits tracked changes grouped by domain with templated messages, pulls, merges conflicted notes by rule, pushes (re-pulling up to three times when the push is rejected), and reindexes. It reports `complete` (exit 0), `failed` (exit 1) or `needs-judgment` (exit 3: a conflict no rule merges, left in progress with nothing pushed, or a file holding conflict markers, never committed), with a terse report. Files it cannot classify, names that only look like secrets, and media are listed as leftovers, never committed. Bare `brain sync` now runs `run`, prints its report, and hands over to the coding agent only for what needs one: a conflict, a file it could not classify, or media to approve when a terminal is attached.

  New verbs, each usable on its own: `assess --fix`, `commit` (with `--plan` to print the plan and `--plan-file` to apply an edited one), `stash [--dry-run]`, `resolve` and `conclude`. `pull` now finishes a merge, squash or conflicted stash pop an earlier sync left pending before it pulls, and `synced`, `fast-forwarded` and `merged` now guarantee that HEAD contains `origin/main` (#328). A rebase, cherry-pick, revert or am in progress is reported as `merge-failed` with a `reason`, never finished.

  Conflicted notes are merged by a strategy chosen from the file: `synthesize`, `table-union`, `timeline-append`, `keep-both`, `latest-wins-additive`, with code left to the agent. The merged text is always made of blocks one side wrote. A type can choose its strategy with the new `taxonomy.types.<name>.mergeStrategy`; the core types `identity`, `note` and `index` set `latest-wins-additive`, `keep-both` and `table-union`.

  With `TYPESAFE_API_KEY` set, TypeSafe AI's Jev classifier answers two judgments: whether an unclassified file is an artifact, and how two edits of one passage relate. An answer is used only above a fixed confidence line, and a passage pair only when Jev gives the same answer with the sides in either order. Otherwise, and without the key, a timeout or an error, the conservative default applies: the file stays unclassified, and both passages are kept, newer first. The new `sync.judge: "off"` turns the calls off.

  **Breaking (contract):** bare `brain sync` changes. It used to run the `/sync` agent unconditionally, print only the agent's final text, and exit `1` when no agent runner was configured. It now prints `run`'s report first, followed by the agent's text only when it hands over, and without an agent runner it runs the sync and exits with `run`'s code (`0`, `1` or `3`). The maintainer approved this on #328; `docs/integration-contract.md` records it. `ui-server`'s `sync()` keeps calling bare `brain sync` and reading its stdout as text, so it needs no change: most syncs now finish without an agent session. The new config keys (`sync.judge`, `taxonomy.types.<name>.mergeStrategy`) and the shapes of the `brain sync` verbs are not part of the contract.

- ba23fcc: Search can order results by relevance judgment. A new `Reranker` seam (`defineReranker`, `RerankCandidate`, `Ranked`, and `runRerankerContract` in `@schlessera/brain/testing`) has one built-in, `jev`: one TypeSafe System One Choice over the candidates per search, with each candidate's title, type, tags, summary, matched excerpt and lifecycle fields (status, relevance, updated) as evidence. It is the default rerank mode when `TYPESAFE_API_KEY` is set; without the key, search keeps the `heuristic` ordering. Measured with `brain eval` on a 1,133-document brain, hybrid hit@1 went from 0.407 (heuristic) and 0.556 (none) to 0.741 on 27 hand-written queries.

  `rerank` accepts `none | heuristic | jev` on `brain search`, `brain eval`, the MCP `brain_search` tool and `BRAIN_RERANK_MODE`. `heuristic` and `none` keep their meaning. The MCP input's default of `heuristic` is gone: an omitted `rerank` now follows the brain's `reranker.provider`. `jev` does not apply the lifecycle multipliers after its order. Applied there, they undid most of its gain.

  A new `reranker` config block sets `provider`, `model` (pinned to `jev-1.13.0`), `apiKeyEnv`, `exclude` (paths never sent, which keep their retrieval rank), `timeoutMs`, `depth` and an opt-in `skipMargin`. A reranker that fails, times out, or returns anything but a permutation leaves the retrieval order and says so in `warnings`. `brain search --rerank-dry-run` prints the outbound request and sends nothing. `brain eval` records `meta.reranker` and refuses a `--rerank jev` it cannot run. `brain doctor` gains a `reranker` check. `TYPESAFE_API_KEY` is forwarded to brain subprocesses and cron jobs.

  The helpers a search fanning out over several sources needs to rerank the union are exported: `partitionForRerank`, `mergeWithheld`, `assertPermutation`, `buildPathMatcher`, `candidateKey`, `selectReranker` and `rerankSetup`.

### Patch Changes

- @schlessera/brain-render-template@0.39.0

## 0.38.0

### Minor Changes

- ee55f82: An alias counts as a name. A document's `aliases` now have their own full-text column, weighted like its title, instead of riding in the tags column at a tag's weight. A query that is exactly a document's title or one of its aliases, ignoring case and spacing, puts that document first in `fts` and `hybrid` search, whatever the lanes scored. When several documents match exactly, they keep their order among themselves. `brain audit` gains a `duplicate-title` finding (`info`) on each current document whose exact title another current document shares, naming the others.

  **Schema 14.** `brain.db` recreates `documents_fts` with the new column, filled from the documents table at once, and the next `brain index` rewrites every markdown row with its aliases. Tag search and `--tag` filtering are unchanged.

- 6757475: `brain archive` and the `brain_archive` tool now set `relevance: historical` when the document's relevance is `primary` or missing. An explicit `secondary` or `historical` is left alone. Before, archiving a primary document left it claiming `primary`, so it still took the primary search boost whenever archived documents were included. `brain validate` now warns on any document with `status: archived` and `relevance: primary`, and the message names the fix. It does not rewrite existing files.
- e2325b2: `brain audit` checks the canonical documents every session reads first, against a new optional `brain.config` key, `taxonomy.canonicalPolicy`. It is set per canonical key with `maxTokens` and `reviewDays`, and the only default is `currentFocus: { maxTokens: 1000 }`. Three new warning categories come with it:

  - `budget`: a canonical document over its token budget.
  - `review-overdue`: any non-archived document whose `next_review` has passed, or a canonical document past its `reviewDays` cadence.
  - `past-date`: a line in a canonical document with a policy that names a day before today, reported with its line number.

  `brain maintain`'s audit counts include them. `/brain-init` now writes a policy for the focus document.

- 3c2b20e: New `brain eval` command: scores a retrieval query set against the brain it runs in, using the installed package. Write the queries you actually ask, and the paths that answer them, to `evals/retrieval.jsonl`. `brain eval --mode fts` then reports hit@1/3/10, MRR@10 and an oracle column, overall and per query class. The oracle column separates a document ranked too low from a document never retrieved. A run that cannot be measured refuses to score and exits 2: the set is missing, an expected path does not exist, the index is older than the markdown, or a requested vector lane degraded. `--json` prints a new contract envelope, and `--out <file>` saves it. See `docs/evaluating-search.md`.
- 3bcb130: New `brain hygiene` commands own the content-hygiene log, which the skill's prose used to carry:

  - `brain hygiene reconcile [--extra <file.json>] [--fixed <file.json>] [--dry-run]` refreshes the index and detects issues: `brain audit`'s checks, every silent edit (without briefing's 10-row cap) and index table rows older than their detail files. It gives each issue its stable `{category}-{shortpath}-{hash4}` ID, applies the open/snoozed/resolved state machine to `context/hygiene/` and writes only the files that change, so a run that changes nothing leaves no diff. It keeps the parts of the log it does not own, replaces each file atomically, never drops an entry when a write fails part-way, and resolves nothing it did not see again while a check cannot run (a module's check throws, or fact-drift cannot read a canonical file). `--fixed` records the skill's auto-fixes in `last-run.md`.
  - `brain hygiene list [--state …]` reads the log.

  The `content-hygiene` skill now calls these instead of computing IDs with `sha1sum` and parsing `brain briefing` text. `brain audit` gains `exclude` and `onCheckFailed` options in the library; reconcile uses them to keep the log out of its own detection (its links and module findings included) and to learn which module checks failed.

- 9ce7d84: New `brain tags` command: a read-only report of tag hygiene, read from frontmatter. It lists variant groups such as `trail`/`trails` or `wood-working`/`woodworking`, each with a proposed canonical tag. It also lists tags that repeat a document's type or directory, documents still carrying an aliased tag, and tags outside your vocabulary. A new optional `taxonomy.tags` config block (`vocabulary`, `aliases`, `redundant`, `inflection`) steers the report, and `brain validate` now warns on an aliased or out-of-vocabulary tag when the block is set. `brain maintain` gains a `tags` step that prints the counts only and never fails the run.
- 61d2869: `brain briefing` now opens with a warning line when the focus document is overdue for review (with the days overdue), over its `taxonomy.canonicalPolicy` token budget (with both numbers), or has lines naming a past date (with the count). The warnings come from the same checks as `brain audit`, so a stale focus document no longer reads as current. A current, in-budget focus document opens the briefing exactly as before.

  The warning lines show paths and dates as literal code, on one line, so a malformed `next_review` or a path with markup cannot break the briefing. A canonical path written as `./context/current-focus.md` now means the same document as `context/current-focus.md` everywhere canonical documents are looked up, including `brain audit` and `brain context`.

- 8c97273: `brain briefing` gains an **Upkeep** section when the brain keeps a content-hygiene log (`context/hygiene/last-run.md` or `open.md`). It shows when content-hygiene last ran, how many days ago (marked `(overdue)` past 10 days), and how many entries are open. Overdue Reviews now lists the 5 oldest, then `… and N more (brain audit)`, and `--limit-reviews <n>` changes that cap. A brain without a hygiene log and with 5 or fewer overdue reviews gets the same briefing as before.

  Overdue Reviews now lists reviews due before today, as `brain audit` counts them, so the audit it points to shows every review it leaves out. A review due today is no longer listed as overdue.

- 0268bf1: Full-text search now finds a long document by the section that matches. A new chunk-level full-text index covers each chunk's heading and text. The full-text lane ranks a document by the better of two scores: its title, summary and tags, and its best-matching chunk. Its snippet comes from that chunk. Before, a 30-page document competed on whole-document BM25, whose length normalisation buried it behind a short note that mentioned the same words once. A document that matches only across its sections, such as a stopword-only query whose words sit in different chunks, is still found, and ranks after the rest.

  **Schema 13.** `brain.db` gains the `chunks_fts` table and three triggers that keep it in step with `chunks`. The first writable open builds it from the chunks already indexed, so no reindex is needed. A read-only open of an older index searches whole documents, as before. On the fixture corpus's keyless retrieval set, two multi-hop queries move up (rank 2 → 1, and 5 → 2), and nothing moves down.

- 7668c7c: The `codex` skill emitter now gives Codex the brain's agent contract, and stops writing files Codex never read. `brain skills sync` with `skills: { emitters: ["codex"] }` copies the body of the installed `CONTRACT.md` into `AGENTS.md` between `<!-- brain-kit:contract:start -->` and `<!-- brain-kit:contract:end -->`, and it no longer writes `.codex/prompts/`. Codex already finds skills in `.agents/skills/`. The first sync after upgrading deletes the `.codex/prompts/<name>.md` files the old "Skills index" block proves it generated, then swaps that block for the contract block in place and removes `.codex/` if it is left empty. A prompt it cannot prove it wrote stays, with a warning. If a prompt or directory cannot be inspected, deleted or removed, the index block stays so the next sync retries. With a missing, repeated or misordered marker, `AGENTS.md` is left untouched and the sync warns. With the emitter on, `/brain-init` writes `CLAUDE.md` as `@AGENTS.md` plus your overlay, so the contract loads only once.

  Manual-only skills are now manual-only for Codex too. The shipped `sync` and `new-submission` skills carry `agents/openai.yaml` with `policy.allow_implicit_invocation: false`, and `brain skills lint` warns when a skill's `disable-model-invocation` and that policy disagree. `runSkillEmitterContract` takes `readsCanonicalHome: true` for an emitter whose agent reads `.agents/skills/` itself. A `SkillEmitter` may now return an optional `warnings` list, and `brain skills sync` reports each entry prefixed with the emitter's agent.

- 00391fd: `brain context` and the `brain_context` tool spend budget left over after the search hits on the top three hits' neighbours. First comes the nearest `_index.md` in each hit's directory or an ancestor. Then come the documents one link away from the hits in either direction, the ones more hits link to first. Each is one summary line under a `### Related` heading, never a body, and they are added only while they fit the budget. A document already in the output, or an archived one, is never added.
- c7aed00: `brain context` now gives each search hit as the section its best-matching chunk comes from, not a one-line snippet of the document's opening. The section is read from the file: the whole `##` section (or the text before the first one) as the markdown parses, the one holding the query's match when the chunker folded a short section into a long one, with its headings, setext included, moved below the section's own, and a fence or HTML block left open at its end closed. Every hit is placed as its snippet first and grows into its section only with the budget left after all of them, so a larger budget never holds fewer hits (#518). A hit, section or snippet, takes at most 40% of the budget; a longer section is cut at a block boundary, and one that cannot keep a block falls back to the snippet. `hybridSearch` gains a `chunks` option that fills `SearchResult.chunks` with each result's chunks that match the query through the chunk full-text index, and `brain search --chunks` returns them (an empty list on a filter-only search). A chunk match that fails leaves the results in place with empty lists and a warning, as a failed search lane does. Without the flag, the output is unchanged.
- 2ed2d21: New `@schlessera/brain/testing` export: a contract suite for each of the four core seams — `runEmbeddingProviderContract`, `runCompletionProviderContract`, `runAgentRunnerContract` and `runSkillEmitterContract`. A provider outside this repository can now run the same keyless checks every built-in runs: vectors as wide as `dimensions`, cancellation that never hangs, an honest `vision` flag, `timeoutMs` honoured, emitted skill layouts that prune what was dropped. Pass `{ describe, expect, test }` from your test runner; the module depends on none.
- a554aa7: `brain doctor` has a new `instructions-weight` check. It estimates the tokens every session loads before any work starts, as characters ÷ 4 (the same estimate `brain context` uses). That total covers `CLAUDE.md` with its in-brain `@` imports resolved one level, `AGENTS.md`, and the description of every skill without `disable-model-invocation: true`. The check reports every counted file and skill with its estimate. Only files whose real path is inside the brain count, and an import that cannot be read makes the check warn, because the total is then incomplete. Above the new optional `brain.config` key `instructions.maxTokens` (default 8000), it warns and names the three largest contributors. A brain fresh from the template measures about 2,000 tokens.
- e499c82: `brain doctor` has a new `shadowed-commands` check. It warns when a `.claude/commands/<name>.md` file has the same name as a skill. Claude Code runs the skill in that case, so the command file is dead but still looks like the one in charge. The check names each file and suggests deleting or renaming it. It passes when there is no `.claude/commands` directory or nothing clashes. A command in a subdirectory is invoked as `/<dir>:<name>`, so a skill shadows it only when the skill has that full name.
- 1c30db2: Rendered documents get a designed default style and a component system (#530). Every `brain render` and shared PDF now uses a new stylesheet: system sans display type, an accent bar over each `h2`, hairline tables, and a full-bleed A4 page whose footer shows the title and page numbers from page 2. Designed documents are composed from `doc-*` component classes (hero, letterhead, callout, card, badge, buttons, columns, timeline, steps, checklist, stats, bars, compare, line items and more) under per-document switches (`data-accent`, `doc--editorial`, `doc--compact`), never from hand-written CSS.

  `@schlessera/brain-render-template` exports the component list and snippets (`DOCUMENT_CLASSES`, `DOCUMENT_BLOCKS`), `lintDocument`, and eight document kinds with a skeleton each under `@schlessera/brain-render-template/kinds`. A complete HTML document is no longer nested inside the shell: the stylesheet is injected into its `<head>` under the author's own rules, and `<meta name="brain-render" content="bare">` opts out. The package now depends on `parse5`, which reads documents and fragments the way the browser does. `@schlessera/brain-render-puppeteer` takes page size and margins from the document's `@page` rule. Pointing `PUPPETEER_EXECUTABLE_PATH` at `chrome-headless-shell` renders in about half the time of full Chrome.

  `brain render` adds `--kind list`, `--kind <kind> --scaffold`, `--blocks [name…]` and `--no-running-title`, and its JSON envelope adds `pages` and `warnings`. The `generate-pdf` skill is rewritten around picking a kind, scaffolding, filling and rendering until there are no warnings; `plan-travel` renders its day plans as the `itinerary` kind.

- 995ed30: A brain can opt in to embedding each commit's changes in the background. With the new config key `hooks.embedOnCommit: true` and an embedding provider configured, the post-commit hook's background index run also embeds the chunks the commit changed. Vector and hybrid search then see an edit without waiting for `brain maintain` or `brain sync`. The option is off by default, so a commit never makes a paid call unless the brain asks for it. When the option is turned on, the first commit's run embeds every chunk that has no vector yet, not only the changed ones, and includes chunk contexts and asset descriptions when completions are configured. Run `brain index --embeddings` once beforehand to pay for that backlog at a time you choose. A commit that lands while an earlier commit's run is still embedding is still indexed by keyword, and its embeddings follow on the next run. The hook now runs `brain index --incremental --quiet --on-commit`, and the new `--on-commit` flag makes the decision in the CLI. The sidecar cache lines such a run adds are committed by `brain sync`, not by the hook. Run `brain setup` to install the updated hook in an existing brain.
- d176c64: `brain eval --baseline <file>` compares a run against a stored one (written with `--out`), query by query. It lists which queries were lost, gained and unchanged at each k and per class, with the exact sign-test p for information. It fails (exit 1) on a net loss of `--max-net-loss` (default 2) queries on hit@1, or on any lost query in a `--must-pass` class. Runs that measured different things (set, mode, embedding model, k) are not comparable and exit 3; `--allow-set-change` compares the queries both runs share. `--redact` leaves query text and paths out of the output. `brain doctor` reminds you to rerun the comparison when `evals/baseline.json` was recorded with another version. It never fails, and nothing runs on install.
- 5bef3b7: `brain eval --context [--budgets 1000,4000,8000]` measures what `brain context` hands an agent. Every query runs through the same assembler at each budget. It reports whether the answer is there (an expected path heads a result section, or an optional `answer` string appears in the text) and how much of the budget the output uses (median, p10, p90), in a new `context` block of the `--json` envelope. The assembler's search now takes the run's pinned `now`, so a date-pinned set gives the same context on any day.
- ff9ebc2: `brain eval` can now measure answers that change over time. A query may give `expect.select` instead of `expected`: a selector over a frontmatter date field (`deadline`, `next_review`, …) that picks the right documents at the run's `now`. `now` comes from the set's `{"now": …}` header, then `--now`, then the wall clock, and it is also what search measures recency from. A query may list superseded paths as `stale`. Rows and `per_query` then report `current_first`: whether search ranks the current document above them. A selector that selects nothing refuses the run.
- 6b30469: `brain eval --lint` validates a query set and reports title leakage without scoring and without the index. For each `paraphrase` query it names every content word (stopwords dropped, case ignored) that the query shares with the title of one of its expected documents. Findings are `warnings` and exit `0`. A malformed set exits `2` and names the line. A new `brain-eval` skill grows `evals/retrieval.jsonl` from questions that were actually asked, taken from the current session and an interview. It pairs each question with its answer through `brain search` (or a date selector when the answer depends on the date), and appends the queries only after `--lint` passes.
- 55fe04c: A top-level `evals/` directory is no longer indexed. It holds a retrieval query set and its results, and search must not see them: a note that quotes the queries answers them and makes the eval grade itself. Every `isExcludedPath` caller (index, stats, MCP listing, OKF export) agrees on the exclusion. `brain eval` now also checks indexed documents before scoring. A document containing one of the set's queries of four or more words, or three of its queries of any length, is named in `warnings`, and `--strict` makes that a refusal (exit 2).
- a59b3b1: `brain audit` catches a restated fact that drifted from its canonical value. The config key `taxonomy.facts` names, for each fact, the document that holds the value in a `facts:` frontmatter map (`facts: { ranger_since: 2019 }`), and the case-insensitive patterns, each with one capture group, that find the fact restated in prose. Every other non-archived markdown document that states another value gets a `fact-drift` warning, `"<key>: found <x>, canonical <y>"`, once per fact. Numbers compare as numbers, and text inside code is skipped. A document can list the keys it restates on purpose as they once were under `facts_ignore:`. A pattern without exactly one capture group fails config load. The content-hygiene skill now takes these issues from `brain audit --json` and keeps its own judgment pass only for canonical files without a `facts:` map.
- 548561f: Archiving a document and `brain_update` (over MCP and in the pi backend) now change only the frontmatter keys they set. Every other byte is kept: YAML comments, quoting, key order, flow or block sequences, blank lines, and the body. Before, the whole frontmatter block was re-serialized, so a one-field change dropped comments and restyled lists. A value in a form the new editor does not rewrite (a multi-line flow sequence, a multi-line plain scalar, a flow map, keys indented under the fence), or an edit that would not read back exactly as asked, types included, falls back to the old serializer. Block scalars (`summary: |`) and quoted keys are edited in place, comment and blank lines inside a value are kept, line endings are kept, and a date-like list entry is quoted so it stays a string. A quoted key spelled with escapes (`"sta\u0074us"`) also falls back. `@schlessera/brain` exports the editor as `editFrontmatter` and `updateDocument`.
- 48377ab: Documents can declare where they come from with an optional `generated_from` frontmatter field. It holds a repo-relative path to the source, or a tool name when there is no file. `brain validate` reports any value that is not a non-empty string. `brain audit` reports a `propagation` issue when `generated_from` names a markdown document updated after this one. The heuristic reranker weights a generated document ×0.85, the same as `historical` relevance. Search results carry the value as `generatedFrom`. The index gains a `generated_from` column (`schema_version` 11). The first index run after the upgrade re-reads every markdown file to fill it, and unchanged chunks keep their vectors. The shipped `CONTRACT.md` tells agents to change a generated document's source rather than editing it by hand.
- 6f9ab3b: Images and PDFs that git ignores are no longer indexed. An ignored asset exists on one clone only, so indexing it there paid for a vision description and an embedding that no other clone would see, and made search results differ between clones. The asset scan now asks git once per work tree, the brain and each initialised submodule (`git ls-files --others --ignored --exclude-standard --directory`), and skips what it lists, and an asset that becomes ignored is removed on the next run, like a deleted file. Gitignored markdown is still indexed, so local-only notes stay searchable. Outside a git work tree, or without git, nothing is left out. `brain stats` `size.corpus` follows the same rule.
- 82f6b55: `brain_graph` now also returns `nodes`, with the `path`, `title`, `type`, `summary` and `updated` of every document its edges touch. An agent no longer needs one read per neighbour to learn what it is linked to. Unresolved link targets stay in `edges` only. Outgoing targets are resolved in the edge query itself instead of one lookup per edge, and `edges` is unchanged.
- 54b21fe: Search's recency boost now follows your own document types. A type spec takes an optional `halfLifeDays`; without it, a type decays over its `staleDays`, else 365 days. The built-in half-life table named types from one particular taxonomy, so in most brains every type fell through to 365 days. It is gone: only the four core types carry a default half-life (`context` 30, `note` 60, `index` 365, `identity` 1095). A brain whose types matched the old table, such as `project` (180 days) or `expertise` (730), sets `halfLifeDays` on them to keep that decay. `SearchDeps` and `RerankerConfig` take an optional `taxonomy`, and `brain search`, the MCP server, `brain context`, `brain process` and the pi backend pass the brain's.
- 5b9daa4: `brain context` reads the identity and current-focus documents lead first when they do not fit whole. The lead is the document's `summary` plus its text before the first top-level `##` heading. The summary also leads when the whole document fits. After the lead come its `##` sections whole, in order, while they fit, followed by the `(truncated — brain read <path>)` pointer. Only a lead that does not fit on its own is cut, after its last whole block (paragraph, list, fence) that fits. `/brain-init` asks for a short facts card (roles, location, languages, how to reach you; each optional) and for current priorities and dated items. It seeds them as the leads of `me/identity.md` and the current-focus document. The shipped `CONTRACT.md` states the convention, so agents keep the leads current.
- 8e5229a: The job pipeline now lives in frontmatter. An opportunity's `status.md` records `stage` (`researching` to `offer`, or `closed`), `fit`, `applied`, `next_step` (with its date in `deadline`) and `closed_reason`.
  - `brain jobs scaffold` writes `stage: researching`, `tags: [job-search]` and the research-opportunity section set.
  - The `research-opportunity` and `interview-scheduled` skills set these fields instead of editing prose and the index table.
  - New `brain jobs pipeline` gives the opportunities' `_index.md` a registry spec, with an Active and a Closed table by `stage`, and regenerates it. From then on `brain registry` and `brain maintain` keep it current. It refuses, with the file untouched, an index whose frontmatter it cannot extend safely, and a path outside the brain root.
  - Two `jobs-stage` audit checks flag an opportunity without a stage and one still researching after 60 days.
  - A registry `split` can now be `{ key, tables: { Label: [values] } }`, one table per label.
  - `runRegistry` and `registrySpecSchema` are exported from `@schlessera/brain`.
- dd5e87f: The heuristic reranker keeps only lifecycle factors (relevance, draft status and recency) and now also applies in `vector` mode, to every non-empty result set, one result included. The title-match boost and the image-asset boost for "visual" queries are gone: fusion now covers term matching. In vector mode the factors multiply a rank-derived score, `1/(60 + rank)`, instead of the raw similarity, so they move a document a few places without re-sorting the list. With `rerank: "none"`, every mode keeps its retrieval order. `rerank`'s signature is unchanged.
- d1ad02b: `brain skills lint` has a new warning, `manual-only-without-flag`. It fires when a clause of a skill's description states that the skill is manual-only ("Manual invocation only", "Manual-only", "Use only when the user explicitly…", "Never invoke automatically") but its frontmatter lacks `disable-model-invocation: true`. Quoted text, negations ("not manual-only") and limits on a single operation ("delete files only when the user explicitly asks") do not count. Without the flag, Claude Code loads the description into every session. The message gives the description's estimated token cost and the fix.
- 97baef6: `brain maintain` now packs the brain's git repository. When the brain is a git work tree, a new `git` step runs git's non-destructive `loose-objects`, `incremental-repack` and `pack-refs` maintenance tasks. Git's automatic gc counts loose objects rather than bytes, so a content repository's large images and PDFs could stay loose forever. `--no-git` skips the step, and a git failure fails the run like any other step. `brain doctor` gains a read-only `git-storage` check. It warns when loose objects exceed 100 MB, and when a `refs/original/` backup left by `git filter-branch` is keeping rewritten history alive. The removal command is shown as text and is never run, not even by `--fix`.
- f82fc83: The MCP server now sends `instructions` at `initialize`. They say the brain is the source of truth for facts about its owner, named from `profile.name` when the config sets one (as quoted data, flattened to one line and capped at 80 characters). They also say which tool to use for searching, briefing, reading and following links, and to write through `brain_add` and `brain_update`. Tool descriptions now state their limits: `brain_search` returns at most 50 results, `brain_list` at most 100, and `brain_graph` goes at most 5 hops. `brain_context` says how it fits its budget, and `brain_add` says classification is rule-based, with no model call.
- 9c53741: `brain_search` results now carry `status`, `summary`, `updated` and `deadline`, so an agent can tell whether a hit is current without reading the file. `brain search --json` results and `brain list --json` documents gain `deadline` too. The JSON text copy of every MCP result is now compact instead of pretty-printed, which saves tokens on each call; it still parses to the same object as `structuredContent`.
- 8e84ba8: Media gets a decision before it is committed.

  - `brain sync assess` has two new classes: `MEDIA` for an image, PDF, audio, video or office file, and `LARGE` for any file over `media.maxTrackedBytes` (default 5 MiB). Both carry their size in `bytes`. Before, these files came back `UNKNOWN`. `*.pptx` is no longer an automatic `ARTIFACT`; a presentation is media.
  - A new `media` block in `brain.config.ts` sets the limit, plus `track` and `ignore` globs that settle a file once and for all (`ignore` wins).
  - The `/sync` skill asks before tracking a `MEDIA` or `LARGE` file and offers an ignore glob or Git LFS. An unattended sync leaves such files untouched and reports them.
  - A new `brain doctor` check, `tracked-media`, lists the five largest tracked binaries and warns when a tracked file is over the limit. It measures the blobs in git's index, counts Git LFS pointers and symlinks as what git stores, and warns when it cannot inspect an object.
  - The template `.gitignore` gains a commented media section, and `docs/media.md` explains what belongs in git.

- d4b62d3: A table inside a list item or a blockquote that is over the chunk size limit now splits the way a top-level table does. Every piece that opens inside the table starts with its header and separator rows, carrying the container's prefix (`> `, the list indentation, never the list marker), and a cut never falls between the header row and the separator, even in a table with no data rows. The size exceptions are the top level's too: a row too wide to share a piece with the header goes out alone and the next rows get the header again, and a header whose separator would tip it over the limit is cut at lines. Before, continuation pieces started on a bare data row. This holds at any nesting depth.

  **One-time cost.** The chunker version moves to 3, so the first index run on this version re-chunks every document once. Chunks whose text comes out the same keep their vectors. The changed ones get new chunk contexts and vectors on the next `brain index --embeddings`, which are paid calls.

- acd47da: The pi backend's `brain_context` tool now assembles its hits with core's assembler, the same one `brain context` uses. The pool of hits is sized from the budget, a hit that does not fit is skipped instead of ending the block, and each hit gets core's one-line header. Snippets no longer carry `>>>`/`<<<` highlight markers or open sections of their own. Identity and current focus stay out, since the pi session already loads them. Search warnings still lead the block, but only in whatever budget the block leaves. `@schlessera/brain` now exports `assembleContext`, `estimateTokens` and the `AssembleOptions` type. `AssembleOptions` takes a `warnings` array that collects the search's warnings.
- faba978: The pi backend's `brain_read` takes the same optional `section` and `max_tokens` as the MCP tool and `brain read`, so a pi agent can read one section of a long document, or get its outline, instead of the whole file. Called with only a path, it returns what it did before. `@schlessera/brain` now exports the shared reader, `readDocumentPart`, together with `SectionNotFoundError` and `ReadPartOptions`.
- 3b71a3a: The pi backend's `brain_search` tool takes the same date inputs as the MCP tool: `updated_since`, `updated_before`, `deadline_from` and `deadline_to` (inclusive `YYYY-MM-DD`), `sort` (`score`, `updated` or `deadline`) and `upcoming` (deadline from today, sorted by deadline). An invalid date or sort is a tool error. `@schlessera/brain` now exports `isIsoDate` and `SEARCH_SORTS`.
- b5bf884: `brain_read` takes optional `section` and `max_tokens`, and `brain read` takes `--section <heading>` and `--max-tokens <n>`. A section runs from its heading to the next heading of the same or higher level. When the result would be over the token limit, you get the frontmatter and an outline of headings with estimated token counts, plus a note on how to ask for one section. Without either option, the whole file comes back exactly as before.

  Sections are found by parsing the body as GFM, so a heading inside code, HTML, a table, a list or a blockquote never opens or ends one. A heading is matched on its visible text under Unicode full case folding. `@schlessera/brain` now depends on `remark-parse`, `remark-gfm`, `unified` and `mdast-util-to-string`, the same versions `@schlessera/brain-ui-sdk` already uses.

- ff023f6: `_index.md` registry tables can be generated from the children's frontmatter. An index opts in with a `registry:` frontmatter block: `columns` (frontmatter keys, plus `title`, `path` and `link`), and optionally `where`, `sort` and `split`. The new `brain registry` command then writes the table between `<!-- brain:generated:registry -->` markers and keeps every byte of the prose around it. It bumps `updated` only on a file whose table changed. An index that was edited while the command ran is left for the next run. An index or child that cannot be read or parsed, and a file with stray or doubled markers, are reported under `invalid` and left as they are. An index or child whose frontmatter never closes is reported the same way. Markers count only on a line of their own, and generated values, module-finance's included, render a line break, a `|` and a `<!--` so they cannot break a table or pass for a marker (`inertGeneratedText`, exported). `brain registry --check` writes nothing and exits 1 when a table is out of date; it is the only form that runs in a directory without a `brain.config`. `brain maintain` runs the same step first, as `registry`. `brain audit` checks an opted-in index for the new `index-stale` warning instead of `index-lag`.

  Core exports the one generated-region mechanism the project uses (`readGeneratedRegion`, `replaceGeneratedRegion`, `rewriteGeneratedRegion`, `splitFrontmatterBlock`). **module-finance changes a written file format:** its ledgers and dashboard now carry `<!-- brain:generated:finance -->` markers instead of `BEGIN GENERATED` / `END GENERATED`. A file with the old markers is still read, and the next `brain finance sync` rewrites it to the new syntax with the same tables. The ledger template ships the new markers.

- 18c4495: `brain audit` reports a paragraph copied into many documents. A generated set tends to repeat the same boilerplate (a disclaimer, a method note) in every file, and each copy is chunked, contextualised and embedded on its own, so near-identical vectors crowd the results of any query they match. The new corpus-wide `repeated-text` check reports, as one `info` issue with `path: "(corpus)"`, each paragraph of at least 200 characters that at least 5 documents carry. It names the document count, the first three paths and the paragraph's opening. Only top-level paragraphs count, compared with whitespace collapsed: code, a list, a quote or a heading is never reported. The check only reports; it never edits.
- d350daa: Transient output now has a place inside the brain: the scratch area, `.brain/scratch/`. `brain render --scratch` and `brain image --scratch` write there, under a name unique to each run, and so does `brain render -` without `--out`. The chat UI can open anything written there, it is never committed, indexed or exported, and it is pruned after 7 days or past 1 GB (after each of these writes, by `brain maintain`, hourly by the chat server, and by the new `brain scratch clean|prune`). Nothing writes there until git excludes the directory itself (`brain doctor --fix` adds the line, new brains have it from the template, and outside a git repository the line is required all the same, read by git), nothing is written to or pruned from a `.brain` or `.brain/scratch` that is a symlink, and every write goes to a temporary sibling renamed onto its name, so it never writes through a planted link. That covers every one of brain's own transient writers, wherever it is pointed: `brain render --out`, `brain image --out`, `brain okf export --out`, and a mask requested beside a draft in scratch, which now prunes like the others.

  Behaviour change: `brain render --out`, `brain image --out` and `brain okf export` never write through a symlink any more: a target whose entry is a link is refused, and every write goes to a temporary sibling renamed onto the name. `brain render` and `brain image` no longer accept paths under the system temp directory. A file there could not be opened from the UI. Use `--scratch` instead. `resolveWritable` now returns the path or `null`.

  `brain scratch clean|prune --json` reports `failed: [{ path, reason }]` (additive) for files the OS would not remove, and exits 2 when there are any; `brain maintain` reports its scratch step as failed the same way. A replaced output file keeps its mode. `BrainUiApp.close()` now returns a promise that resolves once the scratch prune pass in flight, if any, has been killed and has exited; await it before tearing down.

- 51ad062: `brain search` and the `brain_search` tool can filter and sort by date. The new filters are `--updated-since`, `--updated-before`, `--deadline-from` and `--deadline-to` (`updated_since`, `updated_before`, `deadline_from` and `deadline_to` in `brain_search`). Each takes a `YYYY-MM-DD` date and includes that day. `--sort updated` puts the newest documents first. `--sort deadline` puts the earliest deadline first and documents without a deadline last. `--upcoming` is short for `--deadline-from <today> --sort deadline`. An agent that is asked "what is due next" turns the date into one of these filters itself: core does not parse date phrases. Stored dates are compared as their UTC day, and date sorts keep full timestamp precision. A stored date that is not a valid ISO date or datetime (for example `2026-02-30` or `now`) counts as missing: it matches no filter and sorts last. With a query, a date sort picks its results by date from the full-text lane's best `max(limit × 20, 500)` documents and the documents behind the vector lane's 500 nearest chunks, not only from the best-scored few. An invalid date is a usage error in the CLI and a tool error in `brain_search`. The filters apply in the full-text lane, in the vector lane and in filter-only search.
- 7e5e363: A brain written in another language can turn off English-only full-text processing. The new config key `search.language` sets the full-text tokenizer and the query's stopwords together. `"english"` (the default) keeps today's `porter unicode61` stemming and English stopwords. `"none"` uses `unicode61 remove_diacritics 2`, with no stemming and no stopwords. Changing it rebuilds the full-text index on the next `brain index`, which says so, and re-embeds nothing. The rebuild commits with the rest of that run or not at all, so a failed run leaves the old full-text index whole and the next one finishes the switch. The index records the tokenizer it was built with in `index_metadata` as `fts_tokenizer`. `brain doctor` has a new `search-language` check that reports the configured language and whether the index matches it.
- bc10acc: `hybridSearch` accepts a `now` option (`SearchOptions.now`), and `rerank` accepts one in its config (`RerankerConfig.now`). The heuristic reranker measures recency from that moment instead of the wall clock, so a ranking assertion or an eval run can be pinned to a date. Omitting it keeps today's behaviour. An invalid `Date` throws instead of scoring every result as `NaN`. The CLI and MCP shapes do not change.
- 2025590: The committed sidecar caches (`.context-cache.jsonl`, `.asset-cache.jsonl`) stop churning between clones. An embeddings run now appends only the keys a file lacks and keeps every value already committed, so two clones that generated different text for the same key no longer overwrite each other on every sync, and a run with nothing new leaves both files untouched. A duplicated key resolves to its first line in sorted order on every clone, and `brain sync pull` now applies that rule instead of keeping this clone's value, so two clones settle on one line. A run that refused to embed no longer drops entries. An asset description is reused for the same bytes under another title instead of calling the vision model again, byte-identical assets in one run are described once, and pruning keeps a description while any indexed asset has its bytes. To discard a bad entry, `brain index --forget-cache <path>` removes that document's or asset's lines and resets it in the index so the next `--embeddings` run generates it again; `--json` reports `{ path, forgotten }`.
- 5b8e614: Editing a document no longer pays to re-embed the parts that did not change. An incremental index now matches a changed document's new chunks to its old ones by the text they are embedded from. A matched chunk keeps its row, context and vector, only chunks without a vector are embedded, and a kept vector's archive flag and type follow the document. The document row is updated in place, so its id stays stable. `brain index --force --embeddings` holds the markdown vectors in memory before it wipes the index, and reuses any whose embedding text is unchanged, as long as the configured provider and dimensions are the ones that produced them. With a different provider it still re-embeds everything. `embeddings` in `brain index --json` still counts the vectors written, including reused ones written back after `--force`.
- cc5b868: Chunks follow document structure. The chunker now reads a document through the GFM markdown parser `brain read` already uses, so a fence of any length or marker, a fence inside a list item, and a table without outer pipes are what CommonMark says they are. A section over the size limit splits at its `###` headings first, with each piece headed `Section › Subsection`. After that it splits between blocks, then inside a table at row boundaries with the header and separator rows repeated at the top of every piece, then inside other blocks at line boundaries. Nothing is ever split inside a code block. A short last section, such as a link list or a sign-off, folds into the chunk before it instead of standing alone, as long as the result stays within the limit. No chunk passes the limit unless it is a single line, a single code block, or a table row too wide to fit even with its header, which then stands alone. A table's header and separator rows pass the limit together only when the header line alone does. HTML blocks are split at lines like other text; only code is never split.

  **One-time cost.** Each document records the chunker version that chunked it, in a new `documents.chunker_version` column (schema 10). The first index run on this version re-chunks every document once, even when its file did not change, and so does one stamped by another version, such as a newer one after a rollback. A document that run cannot read keeps its old version and is re-chunked on a later run. Chunks whose text comes out the same keep their vectors. The changed ones get new chunk contexts and vectors on the next `brain index --embeddings`, which are paid calls. Until every clone runs this version, clones on different versions chunk the same documents differently, so each prunes the other's cached contexts and regenerates its own on every sync.

- cb19184: A newer document can say which one it replaces. The new `supersedes:` frontmatter field takes a wiki-link target or a list of them (`supersedes: "[[bookshelf-plan]]"`), resolved like a wiki-link in the body, aliases included. Search then ranks the replaced document lower: its score is multiplied by 0.85 after fusion and reranking, in every mode, `rerank: none` included. It stays in the results, and each of its results carries `supersededBy`, the path of the document that replaced it, in `brain search --json` and `brain_search`. A filter-only search marks it too, without reordering. `brain validate` reports as errors a malformed, empty or blank value, a target that does not resolve, and every document on a cycle.

  **Schema 12.** `brain.db` gains a `supersedes` table, rebuilt on every index run like `links`. The migration has the next `brain index` re-read every markdown file once, so an existing brain picks the field up without `--force`.

- 02b3d13: `brain tags --apply` migrates frontmatter tags to their canonical forms. It applies every `taxonomy.tags.aliases` entry and every variant group whose canonical tag is in the vocabulary. `--groups` applies all groups, `--redundant` also drops tags that repeat the document's type or directory, and `--only <old>` limits the run to one tag. `--dry-run` reports without writing. It edits only the `tags:` entries on the raw text, so comments, quoting, key order and the rest of the file stay byte for byte, and `updated` is not bumped. The touched files are reindexed and their mtimes accepted, so briefing does not list them as silently modified. Files whose frontmatter does not parse, files edited while the command runs, and tags on an alias cycle are skipped and reported. A file whose index entry no longer matches the rewritten bytes is not accepted and is named under `warnings`.
- 4cdb0c3: One list of tool leftovers now drives three places. It covers OS metadata (`.DS_Store`, `Thumbs.db`, `Desktop.ini`, `*:Zone.Identifier`), editor swap and backup files (`*.swp`, `*.swo`, `*~`) and LaTeX byproducts (`*.aux`, `*.out`, `*.toc`, `*.synctex.gz`, `*.fls`, `*.fdb_latexmk`):

  - `brain sync assess` classifies them as `ARTIFACT`. Before, `*:Zone.Identifier` and the LaTeX files came back `UNKNOWN`.
  - A new `brain doctor` check, `tracked-leftovers`, warns about any that are already committed and shows the `git rm --cached` command to untrack them. It never runs the command.
  - The brain template's `.gitignore` ignores all of them.

- 806d061: Archiving through `brain_update` (MCP and the pi backend) now applies the same relevance rule as `brain archive`: setting `status: "archived"` turns a `primary` or missing relevance into `historical`, and the result's `changes` lists `"relevance"`. The rule reads the effective relevance, so a `primary` passed in the same call is demoted too, and an explicit `secondary` or `historical` (in the document or in the call) stays. Before, a status edit left the document claiming `primary`, and `brain validate` then warned about a state the product had written. The rule is exported from `@schlessera/brain` as `relevanceOnArchive`. The conference-aftermath skill now archives with `brain archive` instead of setting `status: archived` by hand.
- 532347f: The vector table can now give back the space deleted vectors leave behind. sqlite-vec 0.1.9 never reuses the slot of a deleted vector, and `VACUUM` cannot reclaim it, so a brain that is re-indexed incrementally keeps growing. `brain index --compact` rebuilds `vec_chunks` from its live rows and then runs `VACUUM`. It makes no provider call, and `--json` reports `{ compacted, before, after }`. `brain maintain` runs the same step as a new `vectors` step, but only when fewer than half the slots are live and at least one internal chunk would be freed. `brain stats --json` reports `size.db.vectorSlots: { live, allocated }`, and `allocated` is `null` when sqlite-vec cannot be loaded.

### Patch Changes

- 1751c05: When `brain add` appends to an existing document, it now changes only `updated` in the frontmatter and adds the dated `## <date> Update` section. Every other frontmatter byte stays as written. Before, the append re-serialized the whole frontmatter: YAML comments were dropped, optional quotes stripped and lists restyled. It now goes through the same raw-text editor that archiving and `brain_update` use.
- 8c6a3f5: `/brain-init` no longer registers the MCP server a second time. Its validation ladder now reads the `mcp` check of `brain doctor --json` first, and runs `claude mcp add` only when that check does not pass. A brain made from the template already declares the server in its `.mcp.json`, so the interview leaves it alone and goes straight to checking that the `brain_*` tools answer. That check now reads `me/identity.md` through the tools and compares it with the file on disk, and when the server that answers serves another brain or does not start, the interview registers one for this project.
- 93e12bd: `brain briefing` now lists stale documents by your taxonomy's staleness thresholds (`staleDays`, else `defaultStaleness`), the same rule `brain audit` and `brain stats` use, most overdue first. Before, it listed only `context` documents older than a fixed 30 days: a type with its own `staleDays` never showed up, and a brain with a different `context` threshold got a briefing that disagreed with its audit. The section is now headed `## Stale Documents` instead of `## Stale Context`, and each line keeps its form.
- 60e9fbd: The sidecar caches now merge in any git merge, not only in `brain sync pull`. The template ships a `.gitattributes` that gives `.context-cache.jsonl` and `.asset-cache.jsonl` git's built-in `merge=union` driver, so a plain `git pull`, a rebase or a hosting container's merge keeps both sides' lines instead of conflicting. The order that leaves does not matter to a reader, and the file is sorted again the next time an index run adds or prunes a line. `brain doctor` has a new `cache-merge` check that warns when either file lacks the attribute, and `brain doctor --fix` appends the lines to the brain's `.gitattributes`.
- bad7650: Chunk contexts for long documents are now written with the chunk's own surroundings in view. For a document over 8,000 characters, the chunk-context prompt used to carry only the first 8,000 characters, so a chunk further in was situated without seeing any text around it. The document part of the prompt now carries the frontmatter summary, the outline of every `##` and `###` heading, and a window of text centred on the chunk, all within the same 8,000-character budget. The outline is sent whole when it fits in half the budget. An outline too long for that drops its `###` headings first, then keeps the first and last `##` headings with a line counting the ones left out. The chunk is located by its full text, and a repeated opening or heading never places it in another section. No clip point splits a surrogate pair. A document within the budget gets exactly the same prompt as before. `Enrichment.generateChunkContext` gains an optional fifth argument, the document summary. Existing contexts are keyed by chunk text, not by prompt, so none is regenerated.
- 3c1310c: `brain eval`'s contamination check no longer flags a document for quoting the queries it answers. Exact-title and alias queries quote their own target by construction, so a set of them warned about the very documents it expects, and `--strict` refused it. A query now counts against every indexed document except those in its own `expected` list.
- a57da97: `brain context` and the `brain_context` MCP tool now use the budget they are given. The number of search hits grows with `--max-tokens` / `max_tokens`, instead of staying at a fixed 10. A hit that does not fit is skipped and the next one is tried, where before assembly stopped at the first hit that did not fit. Identity and current focus are included whole when they fit. When they do not, they are cut at a paragraph boundary with a `(truncated — brain read <path>)` pointer, instead of at a fixed 500 or 800 characters in the middle of a sentence. The identity and focus documents are no longer repeated as search hits. Each hit's header line carries its path, `updated` date, status and summary. Full-text highlight markers (`>>>`, `<<<`) no longer leak into the output, and a hit can no longer open a block of its own: each hit body is one line of contained text, with a leading Markdown marker and every `<` escaped, and every header field is flattened to one line. When identity or focus is cut, the cut falls on a blank line (including a whitespace-only or CRLF one) or before a heading, never inside a fenced block.
- 25e4911: `brain context` no longer holds fewer search hits at a larger budget. Identity and current focus used to take as much of the budget as fitted before any hit was placed, so the budget at which the focus document first fit whole could leave no room for a hit that a smaller budget had held. On the fixture corpus, `ranger` got one hit at 500 tokens, none at 550 or 600, and one again at 700. Both documents now go in first as their summary and lead, the hits are placed against the rest, and only the budget the hits leave grows the documents towards their whole body. A budget too small for both summaries and leads gives them all of it and places no hit, since a hit placed there would be pushed out again as the cut lead grows. The output order (identity, focus, hits, related) is unchanged.
- e89de6e: `brain doctor`'s `git-hooks` check now compares each installed hook in `core.hooksPath` with the one the package ships. It warns when a hook differs or is missing, and names it. Hooks are copies, and an upgrade never updated them, so a brain could keep running an old `post-commit`. After upgrading, run `brain doctor --fix` or `brain setup` to reinstall the packaged hooks. Edits you made to a hook are replaced.
- 968d151: `brain doctor` no longer crashes with no report when git is not installed. The `git-hooks`, `privacy` and `scratch` checks now report `warn` with "git is not installed or not on PATH", and every other check still reports. A check that throws for any other reason becomes a `warn` naming the error instead of aborting the battery. `brain doctor --fix` and `brain setup` finish too, and `setup` says it skipped the git hooks because git is missing.
- 5d9a179: `brain eval` now ranks with the brain's own taxonomy, as `brain search` does. The reranker takes its recency half-lives from the brain's configured types, and eval had been falling back to the core defaults, so it could score an ordering that search never returns. On the fixture corpus two queries move from rank 2 to rank 1.
- 2fac781: The full-text search lane now matches a document that holds any of the query's content words, not only one that holds every word. A question such as "when is the bookshelf deadline" used to match nothing unless a document also contained "when", "is" and "the"; English stopwords are now dropped and the remaining words are ORed, with BM25 ranking the documents that share the most and rarest words first. A query that is one quoted phrase still matches as a phrase, and a query made only of stopwords still requires all of them.
- 2d59201: `brain doctor`'s `instructions-weight` check now finds code in `CLAUDE.md` with the same GFM parser `brain audit` uses. An `@path` inside a fence within a blockquote or a list item, or inside an indented code block, is no longer counted as an import.
- 2b02102: `brain maintain`'s audit step now counts every enabled module's hygiene checks, as `brain audit` does, so the two report the same numbers. Before, maintain ran only the core audit. A finance ledger with a stale generated block showed up in `brain audit` and not in the maintain line the hosting cron logs. A module check that throws counts as one `module-hygiene` warning in both commands.
- e4b5251: Each of the nine extension seams (`EmbeddingProvider`, `CompletionProvider`, `AgentRunner`, `SkillEmitter`, `AgentBackend`, `SpeechProvider`, `AsrClient`, `ToolRenderer`, `SiteAdapter`) now carries its own `@experimental` tag, as do `BackendBridge`, `BackendCapabilities`, `StartTurnRequest`, `RendererPack`, `SpeechSession`, `AsrClientOptions`, `AdapterResult` and `ScrapeContext`, so an editor tooltip and the published declarations say what the docs already did. No shape changes. The ui-sdk README now states protocol rev 4.
- 4224247: Source comments, the `BRAIN_UI_CHROME_NO_SANDBOX` description, and the `generate-pdf` and `image-gen` skills no longer describe one particular deployment. They say what a deployment may or may not have instead.
- 48c4000: `brain sync --json assess` and `brain sync --human` now work. `brain sync` picked the first argument as its verb before looking at flags, so an output-mode flag written before the verb failed with `Unknown sync verb: --json`, and `brain sync --json` never reached the coding agent.
- 7c513fb: `brain sync pull` now classifies a failed merge by what it left in the index. If paths are unmerged it reports `conflicted` and lists them, including when `branch.main.mergeOptions=--squash` stops the merge without a `MERGE_HEAD`. If nothing is unmerged it reports `merge-failed` with exit code 1, as the fast-forward path already did: git refused to start (for example, an uncommitted edit to a file the incoming commits change), a merge was left unfinished before the pull, or a hook rejected the merge commit. It used to report `conflicted` with an empty conflict list and exit 0 for those, which left the sync skill's conflict phase nothing to resolve. A cache conflict left by a squash merge is now resolved from its index stages like any other. A conflicted path with non-ASCII characters is now listed, and its sides shown by `brain sync conflicts`, under its real name rather than the quoted form `core.quotePath` gives it. The sync skill's Phase 3 now says what to do with `merge-failed`: show the user what blocks the merge and stop.
- 2cb91e2: The brain template ships search evaluation. `bun run eval` scores `evals/retrieval.jsonl` keyless (full-text; add `-- --mode hybrid` with an embedding key), and `bun run eval:baseline` stores a run to compare against after upgrading. The README has a "Measuring search" section with example query lines (a fixed answer, a date selector and a no-answer question), and an "After upgrading" section. Nothing runs on install. A new brain also has an `evals/` directory, which is never indexed.
- 02b2c85: `brain.db-wal` no longer keeps the size of the largest write for as long as a connection stays open. Writable connections now set `journal_size_limit` to 64 MiB, and every index run, including one that fails after writing, ends with a `wal_checkpoint(TRUNCATE)`. That empties the WAL unless another connection holds a lock, such as a read transaction left open. In that case the checkpoint gives up at once rather than waiting out the busy timeout, the run's own result or error stands, and its progress output says the checkpoint was busy. `brain stats` counts the WAL in `size.db.bytes`, so after an index run that figure drops back to the database itself.
- 803a496: Hybrid search weights its two lanes when it fuses them. The vector lane keeps weight 1 and the full-text lane gets 0.8. When the full-text lane returns fewer candidates than half the result limit, its weight drops to 0.05. A few weak text matches then count for much less: appearing in both lists no longer lifts a document far down the vector lane above the vector lane's first place, though an overlap already near the top can still pass it. When the full-text lane is full, a document that both lanes rank well still comes first. The constants are provisional until a keyed `brain eval` measures them (#468).
- Updated dependencies [1c30db2]
  - @schlessera/brain-render-template@0.38.0

## 0.37.0

### Minor Changes

- dd8ae8a: The asset scan now applies `exclude.*` entries to an image or PDF's path as it is on disk. Before, it lowercased the path first, so on a case-sensitive filesystem `dirs: ["drafts"]` also removed the assets under `Drafts/` (while keeping its notes), and `dirs: ["Drafts"]` kept them.

  **Effect on an existing brain:** assets under a directory whose case differs from an exclude entry return on the next embedding run (`brain index --embeddings`). Assets under a directory that an upper-case entry names exactly leave the index on the next `brain index`. Notes are unaffected. `brain stats`'s document counts follow the index, so they change as those assets come or go; its `size.corpus` walk already matched the path as it is and does not move. `okf export` scans the disk itself, so it applies the corrected rule at once, before any embedding run.

- 0970d31: `brain.db` moves to `schema_version` 9, which adds an index on
  `links(target_id)`. Asking what links to a document — `brain_graph` with
  `direction: "incoming"` or `"both"` — used to read the whole `links` table once
  per visited node; it is now an index lookup. An existing brain gains the index
  the next time it is opened writable — the MCP server starting, `brain index`,
  `brain sync` or any other command that writes — with no reindex. No table or column changed, so readers that accept schema 8 read 9
  unchanged.
- 5f7dbb5: `CLAUDE_CODE_PATH` no longer defaults to `/usr/local/bin/claude`. Unset, a chat turn runs the Agent SDK's built-in Claude Code binary, so the lockfile decides the version. A host that relied on the old default without setting the variable now runs the SDK's binary. That version may differ from the one the host had installed; set `CLAUDE_CODE_PATH` to keep the old binary.

  The core Claude runner behind `brain sync` resolves its binary the way chat does: `CLAUDE_CODE_PATH` first, then the Agent SDK's built-in binary when the SDK is installed next to `@schlessera/brain` (a new optional peer dependency), then `claude` on `PATH`. It no longer needs a separate `claude` install. The server still keeps `CLAUDE_CODE_PATH` to itself. A brain repo that runs `brain sync` on a host without `claude` needs the SDK installed alongside `@schlessera/brain`.

- acad158: `exclude.dirs` entries are normalised when the config loads. A leading `./` and trailing `/` are stripped, so `drafts/`, `./drafts` and `drafts` all exclude the same directory.

  **Effect on an existing brain:** a bare `drafts` always worked. `drafts/` and `./drafts` excluded nothing from the index. If your config uses one of them, the files under that directory leave the index on your next `brain index`, and stop appearing in search, context and briefings. `brain stats`'s `size.corpus` changes with them: it already left out a `drafts/` entry's files, but it counted a `./drafts` entry's files, and it now leaves both out, in agreement with the index. An entry that is empty once stripped (`./`, `/`) is ignored.

- ac94af4: - Changed: `sync post-sync` commits and pushes the sidecar caches its reindex rewrites, so a sync no longer ends with a dirty tree. The commit carries only those caches: anything already staged stays staged and uncommitted.
  - Added: `cacheCommit` and `treeDirty` fields on `sync post-sync`; `sync` reports `"dirty"` when anything is left uncommitted.
  - Added: `DERIVED` class in `sync assess` for the sidecar caches, so the skill stops committing a stale copy the later reindex supersedes.
  - Changed: `sync pull` sets local changes to the sidecar caches aside while it merges, then unions this clone's entries back into the merged copy, reported as `mergedCaches`. A rewritten cache no longer fails the pull when another clone pushed its own. A conflicted cache is resolved the same way instead of being handed to conflict resolution, and when git refuses the merge outright the caches are put back untouched.
- 95ef35d: `brain init --check` now reports `config.initialized` alongside `config.exists`.
  The template ships a `brain.config.ts` with every field commented out, so
  `exists` was true on a brain that had never been set up, and `/brain-init`
  took its amend-mode branch for every new user instead of running the interview.
  `initialized` is true only once the config declares something — a profile, a
  taxonomy, a module, an embedding provider — and the brain-init skill branches on
  it. Additive: the existing fields are unchanged.
- 731282f: `brain stats` reports health and size, not just row counts.

  `--json` grows two nested blocks and loses nothing: every field a consumer
  already reads keeps its name, and its type, except `embeddings`, which becomes
  `number | null` in the same release (see its breaking-change note).

  `health` answers "what needs attention": the broken-link **rate** over the
  link count, embedding coverage as vectors over chunks, and the stale, orphan
  and untagged document counts. Stale and orphan are not new definitions — they
  are the ones `brain audit` already reports, read from the same per-type
  `staleDays` and `orphanExempt`, so the two commands cannot drift. `health`
  also echoes the warn levels in force, so a consumer never duplicates the
  defaults.

  `size` answers "what does this brain weigh": corpus bytes and file count on
  disk with the configured excludes applied, `brain.db` bytes with its per-table
  row counts, and free space on the volume. The index size is a rebuild-cost
  figure; `brain.db` stays disposable.

  A figure that cannot be measured is reported as `null`, never as `0` — an
  unknown embedding coverage must not read as a failing one, and a platform
  without a usable free-space call does not fail the command.

  New optional `stats` config block for the warn levels: `coverageFloor`
  (default `0.9`) and `brokenLinkCeiling` (default `0.05`), both ratios in
  `0..1`.

- 2d553e2: Reading a brain can no longer destroy its vector index. `initVecSupport` was
  both "make vectors readable on this connection" and "migrate the vector
  schema", and the migration drops every stored vector — so `brain mcp`, whose
  tools all advertise `readOnlyHint: true`, emptied `vec_chunks` on startup
  against any brain last indexed before the cosine migration. Recovering meant a
  paid `brain index --embeddings --force`.

  It is now two functions. `loadVecSupport(db)` is the read path: it loads the
  sqlite-vec extension and reports whether `vec_chunks` is there, writing nothing
  and taking no width, so a read cannot migrate whatever kind of connection it
  holds. `migrateVecSchema(db, dimensions)` is the write path, named for what it
  does, and `brain index`, `brain sync`, `brain maintain`, `brain doctor --fix`,
  the archiver and the indexer's re-embedding pass still call it.

  Two smaller fixes come with the split. Callers that are not about to re-embed
  now pass `storedVectorWidth(db, configured)` — the width the index was built
  at, from `index_metadata.embedding_dimensions` — instead of the configured
  provider's, so a provider swap no longer re-declares the table at a width the
  stored vectors are not in. And `sqlite-vec not available` is now printed only
  when the extension really failed to load; a read-only connection that could not
  write used to report it, sending readers off to reinstall a working dependency.

  The migrations themselves are now atomic. Each runs in a transaction, so a
  half-applied one — a table dropped and not rebuilt, or rebuilt and not
  refilled — can no longer leave the vector index gone, and a failure is
  reported rather than swallowed: `migrateVecSchema` used to return true having
  emptied the store. `storedVectorWidth` reads the width off `vec_chunks`' own
  declaration before believing `index_metadata`, and accepts one only as plain
  decimal within sqlite-vec's 1..8192 range.

  `initVecSupport` is gone from `@schlessera/brain`'s exports. Out-of-tree callers
  that only read vectors want `loadVecSupport`, branching on the exported
  `VecSupport`/`VecUnavailableReason` when they need the cause; callers that are
  about to embed want `migrateVecSchema`.

- fb1d784: **Breaking (`brain stats --json`):** `embeddings` is now `number | null`.

  - `null` when the brain has a `vec_chunks` table that could not be counted, because sqlite-vec did not load on this host. It used to read `0`, which looked the same as a brain holding no vectors.
  - A brain with no `vec_chunks` still reports `0`.
  - Consumers doing arithmetic on the field must handle `null`.
  - `brain stats --human` prints `Embeddings: n/a` in that case.
  - The `--help` caveat about the field reading `0` is gone. So is the matching note in `docs/cli.md` and `docs/integration-contract.md`.

  Ruled for 0.37.0 on #169.

- 4fc7f0b: `brain stats` reads as an answer rather than a dump. The human output now
  leads with a **Health** section — broken-link rate, embedding coverage, stale,
  orphans, untagged — each line naming the level that judged it, above an
  **Inventory** section holding the counts and what the brain weighs on disk.

  Every breakdown is ranked by count and capped at the top five, followed by a
  `+N more (M documents)` remainder, so a corpus with forty types no longer
  prints forty lines three times over. `brain stats --all` expands every
  breakdown.

  `--all` is a human-output flag only: `--json` is unchanged and always carries
  the full, uncapped breakdowns, so `brain stats --json` and
  `brain stats --all --json` produce the same object.

  A `null` figure still reads as `n/a` and never carries a verdict. Embedding
  coverage in particular says "not measured" rather than "nothing embedded":
  `collectStats` returns `null` both for a brain that does not embed and for one
  whose vectors could not be counted, and the renderer cannot tell those apart.

  One figure to know about when reading either output: `embeddings` changed
  value in this release, and its type (see the breaking-change note for #169). `brain stats` used to
  count `vec_chunks` on a connection that had never loaded sqlite-vec, so the
  query failed and the count was reported as `0` on every brain, embedded or
  not. It now loads the extension first, so on any host where sqlite-vec loads
  the figure is the real number of stored vectors — a brain that always showed
  `0` embeddings was showing a measurement failure, not an empty index.

  Where sqlite-vec cannot load at all, `embeddings` is `null` for a brain that
  has a vector table, not `0`: the count is unknown, and it reads as unknown.

  Also in the human output: byte counts scale to KB/MB/GB instead of always
  printing MB (a 22 KB corpus used to read as `0.0 MB`), and a brain with no
  documents prints one line naming the next step instead of a page of empty
  headings.

- 4157941: `brain stats` human output: a health ratio that rounds to the same one-decimal figure as its threshold is now printed with more decimal places. Before, 6 broken links in 119 read `5.0%, over the 5.0% ceiling`. It now reads `5.04%, over the 5.00% ceiling`, with the ratio and threshold widened together. Every other line prints exactly as before, verdicts still compare the unrounded values, and `--json` is unchanged.
- 0d28bae: `brain stats` now reads vectors through the shared `loadVecSupport` read path
  instead of its own copy of it. A brain with no `vec_chunks` is still answered
  without loading sqlite-vec and prints nothing on stderr. A brain that holds a
  `vec_chunks` table on a host where sqlite-vec will not load now prints
  `sqlite-vec not available: <cause>` on stderr, where it used to say nothing;
  stdout, `--json` included, is unchanged.
- f4edb02: Two `brain stats` human-output fixes:
  - A brain with no documents but an unreadable vector table now prints the `Embeddings: n/a` line under the empty-state message. Before, it read exactly like a brain with no vectors.
  - A health ratio that twenty decimal places could not tell apart from its threshold now prints with enough places to show which side it is on.
- af2affb: A Claude turn on a profile without its own credential now runs on the
  subscription or not at all. Claude Code prefers an `ANTHROPIC_API_KEY` over
  `CLAUDE_CODE_OAUTH_TOKEN`, silently, when both are in its environment; it also
  takes a key from an `apiKeyHelper` or a stored Console login. So such a turn now
  runs with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` cleared and any
  `apiKeyHelper` switched off. The CLI's account is checked before the prompt is
  sent, and a turn with no subscription login ends with a `CLAUDE_AUTH` error
  instead of billing a key. The core CLI's `claude` agent runner (what `brain
sync` uses) follows the same rule. Model discovery prefers the subscription
  token too.

  What a host may need to change:

  - **Billing an API key for chat on purpose?** Declare a profile that names it,
    e.g. `BRAIN_UI_CLAUDE_PROFILES='[{"id":"claude-api","label":"Claude (API)","apiKeyEnv":"ANTHROPIC_API_KEY"}]'`.
    Credential-free profiles no longer use the ambient key, and are now always
    classified as subscription-billed.
  - **`brain sync` under cron ran on an API key?** It now needs a subscription
    login (`CLAUDE_CODE_OAUTH_TOKEN`).
  - **`anthropic-haiku` completions inside chat turns?** Name the key separately:
    `completions: { provider: "anthropic-haiku", apiKeyEnv: "BRAIN_ANTHROPIC_COMPLETIONS_KEY" }`,
    and admit that name to the agent with `BRAIN_UI_SUBPROCESS_ENV_EXTRA`.
    `completions.apiKeyEnv` and `completions.fallbackApiKeyEnv` are new.

### Patch Changes

- b3529ac: The `/brain-host` skill no longer frames the minimum `@schlessera/brain` version
  as a one-release upgrade note. The server refuses to boot below
  `MIN_BRAIN_CLI_VERSION`, which is a standing floor, and the skill now says so —
  the old wording read as old news three releases after the release it named.
- e802456: The pre-commit hook no longer rejects a commit in a brain that has no tests.
  `bun test` treats "no test files" as an error, and the hook runs it whenever
  the staged change touches `brain.config.*` — so `/brain-init`'s single commit,
  the one the interview promises as its revert point, was refused on every
  brand-new brain. The hook now tells "nothing to run" apart from "tests failed"
  and says which it saw.
  - @schlessera/brain-render-template@0.37.0

## 0.36.0

### Patch Changes

- @schlessera/brain-render-template@0.36.0

## 0.35.0

### Patch Changes

- 545f2f9: Preserve exact sync paths, prevent overlapping UI sync jobs, keep cron outcomes tied to child exit, and discard stale file-viewer responses.
- 7a4b5af: Reuse graph metrics and layouts when their inputs are unchanged.
- cc48069: Prevent archive overwrites and accidental capture merges; bound query embedding latency and widen vector candidates to recover distinct documents.
- 1ddc4bb: Protect export destinations and share cleanup paths, replay missed failure notifications after restart, and keep session histories usable when a backend is unavailable.
- 60e05c6: Make embedding runs safe to repeat and cheap to interrupt. Only one
  `index --embeddings` run can operate on a database at a time — a second exits
  with a retry message before making paid calls — and the lock releases itself if
  the process crashes. Markdown backfills are paged rather than loaded whole, so a
  large corpus no longer holds every pending chunk in memory, and a changed
  embedding dimension is detected instead of writing vectors nothing can read.
- 84b748c: Resolve wiki-links deterministically and build corpus lookups once per indexing, validation, and export run.
- 8adb53d: Preserve indexing diagnostics on stderr in JSON mode without changing the stats envelope.
  - @schlessera/brain-render-template@0.35.0

## 0.34.1

### Patch Changes

- @schlessera/brain-render-template@0.34.1

## 0.34.0

### Patch Changes

- @schlessera/brain-render-template@0.34.0

## 0.33.1

### Patch Changes

- @schlessera/brain-render-template@0.33.1

## 0.33.0

### Minor Changes

- 54725c0: Add CLI end-of-options parsing and require a compatible brain CLI for user-controlled UI positionals.

### Patch Changes

- @schlessera/brain-render-template@0.33.0

## 0.32.0

### Patch Changes

- @schlessera/brain-render-template@0.32.0

## 0.31.0

### Patch Changes

- @schlessera/brain-render-template@0.31.0

## 0.30.1

### Patch Changes

- @schlessera/brain-render-template@0.30.1

## 0.30.0

### Patch Changes

- @schlessera/brain-render-template@0.30.0

## 0.29.0

### Patch Changes

- @schlessera/brain-render-template@0.29.0

## 0.28.1

### Patch Changes

- @schlessera/brain-render-template@0.28.1

## 0.28.0

### Minor Changes

- e381a99: Custom user skills, managed from the frontend.

  - **Settings → Skills** (new tab): create, edit, enable/disable, and remove
    your own skills, plus a read-only view of the built-ins. Custom skills are
    REAL directories in the brain repo's `.agents/skills/` — the local layer
    `brain skills sync` already treats as canonical and never touches — so
    they persist across deployments, ride the repo's git backups, override
    same-named built-ins, and reach every backend (Claude, pi, codex, gemini).
    Disable moves the directory to `.agents/skills-disabled/`, taking the
    skill out of every agent's discovery at once.
  - **`/api/skills`** CRUD (auth-guarded): strict name validation, frontmatter
    validation (name must match the directory, description required), size
    caps, and symlink-safe mutations (package skills can never be edited or
    deleted through this surface). Every mutation runs `brain skills sync` so
    the change reaches the next turn/session without a restart; a failed sync
    degrades to a response warning.
  - **Install from ZIP or GitHub**: upload a .zip, or point at a repository
    (`owner/repo`, a github.com URL, or a `/tree/<ref>/<path>` URL —
    private repos via the server's `GITHUB_TOKEN`). Any folder containing a
    SKILL.md installs as a skill, one source may carry several; the installed
    name comes from the frontmatter, zip-slip is rejected outright, archives
    are size/count-capped, installs are staged-then-swapped, conflicts are
    skipped unless overwrite is chosen, and built-ins can never be replaced.
  - **New core skill `add-skill`**: interactive, brain-kit-optimized skill
    authoring — interviews for the workflow and triggers, enforces the
    backend-portable subset (no agent-specific frontmatter or tool names,
    `brain` CLI / bun scripts for portability), writes into
    `.agents/skills/`, runs sync + lint, and hands off to Settings → Skills.

### Patch Changes

- @schlessera/brain-render-template@0.28.0

## 0.27.0

### Patch Changes

- @schlessera/brain-render-template@0.27.0

## 0.26.0

### Patch Changes

- @schlessera/brain-render-template@0.26.0

## 0.25.0

### Patch Changes

- @schlessera/brain-render-template@0.25.0

## 0.24.0

### Patch Changes

- @schlessera/brain-render-template@0.24.0

## 0.23.0

### Patch Changes

- @schlessera/brain-render-template@0.23.0

## 0.22.0

### Patch Changes

- @schlessera/brain-render-template@0.22.0

## 0.21.0

### Patch Changes

- @schlessera/brain-render-template@0.21.0

## 0.20.0

### Patch Changes

- @schlessera/brain-render-template@0.20.0

## 0.19.0

### Patch Changes

- @schlessera/brain-render-template@0.19.0

## 0.18.0

### Patch Changes

- @schlessera/brain-render-template@0.18.0

## 0.17.0

### Patch Changes

- 210446f: Unify boolean environment parsing across all packages: every boolean variable
  now accepts 1/true/on/yes and 0/false/off/no (case-insensitive, trimmed), and
  an unset, empty, or unrecognised value falls back to the variable's documented
  default instead of being misread. Defaults and directions are unchanged;
  previously `"1"`-only flags (the Chrome sandbox switches, `TRUST_PROXY`,
  `BRAIN_UI_DANGEROUSLY_DISABLE_AUTH`, `BRAIN_UI_ALLOW_PASSWORD`,
  `BRAIN_UI_ALLOW_LOOPBACK_ORIGIN`) accept the full truthy set, and the disable
  set for `BRAIN_UI_REVERSE_GEOCODE` / `BRAIN_UI_MODEL_DISCOVERY` gains `no`.
  `NO_COLOR` keeps its presence-based contract. Published descriptor types
  (`ENV_VARS` shapes) are unchanged.
- 6e1fd43: Fix per-connection protocol state never reaching the WS dispatcher (declared
  protocolRev was dropped, so the rev-3 turnId-echo requirement was never
  enforced), extract the tool-view diff engine into `lib/diff.ts`, and clean up
  dead imports/variables surfaced by the new oxlint gate.
- a714ee1: Per-package `test` scripts now pass `--timeout 30000`, so `bun run test` inside a package no longer flakes on bun's 5s default when suites spawn the CLI.
- ef519d1: Harden the publish surface: what a consumer installs now matches what the
  declarations, bundler and runtime actually reach for.

  - `@schlessera/brain-backend-pi` declares `@earendil-works/pi-agent-core`
    (exact-pinned, like its sibling pi pins) instead of borrowing it from
    hoisting — its public `history.d.ts` types reference the package, so a
    strict installer (pnpm, npm with isolated modes) could not typecheck it.
  - `@schlessera/brain-ui-react` sets `sideEffects` to `["**/*.css"]` — the
    blanket `false` licensed bundlers to tree-shake a direct
    `import "@schlessera/brain-ui-react/styles.css"` away entirely.
  - `./theme.css` now resolves from `dist/` (copied verbatim at build) like
    `./styles.css` already did, so both stylesheets survive a dist-only tarball
    and the export map is uniform. The import specifier is unchanged.
  - `@schlessera/brain-module-finance`, `-images` and `-speaking` declare the
    same optional `@types/bun` peer that `-jobs` already carried: their module
    declaration graphs reach `bun:sqlite` types through `@schlessera/brain`.
  - Every package exports `"./package.json"` — tooling like Vite, Tailwind and
    Jest stats it, and the export map previously made that unreachable.
  - `engines.bun` is aligned with reality: bun-runtime packages require
    `>=1.3.5` (the CVE-2026-24910 floor `brain doctor` warns below), and
    packages that import cleanly under plain Node carry no bun engines field.
    Scrape keeps its (bumped) engines despite importing node-clean: its proxy
    fetch path shells out through `Bun.spawn`, so the runtime constraint is
    real even though the import is not.
  - Backend loading in `@schlessera/brain-ui-server` uses `await import()`
    instead of CJS `require()`, and only "the backend package itself is not
    installed" maps to the install-hint error. An installed-but-broken backend
    (missing transitive dep, syntax error, `ERR_REQUIRE_ESM`) now surfaces its
    real error instead of a misleading "not installed".

- Updated dependencies [a714ee1]
- Updated dependencies [ef519d1]
  - @schlessera/brain-render-template@0.17.0

## 0.16.0

### Patch Changes

- @schlessera/brain-render-template@0.16.0

## 0.15.0

### Minor Changes

- 4d3d28a: Restructure the indexer as an explicit pipeline.

  `indexAll` was a single ~990-line function inside a 1,495-line module, with
  its eight phases marked only by comment banners and `quiet` re-checked at 24
  call sites. It is now a pipeline of phases under `lib/indexer/`, each in its
  own module with a stated input and output, composed by a `run.ts` that reads
  top to bottom: scan → parse → persist → vector hygiene → assets → embeddings →
  caches → graph. Shared state travels in one `IndexRun` context that also
  carries `report`/`warn`, so no phase re-derives whether it may log.

  Behaviour is unchanged and the public surface is identical — `indexAll`,
  `getMarkdownFiles`, `getAssetFiles`, `extractWikiLinks`, `resolveWikiLink` and
  `chunkContextKey` all still come from `lib/indexer`. The split did remove one
  piece of dead code (`deletedDocIds`, collected on every run and never read) and
  gained a regression test for a rule the old shape made easy to break: a run
  that refuses to embed because the embedding provider changed must still write
  the asset descriptions it just paid for to the sidecar cache.

- 0af99c4: Export `SCHEMA_VERSION` — the brain.db schema version core writes — from the
  package entry, and make `brain doctor` read it instead of carrying its own copy
  of the number.

  The version used to be spelled out as a bare `8` in four unconnected places
  (core's schema writer, the doctor check, `ui-server`'s two read floors, and the
  integration-contract doc), so bumping it meant four silent edits and any missed
  one failed at runtime rather than at build time. Consumers reading brain.db
  directly can now import the floor they should gate on.

### Patch Changes

- @schlessera/brain-render-template@0.15.0

## 0.14.0

### Minor Changes

- 59de559: - Added: every package reads the environment in one chokepoint that declares
  each variable, exports the contract (`ENV_VARS`, `resolveEnv`, `readEnvVar`)
  from the package entry, and generates its README env table from it.
  - Added: `ui-server` exports a resolved `ServerConfig` and returns an app handle
    (`config`, `db`, `wsHost`, `isTurnActive`, `cancelActiveTurns`, `close`), so
    two differently-configured apps coexist in one process.
  - Added: `openBrainDb`/`withBrainDb` gate every `brain.db` read on
    `schema_version`; `assertBackendResolvable` refuses to boot when the selected
    agent backend is not installed.
  - Changed: `@schlessera/brain-backend-claude` is an optional peer of
    `ui-server`, not a dependency — a deployment declares the backend it uses.
  - Changed: the module contract carries the config generic through
    `CommandContext`, `HygieneContext` and `CommandModule`, so a module author no
    longer casts a value the loader already validated.
  - Changed: the Gemini providers no longer delete and restore `GOOGLE_API_KEY`
    around client construction.
  - Removed: `configureDb`, `getDb`, `closeDb`, `configureWsHost`,
    `defaultWsHost`, `cancelActiveTurn`, `isTurnActive`, the `brainClient`
    namespace and the `getBackends`/`getBackendsInfo` module functions — their
    replacements live on the app handle.

### Patch Changes

- @schlessera/brain-render-template@0.14.0

## 0.13.1

### Patch Changes

- 01004ef: Read a shared photo's own metadata before filing it

  The `share` skill now checks EXIF on an image before writing the note.

  A shared photo arrives with a name its sending app invented and metadata that is
  actually true. `DateTimeOriginal` is when the photo was TAKEN — a photo shared
  today can be years old, and dating the note "today" quietly makes the brain
  wrong about when something happened. `GPSPosition` is often the single most
  useful fact about a photo of a building, a menu, or a conference badge.

  The skill asks for the place rather than the coordinates, and says outright that
  a private location is a reason to leave it out of the note rather than a detail
  to record precisely. A screenshot carries none of these tags, and that absence
  is itself a signal about what the image is.

  `exiftool` is declared in `compatibility:` and ships in the brain-ui container
  image.

  - @schlessera/brain-render-template@0.13.1

## 0.13.0

### Minor Changes

- 2be49b8: Add the `share` skill

  Fourth phase of the Android share target: the behavior that turns a staged
  share into brain content now ships as a skill rather than living in the prompt
  the UI sends. That means how a share gets filed is editable in a content repo,
  versioned with the taxonomy, without a package release.

  It reads `meta.json`, branches on what actually arrived (a link is fetched
  because a shared title is usually the site name; an image is already attached to
  the turn; a PDF or text file is read from its staged path), looks for an existing
  home before creating a near-duplicate, moves worth-keeping binaries into the
  assets tree under a name a human would recognize, captures with `brain add`, and
  clears the staging directory even when nothing was filed.

  It carries a prompt-injection guard, and needs one more than any other skill
  here: the payload can be pushed at the app by any website, so the skill states
  that shared content is material to file and that instructions inside it are part
  of the content rather than part of the task.

  Deciding a share is not worth filing is an explicit, legitimate outcome — the
  alternative is a brain that accumulates every meme anyone ever shared at it.

### Patch Changes

- a4eb4d0: Spell control and invisible characters as escapes so grep can see the source

  `chunkContextKey` embedded raw NUL bytes as hash field separators, which makes
  grep and ripgrep classify `indexer.ts` as binary — the file silently dropped out
  of every search. `brain-markdown.tsx` had the milder version: its entity
  delimiters were runs of one, two and three literal zero-width spaces, unreadable
  in a diff and destroyable by any editor that trims whitespace.

  Both now use escape sequences. The runtime strings are byte-identical, so
  existing `.context-cache.jsonl` keys still match and no LLM-generated context is
  regenerated.

  `bun run lint` (`scripts/check-invisibles.ts`) refuses raw control and invisible
  characters in tracked files and runs in CI as the invisible-character gate.

- fc5c897: Prune sidecar cache entries nothing can reach any more

  `.asset-cache.jsonl` and `.context-cache.jsonl` are tracked, so a deleted asset
  left its generated description in the repo indefinitely: the caches are keyed by
  content, and deleting a file makes its entry unreachable rather than removing
  it. `saveAssetCache`/`saveContextCache` rebuild from the database and would
  clear it, but they only run on an `--embeddings` pass — deliberately, since they
  exclude placeholder rows and rebuilding on a keyless machine would empty the
  cache for everyone.

  Pruning by reachability is safe where rebuilding is not: it asks only whether a
  key still corresponds to something in the index, which holds regardless of
  whether this machine can generate descriptions. It now runs on every `brain
index`, and writes only when something was actually removed, so a no-op run
  still produces no git diff — the property `content-hygiene` depends on.

  Malformed lines are left alone rather than discarded. Pruning found five stale
  entries in the reference brain on its first run.

  - @schlessera/brain-render-template@0.13.0

## 0.12.1

### Patch Changes

- @schlessera/brain-render-template@0.12.1

## 0.12.0

### Patch Changes

- 4281c59: Fix three things a real session on a phone turned up

  - **Images written into the brain did not display in chat.** The markdown
    renderer overrode headings, code and links but not `img`, so
    `![](assets/images/x.png)` resolved against the app origin and 404'd — the
    bytes are served by the files API. Repo-relative sources are now rewritten to
    that endpoint; `data:` URIs and absolute URLs pass through untouched.
  - **Scratch files had nowhere to go.** `brain render` and `brain image` refused
    any path outside the repo, which pushed intermediates — an HTML file that
    exists to be rendered two seconds later — into a knowledge base as git noise.
    Both now also accept paths under the system temp directory, report them
    absolute, and say that a file written there is not viewable in a UI. Anywhere
    else is still refused: this is scratch space, not free rein.
  - **The generate-pdf skill refused documents over 400 KB**, citing a file-viewer
    download limit that does not exist. The real ceiling is the file server's
    (10 MB, both the preview and raw paths); below that, size is a judgement call
    about the reader's connection. The skill no longer refuses to produce a
    document for being over an invented figure.

  Also corrects a comment on `FILE_SIZE_CAP_BYTES` claiming the `?raw=1` path was
  unbounded. It is not — `resolveForRaw` enforces the same cap, which is why
  raising it to 10 MB mattered for images and PDFs in the viewer too.

  - @schlessera/brain-render-template@0.12.0

## 0.11.0

### Patch Changes

- @schlessera/brain-render-template@0.11.0

## 0.10.0

### Minor Changes

- e6f55e0: Declare skill dependencies in `compatibility:`, and fix a macOS break

  The Agent Skills specification allows exactly six frontmatter keys, and
  claude.ai upload, the Skills API and the reference validator reject a skill
  carrying anything else. Ten shipped skills carried `requires:`, a brain-kit
  invention — so they could not be published through any of those surfaces.

  `compatibility` is the specification's slot for exactly that statement, and it
  reads better: prose an author can act on ("Requires git and an authenticated
  gh") rather than a bare token list. The linter now reads it, matching whole
  words so `github` does not satisfy a `git` dependency and `docker.io` does not
  satisfy `docker`. `requires:` keeps working — it is still honoured for the
  shell-command check — but now warns and names its replacement.

  Two skills still carry `disable-model-invocation:`, which no specification field
  replaces. It stays: dropping it would make `sync` — which pushes to a remote —
  model-invocable again, and that safety property is worth more than validator
  cleanliness.

  Separately, `content-hygiene` no longer depends on GNU coreutils. Its stable
  issue IDs came from `sha1sum`, which macOS does not ship, so the one skill
  designed to run unattended on a schedule failed silently there. The pipeline is
  now `{ sha1sum 2>/dev/null || shasum; }`; both print the digest first, so IDs
  match whichever exists.

- e33db75: Add a `pi` skill emitter

  The extending docs stated that "the pi family needs no emitter — pi and
  OMP-style agents discover `.agents/skills/` natively". That is not what pi does.
  pi 0.80.6 loads skills from `<agentDir>/skills` (user level — `$PI_AGENT_DIR`,
  else `~/.pi/agent`) and from `<cwd>/.pi/skills` (project level); its config
  directory name is `.pi`, and `.agents/skills/` is never consulted. A brain's
  skills were therefore invisible to pi while sitting one directory away.

  The new `pi` emitter symlinks each skill into `.pi/skills/<name>`, structurally
  identical to the `claude` emitter: relative links into the canonical
  `.agents/skills/` home, a Windows junction fallback, stale-link pruning, and
  never clobbering a real file or directory at the target path. Links rather than
  copies, so a skill keeps exactly one source of truth.

  Opt in with `skills: { emitters: ["pi"] }`. The docs are corrected.

- 50f6ec7: Add `brain render` — documents to PDF, PNG, or standalone HTML from the CLI

  PDF generation existed in brain-kit already, but only over HTTP: the UI posted
  content to `/api/render`, which wrapped it in a document template and drove the
  headless Chrome in `@schlessera/brain-render-puppeteer`. Nothing on the command
  line could reach it, so agents and skills that wanted a shareable file shelled
  out to a browser themselves and re-invented the layout each time.

  - **New package `@schlessera/brain-render-template`** holds the markdown/HTML →
    print-ready document shell (marked plus the stylesheet), extracted from
    ui-server. Both callers now share it, so a page shared from the app and a PDF
    produced on the command line are byte-identical for identical input.
  - **New command `brain render <path|->`** with `--format pdf|png|html`. It
    strips frontmatter, takes the title from it, defaults the output path to the
    input with the format's extension, and refuses to write outside the brain
    root. `--format html` needs no browser at all.
  - **Remote images** stay blocked by default — the rendered page resolves no
    hostname, so a remote `<img>` becomes a visible `[alt — not embedded]`
    placeholder. The new repeatable `--allow-host` opens specific image hosts,
    passing the same allowlist to both the placeholdering and the renderer.
  - **New core skill `generate-pdf`** drives the command. It declares no `requires:`
    beyond `brain` itself.
  - `@schlessera/brain-render-puppeteer` becomes an optional peer of core, resolved
    dynamically like `@google/genai`: a missing renderer produces install
    instructions rather than a module-resolution stack trace.

  Also fixes a latent bug in the image placeholdering that ui-server shipped: the
  `<img>` match used `[^>]*` for attributes, so a `>` inside an earlier quoted
  attribute (`alt="<b>x</b>"`) truncated the match and let the remote image
  through unplaceholdered, to render as a broken-image box.

- 683f3e3: Rewrite every skill description as a trigger, not a summary

  A skill's description is the entire triggering mechanism — it is all an agent
  sees when deciding whether the skill is relevant to what the user just asked.
  Most of these descriptions were written as summaries: they led with what the
  skill does and how it works, and appended a short "Use when …" clause at the
  end. Some had no trigger at all.

  All 24 shipped descriptions now lead with the situation that should pull the
  skill in, phrased the way a user would actually put it, with mechanism left to
  the body where it belongs. `content-hygiene`, `sync` and `talk-ideas` gained a
  trigger they never had.

  Three CI gates keep it that way: shipped skills must lint clean (no errors _and_
  no warnings), must describe when to use them, and must stay within the
  specification's 1024-character cap.

- fc79a8f: Give the `sync` skill explicit autonomy rules

  A sync is frequently unattended — on a schedule, from a container, or through an
  agent runner with nobody watching. The skill did not say so, and an agent
  applying its default caution would enter a plan-and-approve mode or stop to ask
  a question, which in that setting means the sync simply never happens.

  Adds an "Autonomy — no plans, no approval" section: never plan, never ask, take
  the defined conservative default and report what was decided. It also names the
  leftover repo state a previous interrupted run can leave behind — stale unmerged
  index entries, stale `AUTO_MERGE` refs, autostash entries — as part of the job
  rather than a reason to stop, and limits the allowed leftovers to genuinely
  unresolvable items (malformed stash entries, binary conflicts, files over 100KB).

  The rules hold in an interactive session too: every decision in the skill already
  has a conservative default, so there is nothing worth stopping to ask about. This
  is consistent with the rest of the skill, which warns, flags and reports but
  never asks.

### Patch Changes

- Updated dependencies [50f6ec7]
  - @schlessera/brain-render-template@0.10.0

## 0.9.0

## 0.8.0

## 0.7.2

## 0.7.1

## 0.7.0

### Minor Changes

- b8cbf72: Knowledge-graph view: `brain graph` command and schema-v8 derived tables
  (metrics, communities, root distances, precomputed ForceAtlas2 layout) built
  at index time; `/api/graph/*` REST endpoints served from read-only brain.db
  access; a full-screen GraphPage with Clusters, Discovery, Local, and
  Maintenance modes rendered via a lazy-loaded sigma.js WebGL canvas.

## 0.6.3

## 0.6.2

## 0.6.1

### Patch Changes

- 89d8a72: Fixed: vector search silently degrading to FTS-only on a brain whose stored
  embedding identity predates provider namespacing.

  `index_metadata.embedding_model` is compared against the configured provider's
  id. The schema-v3 migration seeds that key with the bare model name from
  models.ts (`gemini-embedding-2`) — a guess, not a record of what produced the
  vectors — while providers report a namespaced id (`gemini:gemini-embedding-2`).
  The two can never compare equal, so `hybridSearch` skipped vector search on
  every query and reported "stored vectors were produced by ... run 'brain index
  --embeddings' to rebuild them".

  The state was self-locking: `brain index --embeddings` read the same mismatch
  and refused to re-embed without `--force`, and `--force` bills a full paid
  re-embed of the corpus to correct what is only a naming difference.

  `embeddingIdentityMatches()` now backs all three comparison sites (search
  engine, indexer guard, doctor): exact match, or a bare stored value that equals
  the model half of the current id. Two namespaced ids must still match exactly,
  so `openai:some-model` is never mistaken for `gemini:some-model`. The indexer
  rewrites the metadata to the namespaced form on its next run, so an affected
  brain heals itself once — with no re-embedding.

## 0.6.0

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.0

### Minor Changes

- 9e4668b: Add deterministic OKF v0.1 bundle export and conformance checking commands.

### Patch Changes

- e08752c: Fix three issues surfaced by migrating a real brain repo onto the published packages.

  - **User `classifierHints` no longer vanish when a module claims the same type.**
    `configuration.md` promises "modules contribute theirs; yours layer on top", but
    the first source to mention a type won outright — so enabling
    `@schlessera/brain-module-speaking` silently discarded a user's own `conference`
    vocabulary. Sources now accumulate per type; rule order still follows first
    appearance, which is what a module's position in `modules` expresses.
  - **`brain doctor` reported "no vectors stored" for healthy indexes.** The embeddings
    check counted rows in `vec_chunks` without loading sqlite-vec into that connection,
    so every query threw and the count read as zero. It now loads the extension at the
    dimension the index was built with, and distinguishes "extension unavailable" from
    "genuinely empty".
  - **Export `rerank` / `getDefaultRerankerMode`.** A retrieval-quality harness can now
    score rerank-on and rerank-off orderings from one candidate list instead of
    re-embedding the query for each variant.

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.

## 0.2.0

### Minor Changes

- rename brainform to brain-kit
