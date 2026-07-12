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
| 0 | Online verification (pi SDK, npm, tooling) | in progress | research agents dispatched 2026-07-12 |
| 1 | Repo housekeeping (README, AGENTS.md, PROGRESS.md) | in progress | |
| 2 | Monorepo scaffold (workspaces, tsconfig) | pending | |
| 3 | Core: config system + taxonomy resolver | pending | |
| 4 | Core: generic libs port | pending | |
| 5 | Core: indexer/ingestion/auditor/validate genericized | pending | |
| 6 | Core: CLI registry + commands + MCP server | pending | |
| 7 | Module system + jobs/speaking/finance packages | pending | |
| 8 | Skills: sync + emitters + hooks + core suite + lint | pending | |
| 9 | Onboarding primitives (setup/doctor/init/import/lint) | pending | |
| 10 | Fixture corpus + contract tests + CI + leakage grep | pending | |
| 11 | Docs + CONTRACT.md + template content | pending | |
| 12 | brain repo PR: phase 1 (config in place) | pending | PR only, no merge |
| 13 | brain-ui generalization (phase 5) | not started | separate repo, later sessions |

## Plan deviations / decisions made during implementation

- 2026-07-12: Build order adapted — brainform monorepo built directly from a genericized copy
  of `~/brain/scripts` (phase-3 style), rather than doing phase 1–2 inside the brain repo first.
  Reason: user prioritized brainform completeness; brain repo receives phase-1 PR separately
  (unmerged, review-gated), so his daily driver is never at risk. Drift risk handled by
  building core first, then deriving the brain PR from the same taxonomy/config shapes.

## Session log

### Session 1 — 2026-07-12

- Read all plan/research docs; environment recon (bun 1.3.14, gh authed, both repos reachable).
- Dispatched research agents: pi SDK/pi-ai verification; npm names + tooling versions.
- Housekeeping: PROGRESS.md, README.md rewrite, AGENTS.md, .gitignore.

## Next steps (for a fresh session)

1. Read this file + `plan/00-overview.md` first.
2. Check the status board; pick the lowest unfinished workstream.
3. Research findings land in `research/` — check for updates before re-verifying.
