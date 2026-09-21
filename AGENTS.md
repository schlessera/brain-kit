# AGENTS.md — Working in this repo

brain-kit: a file-first personal knowledge base that a coding agent operates.
This repo is the monorepo behind the `@schlessera/brain-*` packages.

## Read first

1. [README.md](README.md) — what this is and how the packages fit together.
2. [ROADMAP.md](ROADMAP.md) — current state and the decisions that bind new
   work. Read "What binds future work" before proposing anything structural.
3. [docs/process/github.md](docs/process/github.md) — where work lives, what the
   labels and milestones mean, and what you are expected to do before writing
   code against an issue.
4. [CONTRIBUTING.md](CONTRIBUTING.md) — how to run things and what gets merged.
5. The doc for whatever you touch under [docs/](docs/README.md), and the
   decision record for it under [docs/decisions/](docs/decisions/README.md).

## Hard rules

- **No personal data anywhere in the tree.** No real names, client names, or
  personal infrastructure (IPs, domains, tailnets, deploy identifiers).
  Fixtures and examples use a fictional persona, and there are exactly two:
  "Alex Example" owns `packages/core/fixtures/corpus/`, and Odysseus owns the
  `packages/ui-kit/fixtures/` design world (D19) that Storybook, screenshots
  and website copy render against. The two sets share a reference date and
  nothing else. CI enforces a leakage gate over the whole tree; it has no
  exempt directories.
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
- **Planned work lives in the issue tracker, not in a markdown file.** Do not
  add a status field, a unit checklist or a progress log to a document in this
  repo. Four plans carried those and every reader had to work out which lines
  were still true. `docs/decisions/` records why; `docs/plans/` holds design for
  work that is not built; GitHub holds everything that is open.
- **Nothing that describes a real deployment goes in this repo.** Image layout,
  hosts, proxies, operator runbooks and production incidents belong in the
  private `brain-ui` repo. This one is public.
- **Skills orchestrate, the CLI executes.** Deterministic logic belongs in a
  `brain` subcommand with `--json` output; SKILL.md files hold interview logic
  and judgment only.
- **Verify technical claims against the source** — the npm registry, upstream
  docs, the installed package — before building on them. Do not carry a version
  number or an API shape from memory.

## Conventions

- Runtime: Bun (`bun:sqlite`, `Bun.spawn`, `Bun.Glob`). TypeScript throughout.
  Tests: `bun run test` (the script supplies `--timeout 30000`; bare `bun test`
  fakes timeout failures). Typecheck: `tsc --noEmit`.
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

## Working through GitHub

Planned work is in the issue tracker. Before writing code against an issue:
read it, read its epic, check it against "What binds future work" in
[ROADMAP.md](ROADMAP.md) and the relevant
[decision record](docs/decisions/README.md), and **verify that the `file:line`
citations in the issue still point at what it claims** — issue bodies do not
move when code does.

The procedure, with the commands, is the repo-local `github` skill
(`.agents/skills/github/`). The agreement it implements — labels, milestones,
the project board, the lifecycle, which of the two repositories an issue belongs
in — is [docs/process/github.md](docs/process/github.md).

Two things that are easy to get wrong:

- **This repository is public.** Anything that would have to describe a real
  deployment goes in the private `brain-ui` repo instead. Run an issue body
  through the same gate the tree is held to before filing it; the `github`
  skill shows how.
- **Work found mid-session gets filed, not fixed and not forgotten** — and an
  issue with no acceptance criteria is a note, so do not label it
  `agent-ready`.

## Repo-local skills

They live in `.agents/skills/` and are symlinked into `.claude/skills/`.

| Skill | Load it before |
| --- | --- |
| `release` | Versioning, publishing, or changing what a release ships. |
| `github` | Filing, triaging, picking up or closing work in either tracker. |

A skill records what actually works. When one of them is wrong — a command that
changed, a limit that bit, an API shape that moved — fix it in the same PR that
found it.
