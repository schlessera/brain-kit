# brainform — Implementation Progress

Live tracker for multi-session implementation. Update after every meaningful unit of work.
Plans live in `plan/` (locked decisions in `plan/00-overview.md`); verified research in `research/`.

## Ground rules (from user, 2026-07-12)

- Commit + push freely in `schlessera/brainform` (this repo).
- Changes to `schlessera/brain` (`~/brain`): **pull requests only, never merge** — Alain reviews.
- Verify technical decisions online first; do not trust training data.
- Test and verify everything whenever possible.
- Refine plans as progress reveals better options; record deviations here and in the plan docs.

## Repo layout note

This repo is becoming the brainform monorepo (plan/01 §1 topology). `plan/` and `research/`
intentionally contain personal strings (they document the scrub); the leakage grep gate must
exclude them. At launch the public repo is cut with fresh history WITHOUT plan/ + research/
(plan/06 publishing checklist).

## Status board

| # | Workstream | Status | Notes |
|---|---|---|---|
| 0 | Online verification (pi SDK, npm, tooling) | **done** | research/tooling-versions.md + pi-omp.md update |
| 1 | Repo housekeeping (README, AGENTS.md, PROGRESS.md) | **done** | |
| 2 | Monorepo scaffold (workspaces, tsconfig) | **done** | hoisted linker forced (bunfig.toml) |
| 3 | Core: config system + taxonomy resolver | **done** | replaces the three type→dir maps; 22 tests |
| 4 | Core: generic libs port | **done** | db/search/chunker/frontmatter/reranker/safe-path/context-assembler/archiver + LLM seam layer |
| 5 | Core: indexer/ingestion/auditor/validate genericized | **done** | provider-swap force-gated; trailing-slash dir links added |
| 6 | Core: CLI registry + commands + MCP server | **done** | registry + 22 core commands + 8 MCP tools; cli/mcp contract tests green |
| 7 | Module system + jobs/speaking/finance packages | **done** | 207 pkg tests; criteria-driven jobs scoring |
| 8 | Skills: sync + emitters + hooks + core suite + lint | **done** | 12 core skills + 8 speaking skills |
| 9 | Onboarding primitives (setup/doctor/init/import/lint) | **done** | setup/doctor(11 checks)/init/import/skills/module/config; onboarding tests green |
| 10 | Fixture corpus + contract tests + CI + leakage grep | **done** | CLI/MCP/onboarding contract tests keyless; extended sweep procedure |
| 11 | Docs + CONTRACT.md + template content | **done** | 13 docs incl. cli.md/mcp.md written from the implemented surface |
| 12 | brain repo PR: phase 1 (config in place) | **done — awaiting Alain's review** | schlessera/brain PR #1, byte-diff gate passed, NOT merged |
| 13 | brain-ui generalization (phase 5) | in progress | see phase-5 board below |

## Phase-5 board (brain-ui, started session 1 continuation 2026-07-12)

| # | Workstream | Status | Notes |
|---|---|---|---|
| P5.0 | UI-stack research (Claude Agent SDK, Bun.password, hono, Deepgram, pi session APIs) | in progress | ui-research agent |
| P5.1 | @brainform/ui-sdk (protocol + AgentBackend/SpeechProvider + client registries) | **done** | protocol ported with vendor-hint cleanup; startTurn contract; 10 tests |
| P5.2 | @brainform/ui-backend-claude | **done** | SDK ^0.3.207 (verified superset); per-turn closures replace handler singletons; 25 tests |
| P5.3 | @brainform/ui-backend-pi | **done** | curated 9-tool surface, in-tool permission gate, extensions off; 33 tests |
| P5.4 | Backend contract test (both backends, one suite) | **done** | 12/12 on both — identical startTurn semantics proven |
| P5.5 | brain-ui PR (auth, same-origin, backend seam, voice session, scrub, compose, CI) | **done — awaiting Alain's review** | schlessera/brain-ui PR #2, NOT merged; main untouched |
| P5.6 | @brainform/ui-backend-gemini | **removed 2026-07-30** | `58cd846` — dishonest capability flag; see the deviation note below |

## Parallel sessions (user-approved plan, session 1 continuation 2026-07-12)

Decisions (all four confirmed by Alain): multiplexed single socket with additive sessionId
frames; advisory write mutex; MAX_CONCURRENT_SESSIONS=3 deploy-time env; follow-up queueing
exposed as a backend capability (pi native via prompt streamingBehavior "followUp", claude
host-queued).

| Piece | Status |
|---|---|
| ui-sdk protocol rev 2 (SessionScoped frames, cancel sessionId, status queued) | **done** |
| AgentBackend contract v2 (per-session busy, concurrentSessions/followUp caps, followUp()) | **done** |
| createWriteLock (FIFO mutex; mutating tools serialize across sessions) | **done** |
| claude backend: session map, scoped frames, writeLock at approval→tool_result window | **done** |
| pi backend: per-session tools (shared TurnContext eliminated), native followUp, writeLock | **done** |
| rev-2 cross-backend contract suite (resume-collision busy, parallel sessions, scoped frames) | **done** |
| brain-ui PR #2 follow-up commits (host turn map, cap, queue, client demux) | **done — on PR #2** |
| brain repo | no changes needed — analysis posted as comment on PR #1 |

Parallel-sessions delivery notes (PR #2, commits dd14592 + e28d292; independently verified:
branch typechecks clean, main untouched):
- Host: per-session turn slots with own AbortController+timeout; MAX_CONCURRENT_SESSIONS
  (default 3) → SESSION_LIMIT error frame; cancel honors sessionId (ambiguous → error);
  follow-up = backend.followUp() when capable, else host queue (cap 5) with status:queued.
- Client: frame demux by sessionId; background frames update run-state badges; composer
  sends follow-ups mid-stream with a capability-driven "Follows up live"/"Will queue" hint.
- Known v1 limitations (documented in PR body): switching to a running background session
  re-syncs its transcript from the server (session_resume) instead of keeping full live
  client-side buffers — candidate follow-up for perfectly instant switches; narrow race
  when starting a brand-new conversation while another streams (active-id transition).

### Deviation — the native Gemini backend was dropped (2026-07-17)

Recorded per the ground rule above. brain-ui removed `@brainform/ui-backend-gemini`
from its registry and dependency graph (`c7c3491`, plus migration
`004_drop_gemini_backend.sql` rewriting `backend_id='gemini'` rows to NULL). The
decision was locked with Alain during the phase-5 hardening pass; the reasoning is
recorded in `brain-ui/docs/reviews/phase-5-hardening.md`:

- The hand-rolled loop re-implemented, by hand, contracts the Claude Agent SDK
  provides for free — history merging, context compaction, safety-block filtering,
  abort unwinding, write serialization, interactive-id uniqueness. Each omission was
  a separate bug; it was also the one backend excluded from the contract suite. One
  architectural gap with seven exits, not seven unrelated defects.
- It carried a live privacy egress: session transcripts and photos written under the
  brain repo and picked up by the nightly auto-push. (Verified never to have fired.)
- `capabilities.permissions: true` with a no-op gate contradicted SECURITY.md and the
  capability's own contract. `dd93085` documented the auto-execute instead of gating
  it, which left the flag flatly false rather than fixing it.
- Gemini through OpenRouter via the Claude backend is a dead end (the Agent SDK
  force-sends `anthropic-beta: context-management-*`, which OpenRouter 400s for
  non-Anthropic models) — that dead end is *why* the native backend existed.

Consequences for this repo, still open:

- `packages/ui-backend-gemini/` was REMOVED in phase 1 (`58cd846`). plan/07 §3 listed it
  as "gemini only after the permission fix"; that target was void once brain-ui unwired
  it, and it advertised `permissions: true` over a no-op gate. Core's `@google/genai`
  became an optional peer dependency in the same phase (`c644e89`).
- Future multi-model support is **one generic OpenAI-compatible OpenRouter backend**,
  not per-vendor hand-rolled loops. Any plan/03 or plan/07 language implying a
  per-vendor backend family should be read through this decision.

Phase-5 additional decisions:
- pi listProfiles has NO ModelRegistry fallback (would list ~1700 models with an OpenRouter
  key — env-dependent and unusable as a picker). Profiles are explicit configuration; ad-hoc
  "vendor/modelId" profileIds still resolve.
- Both backends expose @internal injection seams (queryFn / sessionFactory) so the contract
  suite drives real startTurn paths keylessly.
- Gemini's raw model SDK has no agent loop or transcript manager, so ui-backend-gemini owns
  both: raw Content[] (including thoughtSignature metadata) is persisted beside incrementally
  normalized wire history. Function responses use the SDK-verified `user` Content role.

Phase-5 design decisions:
- The wire protocol is published from @brainform/ui-sdk/protocol; brain-ui's shared/ becomes a
  re-export shim (its client keeps compiling unchanged).
- AgentBackend.cancel() from the plan sketch dropped — one cancellation mechanism only
  (host-owned AbortSignal in StartTurnRequest); host owns timeouts too.
- startTurn error semantics: runtime failures are EMITTED as protocol error frames and the
  promise resolves; rejections are reserved for caller errors (BackendBusyError on concurrent
  turns — the old SESSION_BUSY error frame becomes host-side queueing; BackendRequestError for
  unknown profile / unsupported resume).
- Wire field `providerId` kept for client compat; server-side it is the opaque `profileId`.
- brain-ui PR dependency strategy: depends on @brainform/ui-sdk + backends by npm version
  (unpublished until launch); local dev via package.json overrides to file:../brainform paths,
  documented in the PR body.

## Plan deviations / decisions made during implementation

- 2026-07-12: Build order adapted — brainform monorepo built directly from a genericized copy
  of `~/brain/scripts` (phase-3 style), rather than doing phase 1–2 inside the brain repo first.
  Reason: user prioritized brainform completeness; brain repo receives phase-1 PR separately
  (unmerged, review-gated), so his daily driver is never at risk. Drift risk handled by
  building core first, then deriving the brain PR from the same taxonomy/config shapes.
- 2026-07-12: **pi-ai has no embeddings API** (verified from 0.80.6 tarballs) → plan/00 open
  item resolved: EmbeddingProvider built-ins stay hand-rolled (gemini #1). pi-ai remains the
  planned foundation for a completions provider + ui-backend-pi; pins 0.80.6 (all three pkgs).
  Details appended to research/pi-omp.md.
- 2026-07-12: TypeScript pinned ^6.0.3 (not researcher-suggested 5.9.3, not 7.x): 6.0.3 is
  proven in the reference brain repo and this monorepo, and we ship TS source (no .d.ts emit),
  so TS7-emit concerns don't apply. All other pins per research/tooling-versions.md.
- 2026-07-12: playwright/sharp/pptxgenjs NOT needed by any ported code (verified by grep —
  jobs browser-scrape uses raw CDP over HTTP; those deps serve personal skills only). Module
  packages stay dependency-lean; plan/01's "playwright → module-jobs" is obsolete.
- 2026-07-12: archiver/ingestion decouple from the indexer via an injected `reindex` hook
  (CLI wires indexAll in) — removes a hard import cycle, behavior identical.
- 2026-07-12: Extended leak sweep instituted (user directive: nothing personal may cross
  over from schlessera/brain). Procedure documented in AGENTS.md — patterns re-derived
  from ~/brain each run, never committed here. First run caught and fixed two leaks that
  the 5-name CI gate could not see (a personal talk slug in taxonomy.test.ts, an
  opportunity slug in fixtures/README.md). Sweep is a mandatory step when accepting any
  agent-ported code and a release gate before the public cut.

## Session log

### Session 1 — 2026-07-12

- Read all plan/research docs; environment recon (bun 1.3.14, gh authed, both repos reachable).
- Research agents returned verified reports → research/tooling-versions.md + pi-omp.md update.
  npm names free; brainform-template repo must be created at launch; changesets needs the
  bun-publish workaround; macOS sqlite-vec needs a doctor check (setCustomSQLite).
- Housekeeping: PROGRESS.md, README.md rewrite, AGENTS.md, .gitignore.
- Monorepo scaffold + config system + taxonomy resolver + module loader + context (22 tests).
- CONTRACT.md, docs/integration-contract.md, SECURITY.md, CONTRIBUTING.md, CHANGELOG.md.
- Wave-1 build agents dispatched: libs-porter (generic libs), llm-porter (providers/enrichment/
  registry), skills-porter (sync/emitters/lint/hooks), template-builder, fixtures-builder.
- Wave 2: indexer-porter (indexer/ingestion/auditor/validate), modules-builder (3 packages via
  forks), core-skills-author (12 skills), cli-builder (CLI+MCP+onboarding), docs-writer.
- All monorepo workstreams landed: 233 tests green keyless, strict tsc clean, CI green.
- Found + fixed driving the real funnel: init --default now writes dependency-free
  brain.config.json (the .ts starter broke Tier-0 in a bare dir).
- **Lesson recorded**: `grep … || echo CLEAN` conflates "no match" with "grep error" — a
  clobbered pattern file (shared scratchpad) produced a FALSE clean sweep once. Sweeps must
  check grep's exit code explicitly (1 = clean, 0 = hits, ≥2 = error) and use a
  session-unique pattern filename.
- brain-pr-builder still running: phase-1 config PR in ~/brain (branch brainform/phase-1-config).

- brain PR opened + verified: schlessera/brain #1 (branch brainform/phase-1-config, 11 files,
  +666/−159). Gate evidence: audit/briefing/stats byte-identical; 5 golden searches identical
  except documented Gemini score float jitter (~1e-7, present on same-commit reruns too);
  old-vs-new asset type/title diffed over all 73 real assets → 0 diffs; tests/typecheck/eval
  green; main untouched. Deferred to phase 2 (documented in the PR): generic propagation
  consumer (his me/bios check is recursive; the `me/bios/*.md` glob would not be
  byte-faithful), finance/jobs/refresh-catalog consumers.

### Session 2 — 2026-07-16

- Added `@brainform/ui-backend-gemini`, pinned to npm-latest `@google/genai` 2.12.0.
- Implemented Gemini streaming → scoped wire frames, a 20-step function-calling loop, the
  curated gated brain tools, per-session busy/LRU state, image input, and abort semantics.
- Added atomic JSON-per-session persistence with raw model Content[] plus normalized history;
  verified the SDK's JSON-schema field, function-response role, call ids, and thought
  signatures in installed declarations/implementation and official docs.
- `bun install`, 3 keyless session-store tests, root `tsc --noEmit`, and diff checks pass.

### Session 3 — 2026-07-17/18

- Two review passes landed as `plan/07-oss-readiness-review.md` (four independent passes:
  two Fable 5, one gpt-5.6-sol via codex, one web-research) and
  `plan/08-package-split-review.md` (five passes, focused on the split goal). Verdict:
  architecture endorsed unanimously, shipping trees clean of personal data, git history
  confirmed unpublishable → fresh-history cut is mandatory. Nothing on the 07 blocker list
  was fixed as of the 08 pass; two new HIGH findings surfaced (Claude WriteLock inert under
  default allowlists; capability honesty).
- `plan/08-name-research.md` records the rename hunt — "brainform" is burned
  (brainform.ai is an active startup in the adjacent agent space, GitHub org taken).
  Vetted shortlist ready, **decision open**: endoxa if typing ergonomics win,
  florilegium if distinctiveness wins. CLI stays `brain` either way.
- Native Gemini backend dropped by the consumer — see the deviation note above.
- Core: `module list --json` now exposes module cron entries (`fd7fa41`); the location
  provider honors the legacy `BRAIN_UI_REVERSE_GEOCODE` name (`b0a650f`).

## Next steps (for a fresh session)

1. Read this file + `plan/00-overview.md` first.
2. Check the status board; pick the lowest unfinished workstream.
3. Research findings land in `research/` — check for updates before re-verifying.
4. `plan/07` §5 and `plan/08` §5 hold the current sequencing; treat `plan/08` as
   authoritative where the two disagree.
5. Open items, in rough order:
   - ~~Fix the blockers while both consumers are still private~~ — **DONE 2026-07-30**,
     merged after two adversarial review rounds. brainform `main` = `ea73e1c`, brain-ui
     `main` = `e0f6ab5`. Full account, including the bugs the review rounds found *in the
     fixes*, in [plan/09-phase-1-handoff.md](plan/09-phase-1-handoff.md).
   - ~~Remove `packages/ui-backend-gemini/`; make `@google/genai` optional~~ — **DONE**
     (`58cd846`, `c644e89`).
   - **Decide the name** (`plan/08-name-research.md`) — now the single blocker on phase 2.
     npm org, GitHub org, and domain all need claiming the same day.
   - **Alain reviews** schlessera/brain PR #1 (phase 1). Phase 2 (module boundaries in his
     repo) only after PR #1 merges. brain-ui PR #2 (phase 5) has landed on brain-ui `main`.
   - **Unverified, carry forward**: rotate the Deepgram key in brain-ui's working-tree .env
     (gitignored, never committed, but live during dev — flagged in PR #2 body); the
     phase-5 GitHub PAT rotation is believed done (the Dockerfile now uses a BuildKit
     secret mount) but was not re-confirmed here.
   - @brainform/* deps are still UNPUBLISHED — brain-ui consumes them via a pinned-SHA
     Docker clone plus `file:../brainform` overrides marked TODO(release). Publishing kills
     that fragility and unblocks the `~/brain` migration (chicken-and-egg: publish first).
   - pi-ai-backed CompletionProvider built-in (factory API, pins 0.80.6).
   - Verify `pi -p`/`gemini -p` runner flags (marked unverified in cli-runners.ts).
   - Release wiring: changesets + per-package bun publish (research/tooling-versions.md);
     claim npm `@brainform` scope + bare name; create schlessera/brainform-template from
     template/ at launch; public cut = fresh history without plan/ research/ PROGRESS.md,
     AGENTS.md rewritten.
   - Known cosmetic wart: read-only sqlite-vec probe prints a stderr warning on fresh
     keyless brains (harmless, ported behavior).
