# AGENTS.md — Working in this repo

brain-kit: a file-first personal knowledge base that a coding agent operates.
This repo is the monorepo behind the `@schlessera/brain-*` packages.

## Read first

1. [README.md](README.md) — what this is and how the packages fit together.
2. [ROADMAP.md](ROADMAP.md) — current state, the decisions that bind new work,
   and what is planned. Read the "What binds future work" section before
   proposing anything structural.
3. [CONTRIBUTING.md](CONTRIBUTING.md) — how to run things and what gets merged.
4. The doc for whatever you touch under [docs/](docs/README.md).

## Hard rules

- **No personal data anywhere in the tree.** No real names, client names, or
  personal infrastructure (IPs, domains, tailnets, deploy identifiers).
  Fixtures and examples use the fictional persona "Alex Example". CI enforces a
  leakage gate over the whole tree; it has no exempt directories.
- **Contract stability.** The CLI `--json` shapes, MCP tool names and schemas,
  `schema_version`, and frontmatter semantics are the compatibility contract
  (`docs/integration-contract.md`). Changing one means updating that doc in the
  same commit, prefixing the commit `CONTRACT:`, and a major-version
  discussion.
- **No new seams.** Extension interfaces exist only where a second
  implementation is plausible within a year. The not-pluggable list in
  `docs/extending/README.md` is final.
- **Markdown is the source of truth; `brain.db` is disposable.** `brain index
  --force` regenerates everything. Never design anything that writes `brain.db`
  as authoritative state.
- **Skills orchestrate, the CLI executes.** Deterministic logic belongs in a
  `brain` subcommand with `--json` output; SKILL.md files hold interview logic
  and judgment only.
- **Verify technical claims against the source** — the npm registry, upstream
  docs, the installed package — before building on them. Do not carry a version
  number or an API shape from memory.

## Conventions

- Runtime: Bun (`bun:sqlite`, `Bun.spawn`, `Bun.Glob`). TypeScript throughout.
  Tests: `bun test`. Typecheck: `tsc --noEmit`.
- Monorepo: Bun workspaces under `packages/`; all `@schlessera/brain-*`
  packages version in lockstep.
- Packages ship both `src/` and a built `dist/` behind conditional exports —
  `bun` resolves source, `types`/`default` resolve the build. Never force a
  condition in a consumer; all three outputs come from the same source.
- No raw control or invisible characters in source — spell them as escape
  sequences. One raw NUL byte makes grep and ripgrep treat the whole file as
  binary, so it vanishes from every search, and an editor that trims
  whitespace silently corrupts a zero-width delimiter. Escaping never changes
  the runtime value, so hashes and wire formats stay put. `bun run lint`
  enforces this; CI runs it as the invisible-character gate.
- Config-driven taxonomy: document types are runtime-validated strings (zod),
  not compile-time unions.
- Modules own content domains (types, skills, one CLI namespace) and are
  declared with `defineModule({ name, configSchema, setup })`. Run
  `brain module lint` before submitting one.

## Testing expectations

- Every library keeps or gains unit tests. Integration tests run against
  `packages/core/fixtures/corpus/` — keyless, deterministic, FTS-only goldens.
  Never add a test that needs an API key or the network.
- Contract tests assert the `--json` envelopes. CI runs typecheck, tests, the
  keyless Tier-0 e2e funnel, a packaging smoke test, and the leakage gate.
- Predicate-only unit tests are not proof for anything with a runtime: the
  renderer's isolation holes were found by launching real Chrome, not by
  testing its allowlist function.

## Releasing

**Load the `release` skill (`.agents/skills/release/`) before doing any of
this.** It is the operational checklist, kept next to the guards that enforce
it (`tests/release-manifest.test.ts`); the notes below and in CONTRIBUTING.md
are the reasoning behind it.

- Full sequence: changeset → `bun run version` → **read the version it
  produced** → `bun run build && bun run typecheck && bun test packages tests`
  → commit `chore: version packages to X.Y.Z` → push → `bun run release`.
- **`bun run version` MUST be followed by `rm bun.lock && bun install` before
  `bun run release`** — `bun run version` chains this for you; doing
  `changeset version` by hand does not. Bun resolves `workspace:*` pins from
  the installed lockfile, and a plain (or `--force`) install does not refresh
  them, so a stale lock publishes manifests pinning the previous,
  never-published version and every package becomes uninstallable. This shipped
  once, in 0.2.0. `scripts/publish.ts` refuses the release if the pins are
  stale.
- **Verify the version changesets produced before publishing.** A minor-only
  changeset has bumped the whole fixed group to a major twice now; the two
  config guards that prevent it are documented in CONTRIBUTING.md and asserted
  by `tests/release-manifest.test.ts`.
- **A new package must be added to `scripts/publish.ts` and `scripts/build.ts`**
  — both drive hardcoded lists, and a package missing from them is silently
  skipped while its dependents ship pinned to a version nobody published.
  Asserted by `tests/release-manifest.test.ts`.
- Publishing needs interactive auth, so the final `bun run release` runs from a
  human's terminal.
