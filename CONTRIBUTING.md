# Contributing

brain-kit is maintained by one person. Contributions are welcome; expectations
are calibrated accordingly — reviews may take days, and scope is guarded
deliberately.

**Start at the [issues](https://github.com/schlessera/brain-kit/issues).**
Everything planned is there, at the size it gets worked;
[`docs/process/github.md`](docs/process/github.md) explains what the labels and
milestones mean and what the lifecycle is. `good first issue` and `help wanted`
mean what they say.

Before proposing something structural, read "What binds future work" in
[ROADMAP.md](ROADMAP.md) and the relevant record in
[`docs/decisions/`](docs/decisions/README.md) — several things that look like
obvious improvements were considered and rejected for reasons written down
there. Open a
[discussion](https://github.com/schlessera/brain-kit/discussions) rather than an
issue when you are not sure.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3.5 — `brain doctor` warns below 1.3.5, citing
  CVE-2026-24910.
- Running this repository's test suite requires Bun ≥ 1.4.0; CI pins 1.4.2.
  Earlier Bun versions can close an unrelated recycled descriptor after an
  extra-pipe subprocess is collected (#1043). Consumer runtime minimums
  remain governed by the published packages' engines.
- A local Chrome or Chromium for the puppeteer runtime tests
  (`packages/ui-render-puppeteer/tests/runtime.test.ts`). Without one those
  tests skip, so a green **local** run on a Chrome-less machine has not
  exercised the renderer — the run says so in a banner rather than leaving you
  to notice.

  Hosted unit/runtime proof and optional `bun run check:pr --full` require Chrome and set
  `BRAIN_REQUIRE_CHROME=1`; missing Chrome fails instead of silently skipping.
  The real renderer proves isolation. `renderer.test.ts` covers an allowlist
  predicate and `crash-recovery.test.ts` drives a fake browser; neither replaces
  the real-browser proof.
- Coordinated build/test commands require `flock` from util-linux. The pinned
  Playwright image includes it. Full runtime proof needs a Linux checkout with bubblewrap, `unshare`, `ip`
  and permitted user/network namespaces. UI/browser proof also needs Docker
  for the pinned Playwright image. Packed consumer checks use Node 24 or later.

## Running the code

`bun run build`, `bun run clean`, `bun run test`, Linux `bun test` through the
repository preload, and the repository browser
wrapper wait automatically for other commands using the same checkout's build
output. Runtime tests hold exclusive access because their fixtures rebuild the
packages. Browser ownership is acquired inside the pinned container against the
same bind-mounted lock file. Nested builds reuse an inherited descriptor, or
verify its live owning ancestor on Linux when Bun's internal shell closes it;
replaced child environments and existing extra stdio channels keep that ownership.
Independent fast CI batches hold shared read-only access and still overlap;
attempting a rebuild from one fails before removing output. Strict typechecking
and commands in different worktrees remain independent.

The lock file is `tmp/workspace-operation/output.lock`. Ownership lasts as long
as the operating system holds its descriptor; a leftover file is not a stale
lock and must not be removed to bypass an active command. Failure/cancellation
stops the command's process group. Signal forwarding is installed before each
child is created, including lock waiters. An outer wrapper's death closes a lifetime
pipe which stops its owner before admitting a waiting command. The lifetime
watcher also removes a cancelled waiter before the active owner finishes. This is command
coordination, not protection against arbitrary filesystem edits.

Direct Vitest diagnostics do not acquire whole-command ownership.
Editorial captures retain their existing separate capture guard. Use the
coordinated entry points or separate worktrees when overlapping those runs.

The Linux backend nonpersistence tests require `bubblewrap` and permitted user
namespaces. They launch the installed Claude and pi adapters with a loopback
fixture model inside a network namespace; no provider credential or external
network is needed. The local pre-PR command checks these prerequisites and runs the proofs without accepting skips.

```sh
bun install
bun run test        # all packages — NOT bare `bun test`
bun run test packages/scrape   # only the paths you name, same timeout
bun run typecheck   # strict tsc, no emit
bun run lint        # refuses raw control/invisible characters in source
```

Use `bun run test`, not bare `bun test`: the script supplies `--timeout 30000`,
and the CLI onboarding tests spawn a real `brain` process per assertion, which
does not fit the 5s default — bare `bun test` fakes timeout failures.
Paths narrow the run (`bun run test packages/ui-server tests/foo.test.ts`), and
flags pass through (`bun run test --shard=1/3`, `bun run test -t "name"`); with
no path it runs `packages` and `tests`. A `--timeout` of your own overrides the
script's, because the last one wins. A flag whose value is optional
(`--changed`) takes it only as `--changed=<ref>`.

The test preload rejects accidental real external `fetch` calls and real curl
execution, even when the code under test catches the error. Real HTTP(S)
fixture servers on `localhost`, `127.0.0.1` and `[::1]` remain available;
redirects are checked before following them. Install fetch/spawn mocks after
preload and restore saved originals or spies in teardown. Bun child processes
started through the guarded spawn functions receive the runtime guard too;
assert their exit codes. Direct `bun test` commands from the repository or a
package root load that directory's `bunfig.toml`; Bun does not inherit a
parent config. See [AGENTS.md](AGENTS.md#testing-expectations)
for child-process coverage, safe probe harnesses and uninstrumented transports.
Measurement scripts started outside tests keep their ordinary transports.

The core CLI test harness passes the parent runtime's resolved timezone to
its children explicitly, including when `TZ` is absent. Fixed-instant sync
tests cover UTC and calendars on either side of it; production sync still
uses the user's local calendar.

That harness also supplies a throwaway HOME, Claude/pi/XDG configuration
directories and a command PATH containing only Bun, git and the sync fixture's
`touch` utility. Doctor tests cannot
discover host Claude commands or account configuration. Tests that need external
discovery provide their own shim and prepend it to `keylessEnv(root).PATH`,
with explicit overrides pointing only at test fixtures. Do not append the
host PATH to a doctor fixture. The hostile-sentinel tests exercise both
`runCli` and direct children using `keylessEnv`, including `doctor --fix`.

## Local feedback and hosted proof

Run from the contribution checkout using the relevant base:

```sh
bun run check:pr --base origin/main --plan  # inspect selection only
bun run check:pr --base origin/main         # local preflight and affected fast tests
bun run check:pr --base origin/main --full  # optional complete affected local fallback
bun run check:pr --all                      # complete local release/diagnostic inventory
```

Preflight includes committed, staged, unstaged and untracked changes. It runs
lint/leakage, environment documentation, changeset checks and affected fast
invariants. Ordinary contributions do not need Docker, Chrome or namespaces
for preflight or repeated local type/pack/browser proof. Keep focused debugging,
behavioral failing-first/restored mutations and visual review local.

Ready PR CI supplies authoritative strict types, complete tests for affected
packages and reverse dependencies plus root tests, conditional complete packed
consumer probes, and selected pinned visual/accessibility/pointer,
layout/offline/endurance, editorial and native runtime categories. Global or
unknown tooling/dependency changes expand to complete discovery. New tests are
discovered automatically. Relevant Claude probes use loopback-only fixtures;
real Chrome and required namespaces may not silently skip. The final `proof`
check requires every selected category to pass. Scheduled/manual exhaustive
runs supplement affected PR proof; they do not replace it.

Drafts stay on cheap gates. Batch intermediate pushes, then mark ready for
hosted proof. Independent packaging, types, unit and browser/runtime jobs start
together after cheap rejection gates. Complete unit proof includes the curated
subset once. Each PR cancels only its own obsolete heads; main SHA groups remain
independent. The browser image, per-project concurrency bounds and failure
artifacts remain pinned. Measure queue delay, elapsed time and cancellations
before adding shards or changing timeouts.

Record actual head/base, job/attempt IDs, checkout logs and focused local
receipts in the PR. Missing tools, failed/cancelled jobs and unexpected skips
leave proof incomplete. Assess new main commits before refreshing; unrelated
advancement alone does not require rebasing or repeating long suites. Preserve
the earlier tested tree rather than attributing it to a new base. Relevant
input/dependency/harness changes require fresh proof; unknown changes expand
conservatively. There is no generic cache of passing tests. Respect branch rules
and verify the actual squash parent/tree and automatic main-push result.

Independent fast test batches and typechecking share a queue with at most two
active processes on one runner. Each selected test runs exactly once; another batch
starts when a slot becomes free. Ordinary Bun processes retain their module
registry and preload. Native `--parallel --no-isolate` is a possible alternative
once current-version runtime/guard behavior and total consumption are measured;
older comments about isolation are not a permanent compatibility ruling.
The policy and its tradeoffs are in [the CI decision](docs/decisions/ci-utility.md).

When tuning execution, record file durations during a required local run:
`bun run test --timings=tmp/bun-test-timings.json --update-timings`. Compare
serial, bounded ordinary-process batches and Bun's native file workers on the
same runtime/resources, with the test preload intact. Measure total consumption,
peak memory, failures and cancellation cleanup as well as elapsed time. More
workers can repeat imports or overload the browser/server; blanket
`--concurrent` also changes shared-mock and lifecycle assumptions. The decision
links Bun and Depot's upstream guidance and explains size-weighted billing.

For optional local distribution, `bun run test --balanced-shard=1/3` (then `2/3`
and `3/3`) retains complete discovered-test coverage. `scripts/test-shards.ts`
uses measured file weights, not an allowlist; newly added tests remain included.
This layout is no longer automatic CI. Browser shard arguments also remain
available, with the pinned image and diagnostics unchanged.

Browser shards use a committed per-project/file timing table, not live CI
artifacts or a fixed allowlist. Unknown specs get a positive one-second weight;
invalid tables fail visibly. Refresh explicitly from two successful browser jobs:
`bun scripts/refresh-browser-costs.ts <run-id> <attempt>`. Review the source
head/checkout/tree, job IDs and seconds/median metadata alongside the table.
Unsharded discovery is unchanged and existing browser file concurrency is kept.

`bun run test:browser` runs every configured browser project in the pinned
Playwright image. The shared `scripts/visual.mjs` runner defaults to
`--browser.fileParallelism=false`, including the `--inside` path: one file
per project can run at a time, while separate projects still run concurrently.
The project, update and shard arguments retain their existing meaning. To
compare the CPU-based browser pool defaults during diagnosis, use
`bun run test:browser --browser.fileParallelism=true`; the same explicit
boolean control works with `--inside`. Supply it at most once.

This default follows the [combined-run investigation (#853)](https://github.com/schlessera/brain-kit/issues/853).
With Vitest 4.1.11, root `--maxWorkers=4` left each of five browser pools at
12 workers, dispatching up to 38 unfinished files; the sequential-file
control peaked at five. The print subject's capture command/transport await
took 6,376ms, exceeding its unchanged 5,000ms stability deadline, while PNG
decoding took 10ms. The control took 92ms/4ms respectively. Browser
launch/connection and dispatch-to-collection delays also fell. This evidence
supports reducing load; it does not isolate every timeout's cause, promise
faster total runs, or establish the cause of [#559](https://github.com/schlessera/brain-kit/issues/559).

`bun run test:layout` runs the real ui-react chat overlay measurements after
`bun run build`. It uses the existing Vitest browser runner and the same pinned
Playwright image as the visual suite, with Docker networking disabled. The local pre-PR command runs
this project for affected UI work. It reads `ui-react/dist/styles.css`, uses
an isolated root with seeded messages and fixture transports, and checks pixels
without screenshot baselines. Browser layout files use `.layout.tsx` so Bun's
unit-test discovery does not claim them.

The same project runs offline fault tests, named `.offline.tsx`. Their
harness lives in `packages/ui-react/tests/browser/offline/`, and each module's
header documents its API:

- `audio-fixtures.ts` generates seeded WAVs: 10 s, 95 s and 10 min 5 s.
- A fake microphone plays the 10-second WAV. The project's Chromium launch
  flags feed it, and `fake-microphone.ts` injects it for other engines and can
  interrupt the microphone or hide the page.
- `fault-network.ts` provides the transport drop, the auth expiry (a 401 and a
  1008 close) and a request and frame spy.
- `indexeddb-faults.ts` simulates a full quota.
- `scene.ts` reloads or terminates a whole page.

`offline-faults.offline.tsx` checks each primitive against today's app. A
feature test should use these helpers instead of building its own.

The complete dictation browser fixture has its own `dictation` project so its
Chromium touch emulation and consumer styles stay outside the shared `visual`
page. The default browser wrapper includes it in both shards; use
`node scripts/visual.mjs --project=dictation` for a focused container run.

Tests and typecheck run from live TS source — no build needed. The
`node_modules/.bin/brain` bin, however, points at the compiled CLI, so run
`bun run build` once before invoking it directly (or use
`bun packages/core/src/cli/brain.ts`).

Tests must stay keyless and deterministic: integration tests run against
`packages/core/fixtures/corpus/` with FTS-only search. Never add a test that
needs an API key or the network.

For parameterized tests with unsafe strings, put a readable label in the test
name and pass the raw value separately. Bun 1.3.14's JUnit reporter can emit
both a raw NUL and `&#0;` when the name contains NUL; standard XML parsers
reject that report even when every test passes (#639). Keep the unsafe value
and its refusal assertion intact. To verify a report, run `bun run test
--reporter=junit --reporter-outfile=/tmp/brain-tests.xml`, then parse the file
with a standard XML parser and inspect its testcase names and counts.

## The rules that will get a PR merged

1. **Contract changes** (CLI `--json` shapes, MCP tool names/schemas, db
   `schema_version`, frontmatter semantics): update
   `docs/integration-contract.md` in the same commit and prefix the commit with
   `CONTRACT:`. Additive changes ship in a minor; a breaking change needs a
   maintainer ruling on its issue before code is written (see the contract
   doc's header). Two checks hold this, described under
   [Contract checks](#contract-checks).
2. **No new seams.** Extension interfaces exist only where a second
   implementation is plausible within a year. The explicitly-not-pluggable
   list in the README is final: no storage providers, no framework adapters,
   no protocol plugins.
3. **Contributing a provider** (the intended extension path, ≤3 steps):
   implement the typed interface (`defineConfig` accepts your value directly),
   test it keylessly against that interface, and optionally publish as
   `brain-<kind>-<vendor>` under your own npm scope (matching the in-tree
   `brain-backend-claude` / `brain-render-puppeteer` / `brain-module-jobs`
   precedent).

   Five seams ship a reusable contract suite, which every first-party
   provider of that seam runs. Agent backends have `runBackendContract` from
   `@schlessera/brain-ui-sdk/testing`
   ([agent-backends.md](docs/extending/agent-backends.md#naming-and-stability)).
   The four core seams have theirs in `@schlessera/brain/testing`:
   `runEmbeddingProviderContract`
   ([embeddings.md](docs/extending/embeddings.md#test-it-against-the-contract)),
   `runCompletionProviderContract`
   ([completions.md](docs/extending/completions.md#test-it-against-the-contract)),
   `runAgentRunnerContract`
   ([agent-runners.md](docs/extending/agent-runners.md#test-it-against-the-contract))
   and `runSkillEmitterContract`
   ([skill-emitters.md](docs/extending/skill-emitters.md#test-it-against-the-contract)).
   Hand the suite your real provider, driven with scripted inputs, no API key
   and no network: an HTTP provider over a stubbed `fetch` or vendor SDK
   transport, an agent runner over a fake executable, a skill emitter in the
   temporary repository the suite builds. The seams without a suite get the
   same kind of test, written by hand. A speech
   provider's `createSession` is called with fixed keyterms, against a stubbed
   token endpoint if it mints one, asserting the `url`, `token` and `expiresAt`
   it returns.
   There is no in-tree test to copy yet. An ASR client
   runs against a fake `WebSocket` and `MediaRecorder`, as
   `packages/ui-react/tests/asr-deepgram.test.ts` does. A tool renderer is
   resolved and rendered from fixed `ToolCallView` fixtures; the resolution
   half is what `packages/ui-react/tests/tool-renderers.test.ts` covers. A site
   adapter reads saved pages through a stub HTTP client. A browser-backed one
   gets a stub browser session that runs its extractor over the saved page in
   a DOM, as `packages/module-jobs/tests/board-fixtures.test.ts` does. Cover
   every method, and every `capabilities` flag the interface has and you
   declare.

   Promotion to a built-in has its own bar, written in
   [`docs/extending/README.md`](docs/extending/README.md#promoting-a-community-provider-to-a-built-in).
4. **Modules** own content domains (types, skills, one CLI namespace) — see
   `docs/extending/`. Run `brain module lint` before submitting.
5. **No personal data** in fixtures or examples — the CI leakage gate will
   reject known private strings; use the Odysseus world in [the corpus decision](docs/decisions/example-corpus.md).
6. **No raw control or invisible characters** — write them as escape
   sequences. A single raw NUL byte makes grep and ripgrep classify the file
   as binary and drop it from every search; escaping leaves the runtime value
   untouched. `bun run lint` is the gate.
7. Versioning is lockstep across `@schlessera/brain-*` as a single changesets
   `fixed` group: all seventeen packages, including packages whose own code did
   not change and receive only a dependency bump. This is a deliberate pre-1.0 solo-maintainer
   tradeoff, not an oversight. Add a changeset to any user-visible change. Keep
   the changeset itself short — what was added / changed / removed, in one line
   each. The commit it links to carries the reasoning.

Frontmatter is parsed only through `parseFrontmatter`, whose canonical copy is
`packages/core/src/lib/frontmatter-parse.ts`. A package that needs to parse
frontmatter copies that file in verbatim, the same way the `env-core.ts` files
are shared. `tests/frontmatter-parse-sync.test.ts` holds the copies identical,
and `scripts/check-frontmatter-parse.ts`, part of `bun run lint`, refuses any
other import of gray-matter. The reason is in
[docs/decisions/frontmatter-parsing.md](docs/decisions/frontmatter-parsing.md).

The header of `tests/env-core-sync.test.ts` records why the `env-core.ts` files
remain synchronized copies instead of moving into a shared package.

The invisible-character and leakage gates here are brain-kit's own. A
deployment keeps its own copies with its own patterns, and a copy that runs
before `bun install` stays dependency-free.

## Contract checks

CI runs on GitHub Actions from `.github/workflows/ci.yml`, including the
separate contract gate below. These are the authoritative workflows for
main pushes and all pull requests. Update them directly when changing a check;
local packed-consumer proof reads the same pack job. See [AGENTS.md](AGENTS.md#github-actions-ci)
for exact-head runs, failed-step logs and checkout receipts. Depot CI and the
former generated fork fallback copies are retired.

Fork pull requests use the same read-only CI and contract workflows. No secrets
or persisted checkout credentials are exposed. GitHub may hold a first-time
contributor's run until a maintainer approves it; until its jobs run, it has
not passed. The provider migration preserves the current automatic fast gates
and every mandatory local runtime/browser/layout/endurance/capture check.

Two checks find contract changes, so a break cannot ship as a minor unnoticed.

**The contract gate** (`.github/workflows/contract.yml`, rule in
`scripts/check-contract-pr.ts`) runs on every pull request and again whenever
its title or labels change. A PR whose diff touches
`docs/integration-contract.md` must be titled `CONTRACT: <type>(<scope>): …`
and carry the `contract` label. A PR titled `CONTRACT:` or labelled `contract`
must touch the doc. PRs are squash-merged, so the title becomes the commit
subject that an audit searches for. "Touches" means the PR's own diff, from
where its branch left the base to its head commit. If the gate fails, either
fix the title and label, or move the doc edit out of a PR that is not a
contract change.

**The API report** (`api-report/*.txt`, written by `scripts/api-report.ts`,
checked by `tests/api-surface.test.ts`) records every exported name per export
subpath, `/internal` ones included. For every export of an ordinary (public)
entry point it also records the declaration's signature: its public surface,
without comments, bodies, default values, private members or members tagged
`@internal`. The same goes for every type declared in this repo that such a
surface names, whether by reference, by inline `import("…")` or through
`typeof`, directly or through another recorded type. A declaration another
package exports publicly is recorded once, in that package's report; a
re-export says where. Why the boundary is drawn there is
[the public export boundary](docs/decisions/public-export-boundary.md).

An inferred return type, and the type of an unannotated constant, are printed
as the checker infers them, and the repo types they name are followed. Some
types the report cannot record, so `bun run api-report` and the test fail,
naming the declaration and its `file:line`, when any of these is reachable:

- a public or protected property whose type is inferred;
- a parameter without an annotation, including one with a default value and a
  constructor parameter property;
- a whole module used as a type (`typeof import("x")`, or `typeof ns` for
  `import * as ns`).

The fix is to write the type down, which changes no behaviour. Adding or
removing an export fails `… matches the current exports`. Retyping a public
declaration, or a member of any type it is made of, fails `… matches the
current public signatures`, and the failure shows the changed line. The `SEAMS`
list at the top of the script names the documented extension seams, which the
test additionally checks by shape.

To change the surface on purpose, make the change, run `bun run api-report`,
and read the diff under `api-report/` before committing it. A removed or
changed line in a signature section is a change to the supported API. Whether
it breaks it is decided by
[`docs/decisions/contract-versioning.md`](docs/decisions/contract-versioning.md);
a break needs the ruling and the changeset the contract doc's header describes.
An export that only first-party packages need belongs in the owning package's
`/internal` entry, not in an ordinary one.

## Releasing

`bun run version` (changesets), then `bun run release`. The step-by-step
checklist is the repo-local `release` skill (`.agents/skills/release/`), which
agents load automatically; what follows is why it says what it says.

`bun run version` chains `rm bun.lock && bun install` after `changeset version`,
and that second half is not optional: bun resolves `workspace:*` pins from the
installed lockfile, and a plain install does not refresh them, so a stale lock
publishes manifests pinning the previous, never-published version. Running
`changeset version` directly means doing the refresh by hand. `scripts/publish.ts`
refuses the release if the pins are stale.

Two config details keep the lockstep bump honest, and removing either silently
turns every release into a major (0.4.0 → 1.0.0 instead of 0.5.0):

- `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange`
  is `true` in `.changeset/config.json`. Changesets otherwise majors any package
  that peer-depends on something being released — regardless of the range, and
  regardless of `peerDependenciesMeta.optional`.
- `@schlessera/brain-ui-server`'s peer dependency on the optional
  `@schlessera/brain-backend-pi` is ranged `*`, not `workspace:*`. Changesets
  can't evaluate the `workspace:` protocol as a semver range, so it treats every
  new version as out of range and majors anyway.

With the `fixed` group, one such major promotes the whole lockstep group.
`tests/release-manifest.test.ts` asserts both guards, so this fails the build
rather than the release.

## What not to send

Framework rewrites, storage backends, editor plugins, "AI-generated
improvement" sweeps without a driving use case, or features that require a
daemon. Open a discussion first when unsure.
