# 05 — Migration: Alain's Brain onto the Extracted Packages

Status: approved plan · Date: 2026-07-12 · Prereq reading: 00-overview.md, 01-core-architecture.md

Constraints: the brain is Alain's daily driver; brain-ui consumes its CLI `--json` + brain.db per `/home/alain/brain/scripts/INTEGRATION.md`, which must hold at every step. Master safety property: **markdown is the source of truth — brain.db is always regenerable via `brain index --force`**. Order confirmed: config extraction in place first, package extraction second.

## Phase 1 — brain.config in place (his repo, scripts/ stays vendored)

Work:
- Add `scripts/lib/config.ts` + zod schema + root `brain.config.ts` encoding current behavior **exactly**.
- Create `scripts/lib/taxonomy.ts` collapsing the three duplicated maps (`ingestion.ts:34-50`, `auditor.ts:21-36`, `incremental-indexer.ts:53-63`).
- Refactor consumers to read config: types.ts, ingestion.ts, auditor.ts, incremental-indexer.ts, context-assembler.ts (`:68,:76`), brain-cli.ts (`:103` header, `:338` briefing), finance.ts, jobs/, refresh-catalog.ts.

Verification gate:
- Snapshot `brain audit --json`, `brain search <5 goldens> --json`, `brain briefing`, `brain stats` before/after → **byte-for-byte diff**.
- Full test suite + retrieval eval (`bun test && bun run eval`). Pre-commit hooks already force tests+typecheck on scripts/ changes.

Rollback: plain git revert; no db/schema change.

## Phase 2 — module boundaries + core seams (still vendored)

Work:
- Command-registry refactor of `brain-cli.ts` (976-line switch at `:913` → registry).
- Introduce `defineModule`; move `scripts/jobs/`, finance, speaking taxonomy/skills into `scripts/modules/{jobs,finance,speaking}/` loaded from brain.config.
- Port sync-skills into `brain skills sync` (hook becomes thin caller).
- LLM seams (04 §1): trim EmbeddingProvider, extract `enrichment.ts`, introduce CompletionProvider (pi-ai-backed) + AgentRunner; migrate whatsup/agent-commands.

Contract caution: INTEGRATION.md names `scripts/jobs/cli.ts` as a cron surface (brain-ui container crontab calls it). Keep a forwarding shim at that path OR update brain-ui's crontab in the same window with a `CONTRACT:` commit. CLI/MCP surfaces otherwise unchanged.

Rollback: git revert.

## Phase 3 — extract monorepo + genericize (his repo untouched)

Work: create `schlessera/brainform` with **fresh git history** (git-filter-repo rejected — personal strings pervade scripts/ history: names, client slugs, eval queries). Build packages, fixture corpus, contract tests, genericized modules/skills, template repo, onboarding primitives + skills, `/new-module`, `module lint`. CI leakage-grep gate from day one.

Risk control: declare a feature-freeze on `scripts/` in his repo during this window (or mirror changes manually); keep the window ≤2–3 weeks.

## Phase 4 — switch his brain to the packages

On a branch:
- Add `@brainform/*` deps (via `github:`/`file:` first, npm once published); delete vendored duplicates.
- Keep: `brain.config.ts` (his personal values = the **only** personal artifact), `.agents/skills/` personal skills + overrides (plan-travel variant, linkedin skills, use-repo, send-to-tickitoff…), consumer tests + eval, `./modules/catalog` (local module).

Merge gate (all must pass):
1. `brain index --force` → schema_version 7 db with identical doc/chunk counts.
2. Snapshot-diff of search/audit/briefing JSON vs pre-switch.
3. MCP `tools/list` identical.
4. brain-ui contract test green against the branch checkout.
5. Hooks fire (`skills sync` regenerates `.claude/skills/` symlinks); `~/.local/bin/brain` resolves.
6. `bun test && bun run eval` green (consumer tests).

Rollback: revert the merge — vendored scripts return from git history; regenerate db. Sidecar caches (`.context-cache.jsonl`, `.asset-cache.jsonl`) are content-hash-keyed and survive both directions.

## Ongoing (post-switch)

- His upgrade ritual for any `@brainform/*` bump: read CHANGELOG → `bun update` → `bun test && bun run eval` → `brain doctor`.
- The brain-ui container (`/data/brain`) follows the same switch once phase 5 lands; its cron entries regenerate from module manifests.

## Risks

- Behavior drift during genericization → byte-diff snapshots + consumer tests as the gate.
- Genericized skills worse for Alain → local-overlay precedence keeps his variants.
- Dual-maintenance drift in phase 3 → freeze window.
- Contract breaks for brain-ui → `CONTRACT:` commits + contract test in core CI + the jobs-cli shim.
