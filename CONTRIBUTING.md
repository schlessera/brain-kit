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
- A local Chrome or Chromium for the puppeteer runtime tests
  (`packages/ui-render-puppeteer/tests/runtime.test.ts`). Without one those
  tests skip, so a green **local** run on a Chrome-less machine has not
  exercised the renderer — the run says so in a banner rather than leaving you
  to notice.

  CI does not get that option. The `test` job resolves Chrome, prints its
  version into the log, fails if it finds none, and sets
  `BRAIN_REQUIRE_CHROME=1`, which makes the test file throw instead of skip.
  This is where the renderer's isolation posture is proven and the only place
  it is: `renderer.test.ts` covers the allowlist predicate, which missed the
  WebSocket bypass, and `crash-recovery.test.ts` drives a fake browser.

## Running the code

The Linux backend nonpersistence tests require `bubblewrap` and permitted user
namespaces. They launch the installed Claude and pi adapters with a loopback
fixture model inside a network namespace; no provider credential or external
network is needed. CI installs bubblewrap and runs these proofs without skips.

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

CI runs three unit/integration shards with `bun run test --balanced-shard=1/3`
(then `2/3` and `3/3`), each in one Bun process. This option uses the default
`packages`/`tests` roots and cannot combine with paths, `--cwd` or native
`--shard`. `scripts/test-shards.ts` discovers test files at runtime and places
the slowest first into the lightest shard, using the measured seconds in
`scripts/test-shard-costs.json`. The table supplies weights for slow files,
not suite membership: new tests are included automatically with a small default
weight. Refresh the weights when suite changes make the actual CI timings
uneven; #629 records the profiling commands, timings and coverage evidence.
The browser/visual job keeps its separate two-shard layout.

`bun run test:layout` runs the real ui-react chat overlay measurements after
`bun run build`. It uses the existing Vitest browser runner and the same pinned
Playwright image as the visual suite, with Docker networking disabled. CI runs
this project separately on every PR. It reads `ui-react/dist/styles.css`, uses
an isolated root with seeded messages and fixture transports, and checks pixels
without screenshot baselines. Browser layout files use `.layout.tsx` so Bun's
unit-test discovery does not claim them.

Tests and typecheck run from live TS source — no build needed. The
`node_modules/.bin/brain` bin, however, points at the compiled CLI, so run
`bun run build` once before invoking it directly (or use
`bun packages/core/src/cli/brain.ts`).

Tests must stay keyless and deterministic: integration tests run against
`packages/core/fixtures/corpus/` with FTS-only search. Never add a test that
needs an API key or the network.

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
   reject known private strings; use the "Alex Example" persona.
6. **No raw control or invisible characters** — write them as escape
   sequences. A single raw NUL byte makes grep and ripgrep classify the file
   as binary and drop it from every search; escaping leaves the runtime value
   untouched. `bun run lint` is the gate.
7. Versioning is lockstep across `@schlessera/brain-*` as a single changesets
   `fixed` group: all fifteen packages, including packages whose own code did
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
subpath. For the seams in [`docs/extending/README.md`](docs/extending/README.md#the-seams)
it also records each declaration's signature: its public surface, without
comments, bodies, default values or private members. The same goes for every
type declared in this repo that such a surface names, whether by reference,
by inline `import("…")` or through `typeof`, directly or through another
recorded type. A type used only by a private member is not recorded.

The report records what is written, so it refuses a seam-reachable surface
whose type is not written down. `bun run api-report` and the test fail, naming
the declaration and its `file:line`, when any of these is reachable:

- a public or protected property, method, getter or function whose type or
  return type is inferred;
- a parameter without an annotation, including one with a default value and a
  constructor parameter property;
- an unannotated constant whose inferred type names a type declared in this
  repo (a constant of purely structural type, like `BLOCK_SCHEMA`, is recorded
  by the type it infers to);
- a whole module used as a type (`typeof import("x")`, or `typeof ns` for
  `import * as ns`).

The fix is to write the type down, which changes no behaviour. The `SEAMS`
list at the top of the script names the seams. Adding or removing an export fails `… matches the current exports`. Retyping a
seam member, or a member of any type it is made of, fails `… matches the
current seam signatures`, and the failure shows the changed line.

To change the surface on purpose, make the change, run `bun run api-report`,
and read the diff under `api-report/` before committing it. A removed or
changed line in a signature section is a change to a seam. Whether it breaks
one is decided by
[`docs/decisions/contract-versioning.md`](docs/decisions/contract-versioning.md);
a break needs the ruling and the changeset the contract doc's header describes.
Nothing else needs updating: the test checks every `SEAMS` entry by shape, not
by its current signature. When the set of frozen declarations grows, add the
names to `SEAMS` and regenerate.

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
