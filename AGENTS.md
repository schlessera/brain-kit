# AGENTS.md — Working in this repo

brain-kit: a file-first personal knowledge base that a coding agent operates.
This repo is the monorepo behind the `@schlessera/brain-*` packages.

## Read first

1. [README.md](README.md) — what this is and how the packages fit together.
2. [ROADMAP.md](ROADMAP.md) — current state and the decisions that bind new
   work. Read "What binds future work" before proposing anything structural.
3. [docs/process/github.md](docs/process/github.md) — where work lives, what
   labels and milestones mean, and what to do before coding against an issue.
4. [CONTRIBUTING.md](CONTRIBUTING.md) — how to run things and what gets merged.
5. The doc for whatever you touch under [docs/](docs/README.md), and the
   decision record for it under [docs/decisions/](docs/decisions/README.md).

## The five repositories

This is the most important context in this file. Never act on one of these
repositories without knowing which side of the line it sits on.

**The open-source project** — three public repositories, meant for strangers:

| Repo | What it is |
| --- | --- |
| `schlessera/brain-kit` | This repo. The engine: the `@schlessera/brain-*` packages that everything else runs on. |
| `schlessera/brain-template` | The starting point for your own second-brain repo. |
| `schlessera/brain-hosting-template` | The starting point for your own hosted PWA that manages your second-brain repo remotely, powered by brain-kit. |

**One person's instance** — two private repositories, never part of the
open-source project:

| Repo | What it is |
| --- | --- |
| `schlessera/brain` | The maintainer's own second brain. All of their personal data. Strictly private. |
| `schlessera/brain-ui` | The maintainer's own hosted PWA, built from brain-kit. |

`brain` is one instance of `brain-template`, and `brain-ui` is one instance
of `brain-hosting-template`. Dependencies run one way only: the private
instances consume the public project, and the public project never depends
on, links to or describes them.

- The public project board and every planning tool cover the three public
  repositories and nothing else. The private instance has its own private
  board. A private issue may name a public blocker (`Blocked by
  schlessera/brain-kit#42`); a public issue never names a private one.
- Nothing from `brain` or `brain-ui` may appear in a public repository. That
  covers content, deployment details, hostnames, and issue or PR references.
- An issue about the instance (its host, its data, an incident on it) is
  filed in `brain-ui` or `brain`. It never goes on the public board.

## Hard rules

- **No personal data anywhere in the tree.** No real names, client names, or
  personal infrastructure (IPs, domains, tailnets, deploy identifiers).
  Odysseus is the sole fictional example world for fixtures, CLI/MCP
  demonstrations, renderer examples, docs, skills, onboarding, UI stories,
  screenshots and website assets: ancient problems with modern organisational
  tools, the established cast and the pinned `2026-07-12` date. Core and UI fixtures may differ technically
  but share the world and canonical facts
  ([the corpus decision](docs/decisions/example-corpus.md), superseding D18/D19).
  CI's leakage gate covers the whole tree, with no exempt directories.
- **Contract stability.** The CLI `--json` shapes, MCP tool names and schemas,
  `schema_version`, and frontmatter semantics are the compatibility contract
  (`docs/integration-contract.md`). Changing one means updating that doc in the
  same commit and prefixing the commit `CONTRACT:`. An additive change ships in
  a minor; a breaking one also needs a maintainer ruling on its issue first —
  the doc's header says exactly which is which.
- **No new seams.** Extension interfaces exist only where a second
  implementation is plausible within a year. The not-pluggable list in
  `docs/extending/README.md` is final.
- **Markdown is the source of truth; `brain.db` is disposable.** `brain index
  --force` regenerates everything. Never design anything that writes `brain.db`
  as authoritative state.
- **Planned work lives in the issue tracker, not in a markdown file.** Do not
  add a status field, a unit checklist or a progress log to a document in this
  repo ([why](docs/plans/README.md#what-does-not-live-here)).
  `docs/decisions/` records why; `docs/plans/` holds design for work that is
  not built; GitHub holds everything that is open.
- **Nothing that describes a real deployment goes in this repo.** Image layout,
  hosts, proxies, operator runbooks and production incidents belong in the
  private `brain-ui` repo, which is one person's running installation rather
  than a product. This one is public. What a *self-hoster* would need belongs
  in `brain-hosting-template`, written for a stranger.
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
  sequences, which never change the runtime value. A raw NUL hides the file
  from grep and ripgrep; a whitespace-trimming editor corrupts a zero-width
  delimiter. `bun run lint` is the invisible-character gate, in CI too.
- Parse frontmatter with `parseFrontmatter` from the package's
  `src/lib/frontmatter-parse.ts`, never with gray-matter directly, which
  shares one cached object between byte-identical documents. `bun run lint`
  refuses a direct import
  ([docs/decisions/frontmatter-parsing.md](docs/decisions/frontmatter-parsing.md)).
- Config-driven taxonomy: document types are runtime-validated strings (zod),
  not compile-time unions.
- Modules own content domains (types, skills, one CLI namespace) and are
  declared with `defineModule({ name, configSchema, setup })`. Run
  `brain module lint` before submitting one.
- Cite code from docs and source comments as an anchor followed by its range:
  (`enforcementHook`, `packages/ui-backend-claude/src/permission-hooks.ts:104-127`),
  starting on the anchor's line. **A PR that moves lines under a citation owns
  that citation**, wherever it is recorded; find them with
  `git grep -n '<file>.ts:' -- docs packages`. `tests/decision-citations.test.ts`
  enforces this for `docs/decisions/`; the rules are in
  [docs/decisions/README.md](docs/decisions/README.md#citing-code).

## Testing expectations

The full text, with the incidents behind each rule, is
[docs/process/testing.md](docs/process/testing.md).

- Every library keeps or gains unit tests; contract tests assert the `--json`
  envelopes. Integration tests run against `packages/core/fixtures/corpus/` —
  keyless, deterministic; its retrieval goldens make any ranking change a
  reviewed diff. Never add a test that needs an API key or the network.
- The test preload (root/package `bunfig.toml`, `scripts/test.ts`) refuses
  non-loopback network and real curl, recording every attempt. Install mocks
  after it and restore them in teardown; new workspaces carry the same test
  config; callers assert child exit codes. What it does not instrument needs
  an explicitly offline harness, not a claim of sandboxing.
- Predicate-only unit tests are not proof for anything with a runtime. Run
  real browser tests with command-scoped sandbox escalation when the sandbox
  blocks them — never skip them or disable the guards. Tests replacing
  browser globals restore complete property descriptors. Test doubles replace
  the lowest shared request method.
- A green test is evidence only if it could have been red. Prove it with a
  mutation: break the guard, watch the named test fail on the expected
  assertion, restore, and record both in the PR. A failing-first receipt must
  fail for the reason claimed — a module-load error is not one.
- A review finding is one instance of a bug class: grep the diff and its file
  for every other instance before calling it closed.
- Before opening or marking a PR ready, run `bun run check:pr --base
  origin/main` and keep focused failing-first/mutation receipts. Ready-PR CI
  supplies the complete affected proof; every selected job must pass, and
  missing, cancelled or unexpectedly skipped jobs are not green. Policy:
  [the CI decision](docs/decisions/ci-utility.md) and
  [the PR proof rules](docs/process/testing.md#required-proof-for-a-pr).

## CI

GitHub Actions is the only CI provider (`.github/workflows/ci.yml`,
`contract.yml`, and `project-sync.yml` for the board), forks included. Depot
CI and the fork fallbacks are retired (#1320); do not restore a second
provider or copies. A workflow change preserves its gates, versions, pinned
offline browser image and artifacts ([policy](docs/process/testing.md#github-actions-ci)).
Green is a claim about a SHA: read checks for the PR's current head — no rows
is not green, nor is a fork run awaiting approval. After merging, prove the
squash is on `main`; never push to a merged branch. Commands and receipts:
[CI and merge](.agents/skills/work-issue/references/ci-and-merge.md).

## Releasing

**Load the [`release` skill](.agents/skills/release/SKILL.md) before versioning,
publishing or changing what a release ships.** It is the checklist, kept next
to the guards in `tests/release-manifest.test.ts`. The invariants:

- **`bun run version` refreshes the lockfile** (`rm bun.lock && bun install`).
  A hand-run `changeset version` does not, and a stale lock publishes
  `workspace:*` pins to a never-published version — this shipped once, in
  0.2.0. `scripts/publish.ts` refuses stale pins.
- **Read the version changesets produced before publishing.** A minor-only
  changeset has bumped the whole fixed group to a major twice; two config
  guards, asserted by `tests/release-manifest.test.ts`, now prevent it.
- **Build, publish, clean and the CI pack loop read the package list from
  the manifests** (`scripts/publishable-packages.ts`, dependency-first). A new
  package still joins the `fixed` group and the inventories
  `tests/release-manifest.test.ts` asserts.
- Publishing needs interactive auth: the final `bun run release` runs from a
  human's terminal.

## Working through GitHub

**Load the [`github` skill](.agents/skills/github/SKILL.md) before filing, triaging,
picking up or closing work.** It implements
[docs/process/github.md](docs/process/github.md): labels, milestones, the
board, the lifecycle and issue routing.

- Before writing code against an issue, read it and its epic, check it
  against "What binds future work" in [ROADMAP.md](ROADMAP.md) and the
  relevant [decision record](docs/decisions/README.md), and **verify that its
  `file:line` citations still point at what it claims**.
- **Every merge needs a release milestone** on the PR and each issue it
  completes or advances, read back before merge and after closure
  ([the milestone agreement](docs/process/github.md#milestones)).
- brain-kit owns behaviour; the templates own what a user generates;
  anything describing a real deployment goes to `brain-ui`. Run an issue body
  through the same gate as the tree before filing it.
- **Work found mid-session gets filed, not fixed and not forgotten** — and an
  issue with no acceptance criteria is a note, so do not label it
  `agent-ready`.

## Repo-local skills

In `.agents/skills/`, symlinked into `.claude/skills/`.

| Skill | Load it before |
| --- | --- |
| `release` | Versioning, publishing, or changing what a release ships. |
| `github` | Filing, triaging, picking up or closing work in either tracker. |
| `work-issue` | Taking one unassigned, highest-priority ready brain-kit issue through implementation and merge, or a blocked handoff. |
| `triage-issues` | Preparing open brain-kit issues without `agent-ready`: resolve factual gaps, maintain prompts, and reconcile labels and epic membership. |

A skill records what actually works. When one of them is wrong — a command that
changed, a limit that bit, an API shape that moved — fix it in the same PR that
found it.
