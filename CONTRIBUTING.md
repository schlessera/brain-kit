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

```sh
bun install
bun run test        # all packages — NOT bare `bun test`
bun run typecheck   # strict tsc, no emit
bun run lint        # refuses raw control/invisible characters in source
```

Use `bun run test`, not bare `bun test`: the script supplies `--timeout 30000`,
and the CLI onboarding tests spawn a real `brain` process per assertion, which
does not fit the 5s default — bare `bun test` fakes timeout failures.

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
   `docs/integration-contract.md` in the same commit, prefix the commit with
   `CONTRACT:`, and expect a major-version discussion first.
2. **No new seams.** Extension interfaces exist only where a second
   implementation is plausible within a year. The explicitly-not-pluggable
   list in the README is final: no storage providers, no framework adapters,
   no protocol plugins.
3. **Contributing a provider** (the intended extension path, ≤3 steps):
   implement the typed interface (`defineConfig` accepts your value directly),
   prove it against the interface's contract test, and optionally publish as
   `brain-<kind>-<vendor>` under your own npm scope (matching the in-tree
   `brain-backend-claude` / `brain-render-puppeteer` / `brain-module-jobs`
   precedent). Community providers are only promoted to
   built-ins once they have real users.
4. **Modules** own content domains (types, skills, one CLI namespace) — see
   `docs/extending/`. Run `brain module lint` before submitting.
5. **No personal data** in fixtures or examples — the CI leakage gate will
   reject known private strings; use the "Alex Example" persona.
6. **No raw control or invisible characters** — write them as escape
   sequences. A single raw NUL byte makes grep and ripgrep classify the file
   as binary and drop it from every search; escaping leaves the runtime value
   untouched. `bun run lint` is the gate.
7. Versioning is lockstep across `@schlessera/brain-*` as a single changesets
   `fixed` group, including packages whose own code did not change and receive
   only a dependency bump. This is a deliberate pre-1.0 solo-maintainer
   tradeoff, not an oversight. Add a changeset to any user-visible change. Keep
   the changeset itself short — what was added / changed / removed, in one line
   each. The commit it links to carries the reasoning.

The header of `tests/env-core-sync.test.ts` records why the `env-core.ts` files
remain synchronized copies instead of moving into a shared package.

brain-kit and brain-ui each keep their own copies of the invisible-character
and leakage gates. brain-ui's invisible-character gate stays dependency-free
so it can run before `bun install`; each leakage gate keeps its
deployment-specific patterns.

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

With the `fixed` group, one such major promotes all fourteen packages.
`tests/release-manifest.test.ts` asserts both guards, so this fails the build
rather than the release.

## What not to send

Framework rewrites, storage backends, editor plugins, "AI-generated
improvement" sweeps without a driving use case, or features that require a
daemon. Open a discussion first when unsure.
