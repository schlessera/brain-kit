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

## The five repositories

This is the most important context in this file. Never act on one of these
repositories without knowing which side of the line it sits on.

**The open-source project** — three repositories, all public, meant for
strangers:

| Repo | What it is |
| --- | --- |
| `schlessera/brain-kit` | This repo. The engine: the `@schlessera/brain-*` packages that everything else runs on. |
| `schlessera/brain-template` | The starting point for your own second-brain repo. |
| `schlessera/brain-hosting-template` | The starting point for your own hosted PWA that manages your second-brain repo remotely, powered by brain-kit. |

**One person's instance** — two repositories, both private, never part of the
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
  Odysseus is the sole fictional example world for core/CLI fixtures, CLI and
  MCP demonstrations, docs, skills, onboarding, renderer examples, UI stories,
  screenshots and public website assets. Use ancient problems with modern
  organisational tools, the established cast and the pinned `2026-07-12` date.
  Core invariant fixtures and UI presentation fixtures may keep separate
  technical representations; they share the world and canonical facts. See
  [the corpus decision](docs/decisions/example-corpus.md), which supersedes
  D18/D19's former persona split. CI enforces a leakage gate over the whole
  tree; it has no exempt directories.
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
  repo. Four plans carried those and every reader had to work out which lines
  were still true. `docs/decisions/` records why; `docs/plans/` holds design for
  work that is not built; GitHub holds everything that is open.
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
  sequences. One raw NUL byte makes grep and ripgrep treat the whole file as
  binary, so it vanishes from every search, and an editor that trims
  whitespace silently corrupts a zero-width delimiter. Escaping never changes
  the runtime value, so hashes and wire formats stay put. `bun run lint`
  enforces this; CI runs it as the invisible-character gate.
- Parse frontmatter with `parseFrontmatter` from the package's
  `src/lib/frontmatter-parse.ts`, never with gray-matter directly. Called
  without options, gray-matter caches by content, so byte-identical documents
  share one data object. `bun run lint` refuses a direct import
  ([docs/decisions/frontmatter-parsing.md](docs/decisions/frontmatter-parsing.md)).
- Config-driven taxonomy: document types are runtime-validated strings (zod),
  not compile-time unions.
- Modules own content domains (types, skills, one CLI namespace) and are
  declared with `defineModule({ name, configSchema, setup })`. Run
  `brain module lint` before submitting one.
- Cite code from docs and source comments as an anchor followed by its range:
  (`enforcementHook`, `packages/ui-backend-claude/src/permission-hooks.ts:104-127`).
  The range starts on the line that contains the anchor. **A PR that moves
  lines under a citation owns that citation**, in source comments and in other
  records as well as the one it is editing. Find them with
  `git grep -n '<file>.ts:' -- docs packages`. `tests/decision-citations.test.ts`
  enforces this for `docs/decisions/`, and
  [docs/decisions/README.md](docs/decisions/README.md#citing-code) has the
  rules.

## Testing expectations

- Every library keeps or gains unit tests. Integration tests run against
  `packages/core/fixtures/corpus/` — keyless, deterministic. Its retrieval
  goldens (`evals/retrieval.jsonl`, one query per class, and the ranks in
  `evals/expected-ranks.json`, asserted by
  `packages/core/tests/eval-corpus.test.ts`) make any ranking change a
  reviewed diff. Never add a test that needs an API key or the network.
- Contract tests assert the `--json` envelopes. CI runs typecheck, tests, the
  keyless Tier-0 e2e funnel, a packaging smoke test, and the leakage gate.
- Predicate-only unit tests are not proof for anything with a runtime: the
  renderer's isolation holes were found by launching real Chrome, not by
  testing its allowlist function.
- Test doubles must replace the lowest shared request method (`get` for a
  `ScrapeClient`), or explicitly stub every inherited request path. Use the
  smallest collaborator that proves the behavior; borrowing a real adapter
  for a helper's test couples that assertion to unrelated adapter changes.
- The test preload in root/package `bunfig.toml` and `scripts/test.ts` wraps real `fetch`,
  `Bun.spawn` and `Bun.spawnSync`. Real HTTP(S) fetches permit only the parsed
  hosts `localhost`, `127.0.0.1` and `[::1]`; every followed redirect is checked
  before dispatch, and explicit proxies are refused. Real curl execution is
  refused, including absolute executable paths and both spawn argument forms.
  Attempts are recorded: test hooks fail even when a client catches/retries
  the error. Saved originals and restored spies refer to the guarded functions;
  install mocks after preload and restore them in teardown.
- Run tests from the repository root with `bun run test [paths/flags]` or
  `bun test [paths/flags]` (the latter still needs the documented timeout).
  Each package's own `bun run test`/`bun test` also loads its local preload;
  new workspaces must include the same test config, because Bun does not
  inherit it from parent directories.
  Guarded Bun spawns add an absolute runtime preload to children, even with a
  different cwd or replaced environment. Child test hooks and ordinary child
  exit checks reject swallowed escapes; callers must assert child exit codes.
  This covers Bun executables named `bun` or matching `process.execPath`.
  Bun's `node:child_process` delegates to the patched spawn path too. Node
  transports, subprocess APIs in a Node runtime, shell commands, arbitrary executables,
  browser egress and deliberate replacement of the guard are not instrumented:
  use an explicitly offline harness for those, not a claim of sandboxing.
  Intentional measurement scripts launched outside tests retain normal
  transports. Guard regression probes use controlled native sentinels so
  failing-first and mutation runs cannot send external requests or start curl.

### Tests that cannot fail

A green test is evidence only if it could have been red. Each of these shapes
shipped with a green suite. The numbers are the PRs that found them, except
#192, which is an issue:

- **An assertion that is not about the behaviour.** The test for whether pi
  tools load eagerly asserted that `Object.keys(tool)` does *not* contain
  `deferLoading`. That stays true for a deferred tool, an empty object or
  anything else without the key, so it could not tell eager from deferred.
  The fix asserts what does differ: the schema and the executor are already
  attached (#158).
- **A guard on the wrong object.** The test asserted the factory
  (`createBrainUiMcpServer`), not the `mcpServers` entry that the call site it
  was meant to protect actually builds (#158). A predicate-only test is the
  same shape.
- **An earlier layer answers first.** A 401 assertion kept passing with the
  route deleted, because the auth guard answers before routing. It proved
  nothing about the route, which a mounting test then did (#115).
- **The harness has nothing to observe.** "principal B is recorded for
  ordinary and always-allow approvals" passed with nothing stored anywhere,
  because its harness wired no store (#154).
- **The field under test is empty by construction.** A `toEqual` over a whole
  classifier request body passed with the threshold strip removed, because the
  test had built the request's `questions` map as `{}` (issue #192). An assertion over
  a whole structure is only as strong as its emptiest field. When a test builds
  the input and asserts the output, also assert that the part it covers is
  non-empty.
- **An earlier assertion masks the one under test.** An `overflowing(card)`
  assertion fired before the document-overflow check it sat above (#102). A
  change meant to break the kind-naming assertion tripped the character budget
  first (#121). The test went red, but for a different reason.

Checking for these takes a mutation, not reasoning. Break the guard the test
protects: revert the fix, delete the route, empty the store. Run the named
test, watch it fail on the assertion you expect, then restore. Record the
mutation and the failing assertion in the PR.

A "failing first" receipt must fail **for the reason claimed**. A module-load
error — `SyntaxError: Export named 'X' not found`, because the code under test
does not exist yet — is not a behavioural failure: three of the five failures
one PR first presented were load errors (#144). Give the test something to
load (a stub export that keeps the old behaviour), then show the assertion
failing. Read which assertion failed: if it is not the one the test is named
for, reorder or split the assertions until it is.

### A finding is an instance

A review finding is one occurrence of a bug class. Before calling it closed,
grep the diff, and the file it sits in, for every other instance of the same
shape. #115 fixed a window that enforced `started_at >= since` with no upper
bound and left the same missing bound live twelve lines up in `lifetime`, which
only a second review found. In #136, `localeCompare` survived fifty lines above
the comment explaining why `breakdown()` had stopped using it.

## Releasing

**Load the `release` skill (`.agents/skills/release/`) before doing any of
this.** It is the operational checklist, kept next to the guards that enforce
it (`tests/release-manifest.test.ts`); the notes below and in CONTRIBUTING.md
are the reasoning behind it.

- Full sequence: changeset → `bun run version` → **read the version it
  produced** → `bun run build && bun run typecheck && bun run test`
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

- **This repository is public, and it is one of five** (see "The five
  repositories" above). brain-kit owns behaviour. `brain-template` and
  `brain-hosting-template` own what a user generates. `brain` and `brain-ui`
  are the maintainer's private instance. Anything that would have to describe
  a real deployment goes to `brain-ui`. Run an issue body through
  the same gate the tree is held to before filing it; the `github` skill shows
  how, and `docs/process/github.md` has the routing rule.
- **Work found mid-session gets filed, not fixed and not forgotten** — and an
  issue with no acceptance criteria is a note, so do not label it
  `agent-ready`.

Two checks when verifying a PR, because a green check can describe a
different commit from the one you mean:

- **Green is a claim about a SHA, not about `main`.** A commit pushed to a
  branch after its PR has merged never reaches `main`. CI never runs on it,
  and `gh pr checks` keeps reporting the old green run. After merging, confirm
  that the squash commit is on `main`, and never push to a merged branch:

  ```sh
  git fetch origin
  git merge-base --is-ancestor <squash-sha> origin/main && echo on-main
  ```

- **After a rebase, a green summary can belong to the pre-rebase commit.**
  Read the checks for the PR's current head, not the latest summary. No rows
  means CI has not started on that commit, which is not the same as green:

  ```sh
  sha=$(gh pr view <n> --json headRefOid -q .headRefOid)
  gh api "repos/schlessera/brain-kit/commits/$sha/check-runs" \
    --jq '.check_runs[] | "\(.name) \(.status) \(.conclusion)"'
  ```

### Depot CI

CI and contract checks run from `.depot/workflows/`. Edit those files as the
source of truth; do not restore a stale GitHub workflow or maintain a second
copy. Preserve all gates, shard matrices, action versions, the pinned browser
image and diagnostic artifacts when changing workflows. Project sync remains
in `.github/workflows/project-sync.yml`: Depot CI does not support `issues`
events, and Depot's GitHub Actions runners require an organization-owned repo.

Use the installed `depot` CLI to monitor CI and investigate failed checks.
Check `depot ci <command> --help` before assuming flags. Prefix commands with
`rtk proxy` as required by the session's RTK instructions. For a PR, get its
current head SHA with `gh pr view`, then query that PR and SHA explicitly:

```sh
rtk proxy depot ci workflow list --repo schlessera/brain-kit \
  --pr <pr-number> --sha <head-sha> --output json -n 200
rtk proxy depot ci status <run-id> --output json
rtk proxy depot ci diagnose --run <run-id> --output json
rtk proxy depot ci logs <attempt-id> --timestamps --output-file /tmp/ci-attempt.log
rtk proxy depot ci artifacts list <run-id> --output json
rtk proxy depot ci artifacts download <artifact-id> --output-file /tmp/ci-artifact.zip
```

`depot ci run list` defaults to queued/running runs. Pass `--status failed`
to find failures or `--status finished` for completed runs, with `--repo`,
`--pr` and `--sha` as appropriate. Workflow listings include completed runs
without a status filter. Read each expected job and its current attempt;
`finished` alone is not proof that every required job passed. Record the
run/job/attempt IDs and inspect the actual failing step and assertion. Prefer
an attempt ID for logs: a job/run shortcut resolves the latest attempt and
can select different evidence after a retry. Use `logs --follow` only for a
bounded live inspection; finite exports keep monitoring responsive.
Limit concurrent log exports to four. If Depot reports `resource_exhausted:
Too many active log streams for this token`, let exports finish and retry
sequentially; the preceding `Not found` fallback messages do not prove that
the attempt is missing.

For local verification, `depot ci run --workflow .depot/workflows/ci.yml`
uploads unpushed changes automatically; `--job <job-key>` limits the jobs.
The CLI's `api` event has no PR/push changeset base, so select runtime jobs
instead of the `changeset` gate. With CLI 2.102.12, injected local patches
also require `jq` in the job container before checkout; the pinned Playwright
image lacks it. Push browser changes and inspect the automatic PR run.
A local API run does not establish PR-event or main-push behavior. Before
merging, verify automatic PR runs for the current head and live base, including
the checkout SHA in test/browser logs. After merging, verify the squash commit
is on main and inspect Depot's push run for that SHA. Missing runs, cancelled
jobs and older green attempts leave verification unfinished. Use GitHub checks
to discover check links, then Depot for CI logs; `gh run` applies to the
project-sync exception.

## Repo-local skills

They live in `.agents/skills/` and are symlinked into `.claude/skills/`.

| Skill | Load it before |
| --- | --- |
| `release` | Versioning, publishing, or changing what a release ships. |
| `github` | Filing, triaging, picking up or closing work in either tracker. |
| `work-issue` | Taking one unassigned, highest-priority ready brain-kit issue through implementation and merge, or a blocked handoff. |
| `triage-issues` | Preparing open brain-kit issues without `agent-ready`: resolve factual gaps, maintain prompts, and reconcile labels and epic membership. |

A skill records what actually works. When one of them is wrong — a command that
changed, a limit that bit, an API shape that moved — fix it in the same PR that
found it.
