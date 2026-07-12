# 00 — Overview: Vision, Decisions, Sequencing

Status: approved plan, pre-implementation · Date: 2026-07-12 · Owner: Alain Schlesser

## Vision

Turn the private brain repo (`/home/alain/brain`) and brain-ui (`/home/alain/dev/brain-ui`) into **brainform**, a shareable open-source system. A stranger clones a template, opens a coding agent, runs `/brain-init`, answers an interview, and ends up with an **individualized directory taxonomy** that works out of the box with:

- the `brain` CLI (index, search, validate, audit, briefing, add, …)
- SQLite hybrid search (FTS5 + sqlite-vec) with optional embeddings
- an MCP server (`brain_*` tools) for any agent session
- workflow skills (core lifecycle + optional modules)
- optionally, a self-hosted brain-ui (PWA chat interface driving an agent over the brain)

The onboarding itself is skill-driven: setup, diagnosis, import, module enablement, and hosting are conversations, not README steps. The long-term architectural goal is **surviving LLM model / inference-provider / agent-SDK shakeups**: every major stack choice sits behind a low-friction seam.

## Locked decisions (user-confirmed 2026-07-12)

1. **Distribution** — versioned core package (npm/bun) + thin GitHub template repo. User repos hold `brain.config.ts` + their content; infra updates arrive via version bump, never via merge.
2. **Dogfooding** — Alain's own brain migrates to consume the OSS core (consumer #1). Phased and rollback-safe; it is his daily driver and brain-ui consumes its CLI/db contract throughout (see 05-migration).
3. **brain-ui ships open-source from day one.**
4. **All workflow modules ship genericized** — jobs, speaking/conference, clients/finance — rethought for general usefulness (not find-replaced), plus modules become a first-class concept with a `/new-module` authoring skill.
5. **Name: `brainform`** — verified free 2026-07-12: npm bare `brainform` (404), scope package `@brainform/core` unpublished, GitHub `schlessera/brainform` free. CLI bin + `brain_*` MCP names stay `brain` (contract stability; bin name is a template concern).
6. **brain-ui auth** — built-in password auth at launch; additionally explore encrypted-at-rest personal data and (honestly-scoped) E2E options (03-brain-ui §3).
7. **License MIT**, both repos. **Repos under `schlessera`.**
8. **Extensibility** — registry-of-built-ins + minimal documented interfaces, only at seams where a second implementation is plausible within a year (embeddings, completions, agent runner, agent backend, STT, tool renderers, skill emitters). Explicitly NOT pluggable: SQLite/FTS5/sqlite-vec index engine, markdown+git source of truth, chunking/ranking pipeline, the wire protocol, Bun/Hono/React stack, `brain` CLI + MCP surface — these are the product.
9. **Upstream pi as provider-agnostic foundation; full OMP not needed** — `@earendil-works/pi-ai` backs the default CompletionProvider; a purpose-built `ui-backend-pi` on the upstream `@earendil-works/pi-coding-agent` SDK is the OSS-default AgentBackend (curated gated tool set, `.agents/skills` discovered natively). Claude Agent SDK backend kept as first-class backend #2 (Anthropic restricts Pro/Max subscription OAuth to Claude Code since 2026-04, so flat-rate economics require it; it is also Alain's driver → both backends get dogfooded). OMP = optional post-v1 backend/CLI-runner and idea source, not a foundation. Full rationale + sources: research/pi-omp.md.

## Guiding principles

- **Skills orchestrate, CLI executes.** Every deterministic check or file operation an onboarding skill needs becomes a versioned `brain` subcommand with `--json` output (added to the integration contract). SKILL.md files hold interview logic and judgment only. This keeps skills short, re-runs reliable, and gives non-agent users a fallback.
- **A seam only where a second implementation is plausible within a year.** Everywhere else, concrete code stays concrete.
- **Markdown is the source of truth; brain.db is disposable.** `brain index --force` regenerates everything. This is the master safety property for migration and the documented upgrade story.
- **Index Sync Principle** (existing brain convention): summary layers (`_index.md`, current-focus) update in the same operation as detail files. Modules must declare their index-sync rules.
- **Fail closed on exposure.** Publicly reachable brain-ui without auth refuses to start; the template pushes `--private` repos; `brain doctor` warns loudly on public remotes.

## Sequencing

| Phase | Deliverable | Where | Detail doc |
|---|---|---|---|
| **0. Scrub prep** (parallel, start now) | Rotate the Deepgram key in brain-ui working-tree `.env`; inventory personal strings; claim npm `@brainform` scope + `brainform` name | brain-ui, npm | 06-launch |
| **1. Config in place** | `brain.config.ts` + zod + `taxonomy.ts` collapsing the three type→dir maps; refactor all consumers. Gate: byte-diff snapshots of `audit/search/briefing/stats --json` before vs after; full tests + eval | Alain's brain (vendored) | 01-core-architecture, 05-migration |
| **2. Module boundaries + core seams** | CLI command registry; `defineModule`; jobs/finance/speaking → `scripts/modules/`; `skills sync`; EmbeddingProvider trim + `enrichment.ts` + CompletionProvider/AgentRunner seams | Alain's brain (vendored) | 01, 04, 05 |
| **3. Extract + genericize** | `schlessera/brainform` monorepo (fresh history); packages, fixture corpus, contract tests, genericized modules/skills, `/new-module`, `module lint`; onboarding CLI primitives + skills; template repo. Freeze window on private scripts/ ≤2–3 weeks | new repos | 01, 02 |
| **4. Switch Alain's brain** | Branch swaps vendored code for `@brainform/*` deps; his `brain.config.ts` = the only personal artifact. Hard merge gate (see 05-migration) | Alain's brain | 05 |
| **5. brain-ui generalization** (parallel to 3, after 0) | Password auth + `x-forwarded-for` fix; same-origin/`ALLOWED_ORIGINS`; vendor-neutral compose; module-driven crontab; ui-sdk extraction (AgentBackend + ui-backend-pi + ui-backend-claude, renderer registry, SpeechProvider); encryption decision doc; `/brain-host`; fresh-history public repo; CI/README/SECURITY.md | brain-ui | 03, 04 |
| **6. Launch polish** | Docs, versioning setup, CI green everywhere, publishing checklist sweep, first tagged release | all | 06 |

## Verification (acceptance tests)

1. **No-regression for Alain** (phases 1–4): snapshot-diff gates; brain-ui daily use uninterrupted; `brain finance`, jobs review, conference skills behave identically.
2. **Stranger test** (phase 6): clean machine with only bun + git + a coding agent — run the documented one-liner, `bun install`, `/brain-init` with a made-up persona whose domains differ from Alain's (e.g. health + studies + hobbies); verify the individualized taxonomy indexes/searches/validates; add a Gemini key → semantic smoke query hits; `/brain-doctor` all green; `/brain-import` an example Obsidian vault; `/brain-host` onto a throwaway VPS → password login → chat round-trip.
3. **Seam proof** (ships in v1): ui-backend-pi AND ui-backend-claude passing the same backend contract test (start turn → tool-approval round-trip → history) + webspeech AsrClient + one non-Gemini embedder + Codex skill-emitter.
4. **Shakeup drill** (doc-level): walk "Anthropic changes SDK terms" and "Gemini embeddings retired" scenarios through the seams; each must resolve to a config change plus at worst one re-embed — never a rewrite.
5. **Leakage**: CI grep gate (`alain|schlesser|carole|buffy|wyvern|<client names>`) + manual sweep on all public trees.

## Open items (defaults chosen; decide during implementation)

- Docker `slim`/`full` image targets — decide when measuring image size in phase 5.
- pi-ai embedding-API support — verify at implementation; determines whether EmbeddingProvider built-ins stay hand-rolled.
- Upstream pi SDK gaps to confirm in a phase-5 spike: attachment/image input, MCP client support, cost/usage reporting (capability flags degrade gracefully if absent).
- Deferred post-v1: travel as standalone module; LinkedIn/content as 4th module; module-contributed MCP tools; per-session backend switching; `bunx create-brainform`; Claude plugin-marketplace channel; an ui-backend-omp adapter; brainform extension on the pi.dev registry; cherry-picking OMP ideas (hash-anchored edits).
