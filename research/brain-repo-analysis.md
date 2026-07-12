# Research: brain repo coupling analysis

Source: read-only exploration of `/home/alain/brain`, 2026-07-12. All file:line references verified on that date. Root resolution: `BRAIN_ROOT` env or `../..` from `scripts/lib/types.ts:3`.

## 1. Infrastructure inventory (`scripts/`)

**Entry points**: `brain-cli.ts` (976 lines — dispatch switch at `:913-961`: search, context, read, list, briefing, add, index, validate, audit, process, archive, accept-mtime, maintain, stats, finance, sync; exports `generateBriefing()` `:328-433`; JSON/human output auto-switch on TTY `:26-40`); `mcp-server.ts` (623 lines, 8 stdio tools `brain_search|context|read|list|graph|add|update|archive`, `:132-583`); `index.ts`, `search.ts`, `validate.ts` (273); `whatsup.ts` (351, briefing via Anthropic API default, `--claude/--codex/--gemini` alternates) + `whatsup.sh` (hardcodes `/home/alain/brain` at `:7` — only absolute path found); `refresh-catalog.ts` (195, GitHub catalog via `gh`); `sync.sh`.

**`scripts/lib/`**: `types.ts` (135 — taxonomy hub, see §2); `db.ts` (343 — SCHEMA_VERSION 7 at `:5`, migrations, sqlite-vec init; tables: documents, tags, document_tags, links, chunks, documents_fts FTS5, vec_chunks vec0); `incremental-indexer.ts` (1281 — scan/hash/chunk/embed, wiki-link extraction+resolution, sidecar cache management); `search-engine.ts` (403 — FTS5 bm25 weights title5/summary3/content1/tags2 at `:124`, vector KNN, RRF hybrid; **fully generic**); `embedder.ts` (307 — Gemini `gemini-embedding-2`, vision descriptions, contextual-retrieval chunk contexts; GEMINI_API_KEY-gated `:22-24`; prompts at `:189, 282-287`; retry/backoff `:37-73`); `chunker.ts` (182), `reranker.ts` (143), `context-assembler.ts` (101), `frontmatter.ts` (44 — date-safe YAML serializer, worth keeping), `models.ts` (15), `safe-path.ts` (26), `archiver.ts` (73), `ingestion.ts` (274), `auditor.ts` (334), `agent-commands.ts` (362 — spawns `claude --print`, `:25`, `:199-211`), `finance.ts` (540 — AR engine).

**`scripts/jobs/`**: self-contained scraping subsystem, own gitignored jobs.db — cli.ts (623), scrape.ts, browser-scrape.ts, score.ts (485), dedup.ts, db.ts, review.ts, interactive-review.ts, salary.ts, 11 adapters over `adapters/base.ts` (dice, remoteok, remotive, weworkremotely, nodesk, jobgether, simplyhired, workingnomads, remotelyde, remoteineurope, builtin). Docs: `jobs/README.md`, `jobs/docs/index.md` (42 sites).

**`scripts/hooks/`**: pre-commit (validate always; tests+typecheck when tooling changed; `BRAIN_SKIP_HOOKS=1` bypass), post-commit (background incremental index), post-checkout/post-merge (sync-skills + index), sync-skills (symlink installer: `PATH_LINKS` map → `~/.local/bin/{brain,whatsup,sync}` at `:61-65`; `.agents/skills/*` → `.claude/skills/*` relative links + stale pruning `:103-136`; Windows `mklink /J` fallback).

**`scripts/tests/`**: frontmatter, chunker, reranker, wikilinks, incremental-indexer, search-golden, jobs-{dedup,salary,fts,score}. `scripts/eval/`: run.ts + queries.jsonl.

**package.json**: name `"brain"`, description names Alain. Scripts: index/eval/search/validate/test/typecheck/mcp/brain/setup. Deps: `@google/genai`, `@modelcontextprotocol/sdk`, `gray-matter`, `playwright`, `pptxgenjs`, `sharp`, `sqlite-vec`. Runtime Bun (`bun:sqlite`, `Bun.Glob`, `Bun.spawn`).

**`scripts/INTEGRATION.md`** (stable contract; consumers: brain-ui client, Claude Code MCP, cron container): CLI JSON-when-non-TTY, exit codes 0/1/2, stable `--json` shapes (search = `{results, warnings}` since 2026-07-03; audit, context, briefing, index), 8 MCP tools with annotations, brain.db read contract (check `index_metadata.schema_version`=7, open read-only, never write — markdown is source of truth), file-layer contracts (frontmatter schema, notes/ = inbox, committed sidecars `.context-cache.jsonl`/`.asset-cache.jsonl` machine-managed union-merge, jobs.db container-only), recommends consumers keep a live contract test (`:82-86`), `CONTRACT:` commit prefix (`:4-6`). Warnings envelope documented `:27-31` (also `search-engine.ts:350`).

## 2. Personal coupling (the split blockers)

**Taxonomy as TS literals**:
- `types.ts:6-10` — `VALID_TYPES` = identity, career, expertise, project, talk, network, opinion, context, index, note, strategy, infrastructure, conference, travel, finance. `DocumentType` = compile-time union (`:15`).
- `types.ts:19` EXCLUDED_DIRS (scripts, .git, node_modules, .claude, .agents, logs, tmp, workspaces); `:20` EXCLUDED_FILES (CLAUDE.md, README.md); `:23` EXCLUDED_SEGMENTS (alt-decks, versions, deck).

**Three unsynchronized type→dir maps**:
- `ingestion.ts:34-50` TYPE_DIRECTORIES (identity→me, project→projects/active, finance→clients, strategy→content-strategy, …)
- `auditor.ts:21-36` TYPE_DIR_MAP (same idea, incl. infrastructure→infrastructure/+home/)
- `incremental-indexer.ts:53-63` inferAssetType() (me/→identity, talks/→talk, …)

**Other scattered constants**: `indexer:68-85` deriveAssetTitle (me/media-kit/photography, talks/{slug}/slides, career/→"CV"); `indexer:160` DIR_ANCHORS = [_index.md, status.md, itinerary.md, outline.md]; `auditor.ts:13-16` staleness (context/ 30d, projects/active/ 90d); `auditor.ts:101-123` FACTS.md bio-propagation check (me/bios/FACTS.md → me/bios/*); `auditor.ts:130-159` _index lag rule; `:261-267` orphan exclusions for index/context/strategy; `ingestion.ts:30-31,89-90` classifier regexes with personal vocab (CONFERENCE_MARKERS incl. `wordcamp|cloudfest`); `context-assembler.ts:68,76` hardcodes me/identity.md + context/current-focus.md; `brain-cli.ts:338,346-350` generateBriefing anchors on current-focus.md + its link graph; `brain-cli.ts:103` help header names Alain.

**Feature modules**: `finance.ts:17` CLIENTS_DIR="clients", `:27` FEE_TOLERANCE, Wise/Revolut comments `:52-55,459`; `jobs/score.ts:5-9,138-232` keyword lists tuned to his search criteria; `refresh-catalog.ts:22,26-33` CATALOG_DIR + DEFAULT_OWNERS (schlessera, brightnucleus, mwpd, php-composter, authority-kit, enki-forge; `--owners=` override).

**Tests referencing personal corpus**: `search-golden.test.ts:12-16` (Carole Olinger, Buffy, identity.md, writing-style.md, current-focus.md; FTS-only/keyless pattern at `:8-10`); `wikilinks.test.ts:27-101` (talks/the-agentic-stack, career/opportunities/{a-team,vercel}); `eval/queries.jsonl` (Radia Perlman, Piotr Bochenek, Casa Camper, TickItOff, WP-CLI, Speedport); `incremental-indexer.test.ts:147-148` (me/, opinions/ fixtures).

**Committed sidecar caches LEAK content**: `.context-cache.jsonl` (822 KB, committed, NOT gitignored — {k: sha256, v: LLM context blurb}; samples describe real job analyses); `.asset-cache.jsonl` (38 KB — vision descriptions of real slides). Machine-managed per INTEGRATION.md `:74-77`, rebuildable from brain.db; template must ship them EMPTY. brain.db (46 MB) + jobs.db gitignored.

**Generic (no personal coupling)**: search-engine, chunker, reranker, db, embedder (minus prompts), frontmatter, safe-path, archiver.

## 3. Skills inventory (`.agents/skills/`, 22 skills)

Format: SKILL.md with `name:` + `description:` frontmatter (only Claude Code requirements); some add `disable-model-invocation` (3), `argument-hint` (2), `allowed-tools` (2). Bodies = markdown playbooks; some bundle templates/ or scripts/. `skills-lock.json` tracks 5 externally-sourced skills by github source+hash. Claude-only body references are rare: `use-repo/SKILL.md:3`, `content-hygiene/SKILL.md:260`, `sync/SKILL.md:201`; none reference AskUserQuestion.

Classification:
- *Generic infra*: use-repo (default org schlessera = only personal bit), find-skills, generate-pdf, nano-banana-2, send-to-tickitoff, sync.
- *Between*: content-hygiene (generic engine, assumes canonical files), whatsup.
- *Personal-workflow*: conference pipeline (conference-research, brainstorm-talks, talk-ideas, new-submission, submission-outcome, talk-prep, conference-aftermath), LinkedIn (linkedin-post, linkedin-audit, publish-post), job search (research-opportunity, interview-scheduled, jobs-review), travel (plan-travel — hardcodes "Alain + Carole + Buffy", reads me/family/buffy.md).

## 4. Config surface today

- Only knob: `BRAIN_ROOT` (`types.ts:3`).
- Env consumed: GEMINI_API_KEY (embedder `:23,99`), GOOGLE_API_KEY (unset-to-suppress hack `:108`), ANTHROPIC_API_KEY (whatsup), BRAIN_RERANK_MODE, CHROME_CDP_URL + JOBS_PROXY (jobs), BRAIN_SKIP_HOOKS, XDG_BIN_HOME/HOME. GITHUB_TOKEN via `gh` + credential helper only.
- Root `.env` gitignored; Bun auto-loads. No config-file schema exists.
- Setup after clone: `bun install`, `git config core.hooksPath scripts/hooks`, `scripts/hooks/sync-skills`; MCP registered manually in `~/.claude/mcp.json`.

## 5. Content inventory (~503 md files, 23 _index.md)

| Dir | .md | Notes |
|---|---|---|
| me/ | 34 (+15 assets) | me/bios/FACTS.md canonical |
| career/ | 175 (+5) | largest; opportunities/{slug}/ pipeline |
| expertise/ | 12 | |
| projects/ | 50 | catalog/ machine-generated from GH |
| talks/ | 104 (+106 slide assets) | |
| conferences/ | 55 | |
| travel/ | 9 (+3) | |
| network/ | 16 | incl. linkedin/ |
| opinions/ | 7 | |
| context/ | 9 | hygiene/ = skill-generated |
| content-strategy/ | 4 | |
| clients/ | 3 | finance-generated blocks |
| infrastructure/ | 4 | |
| home/ | 10 | |
| notes/ | 9 | inbox + exports/ |

`_index.md` structure: frontmatter type index + Purpose blurb + registry table with wiki-links. .gitignore: brain.db*, jobs.db*, .env, node_modules, workspaces/*/, catalog/.snapshot.json, talk-deck build dirs, misc personal entries (dsa-prep, ccmux).

## 6. Reuse verdict

**Reusable core**: lib/{db, search-engine, chunker, reranker, embedder, context-assembler, frontmatter, safe-path, archiver, indexer-core, type interfaces}, CLI/MCP/validate/audit engines, hooks, generic skills.
**To parameterize**: VALID_TYPES + three maps + DIR_ANCHORS + staleness + propagation + classifier markers → one config; finance/jobs/catalog → modules; CLI header; whatsup.sh path.
**To exclude/replace**: all content dirs, CLAUDE.md, personal skills, personal tests/eval, sidecar cache contents.
