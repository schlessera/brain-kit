# AGENTS.md — Working in this repo

brainform: open-source "DIY brain infra" — a file-first personal knowledge base operated by
coding agents. This repo is the core monorepo (packages) plus the planning docs that drive it.

## Read first, in this order

1. `PROGRESS.md` — live status board, session log, plan deviations. **Update it as you work.**
2. `plan/00-overview.md` — vision, locked decisions, sequencing. Locked decisions are not
   renegotiated mid-implementation; deviations require an explicit entry in PROGRESS.md.
3. The detail doc for whatever you touch (`plan/01`–`06`), and `research/` for verified facts.

## Hard rules

- **`~/brain` (schlessera/brain) is Alain's private daily driver.** Changes there go through
  pull requests only — never merge, never push to main. Every change is gated by byte-diff
  snapshots of `audit/search/briefing/stats --json` (see plan/05).
- **The private brain repo never goes public; public repos get fresh git history at launch.**
- **No personal strings in `packages/`, `docs/`, `template/`, `.github/`**: no
  `alain|schlesser|carole|buffy|wyvern`, no client names, no personal infra (IPs, domains,
  tailnets). Fixtures use the fictional persona "Alex Example". `plan/` and `research/` are
  exempt (they document the scrub and are excluded from the public cut).
- **Verify technical decisions online** (npm registry, upstream docs) before building on them;
  record findings in `research/` with dates and source URLs.
- **Markdown is the source of truth; brain.db is disposable** (`brain index --force`
  regenerates everything). Never design anything that writes brain.db as authoritative state.
- **Contract stability**: CLI bin `brain`, MCP tools `brain_*`, `--json` envelope shapes are
  the compatibility contract (INTEGRATION.md successor). Breaking changes need a `CONTRACT:`
  commit prefix and a major version bump.

## Conventions

- Runtime: Bun (`bun:sqlite`, `Bun.spawn`, `Bun.Glob`). TypeScript, no build step for the CLI
  (bin runs via bun). Tests: `bun test`. Typecheck: `tsc --noEmit`.
- Monorepo: bun workspaces under `packages/`; all `@brainform/*` packages version in lockstep.
- Seams only where a second implementation is plausible within a year (plan/04 §0). The
  explicitly-not-pluggable list (plan/04 §8) is final.
- Skills orchestrate, CLI executes: deterministic logic goes into a `brain` subcommand with
  `--json`; SKILL.md files hold interview logic and judgment only.
- Config-driven taxonomy: document types are `string` validated at runtime (zod), not
  compile-time unions.

## Testing expectations

- Every ported lib keeps or gains unit tests. Integration tests run against
  `packages/core/fixtures/corpus/` (keyless, deterministic, FTS-only goldens).
- Contract tests assert the `--json` envelopes. CI runs typecheck + tests + keyless Tier-0
  e2e + leakage grep.
