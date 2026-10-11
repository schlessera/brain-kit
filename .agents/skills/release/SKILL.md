---
name: release
description: Use when cutting a release of the brain-kit packages — versioning, publishing to npm, or preparing a release PR — and when a release has gone wrong and needs diagnosing. Also use before adding a package, a peer dependency, or anything else that changes what a release ships.
compatibility: Requires bun (and bunx) and git. Publishing additionally needs npm with an authenticated account.
---

# Releasing brain-kit

**This skill is the procedure; `CONTRIBUTING.md` and `AGENTS.md` carry the
reasoning behind it.** Every trap listed here has actually happened at least
once, and most were documented in prose before they happened again. A release
that hits something new is not finished until that lands here or in a test — see
[When the release hits something not in this skill](#when-the-release-hits-something-not-in-this-skill).

All eighteen packages move in lockstep through a changesets `fixed` group. One
mistake therefore lands on the whole group at once.

The full sequence: changeset → `bun run version` → **read the version it
produced** → `bun run build && bun run typecheck && bun run test` →
`bun run test:experiments` → commit `chore: version packages to X.Y.Z` → push →
`bun run release`. The sections below are each step's checks;
[Before you version](#before-you-version) adds the complete `check:pr --all`
proof before the release PR, and
[The experiment tier](#the-experiment-tier) covers the release-only tests.

## Before you version

Check the bundled Claude model coverage and base rates against the provider's
current pricing and lifecycle pages, following
[`packages/ui-server/data/README.md`](../../../packages/ui-server/data/README.md#refreshing).
Record the check date there and refresh the data and independent offline test
expectations when they differ. These prices serve offline hosts until a remote
catalog is cached; a stale snapshot can leave a current model unpriced. No paid
inference call is needed.

1. **Changesets exist for everything user-visible.** `.changeset/*.md`, one per
   change, each naming the packages it affects and a bump type. No changeset
   means no version bump and no changelog entry.
   Before handing off any pending changeset, run
   `bun scripts/check-changeset-packages.ts` and
   `bunx --no-install changeset status`. Inspect the full plan against the actual
   workspace manifest names and intended bump types; package directories are not
   package identities. `changeset status --since=origin/main` can additionally
   inspect this contribution, but does not replace full pending-set validation.
   An unknown name prevents plan assembly even when the contribution gate passes;
   correct the reference while preserving its intended bump and release prose.
2. **`bun run check:pr --all` is green before creating the release PR.**
   This includes complete tests, strict types, real runtime/Chrome enforcement,
   every pinned browser/layout/endurance project, editorial reproducibility and
   all packed consumer checks. Record head/base, commands and results; fast
   automatic CI does not establish release proof. Missing tools or skipped
   runtime checks leave verification unfinished. The `tests/` directory retains
   the release guards; none are removed to save CI minutes. `--all` does not run
   the measurement-harness tests under `experiments/`; those are the separate
   [experiment tier](#the-experiment-tier), run after versioning.
   The pinned browser projects and the container lease test need a running
   Docker daemon, not only the `docker` binary the preflight checks. A stopped
   daemon surfaces late, as `Container did not attempt ownership: failed to
   connect to the docker API at unix:///var/run/docker.sock`, after the
   complete suite has already run.
3. **New package added this cycle?** Build, publish, clean and the CI pack
   loop pick it up from its manifest: they all read
   `scripts/publishable-packages.ts`, which lists every non-private
   `packages/*/package.json` with each package after its internal hard
   dependencies. `bun run release -- --dry-run` prints that order without
   publishing. The package must still join the `fixed` group in
   `.changeset/config.json`, the package map in `README.md`, and a row in the
   pack table (`PACK_TABLE` in `scripts/ci-pack.ts`) saying what its tarball
   must hold and how Bun and Node consumers import it; the pack job refuses a
   package without one, and `tests/release-manifest.test.ts` enforces the rest.
   Record the issue-approved internal dependencies in
   `tests/allowed-edges.ts`, with their rationale; `tests/dependency-edges.test.ts`
   rejects a package without an edge policy.

## Versioning

```sh
bun run version
```

This chains `changeset version && rm -f bun.lock && bun install`, and the
second half is not optional — bun resolves `workspace:*` pins from the
installed lockfile, so a stale lock publishes manifests pinning a version that
was never published. Running `changeset version` by hand means doing that
refresh by hand. `scripts/publish.ts` refuses the release if the pins are stale.

**Then read the version it produced, before anything else.**

Bump `template/package.json`'s `@schlessera/brain` pin to that version. A
forgotten bump is caught by `tests/release-manifest.test.ts`.

Stage the generated changes with `git add -A` before the post-version checks.
Documentation gates enumerate tracked files with `git ls-files`; until the
deletions are staged, they still try to read the consumed `.changeset/*.md`
files and fail with `ENOENT`. Staging also puts new package changelogs under
those gates. Review the staged diff before committing.

The required lockfile refresh can also move external dependencies. If it moves
the Claude SDK, run the keyless runtime probe described in
`docs/decisions/claude-code-runtime.md` before updating `MEASURED_RUNTIME`.
A failed case is a finding to file, not evidence for a new measured constant.
Keep the release on the last validated external package resolutions when the
new runtime fails, while retaining the freshly generated workspace metadata.
Verify both `bun install --frozen-lockfile` and
`bun scripts/check-publish-pins.ts`; restoring the old workspace versions would
reintroduce the stale-pin failure. SDK 0.3.287 / CLI 2.1.287 failed three
permission-precedence cases during 0.40.0 preparation, so that release retained
the validated SDK 0.3.283 / CLI 2.1.283 pair. 0.41.0 retained SDK 0.3.293 the
same way while the move to 0.3.296 waits for its full re-measure (#1596).

The rollback's `bun install` does not prune bin links that only the briefly
installed newer versions declared. During 0.41.0 the experiment tier then
refused with `the workspace is not built (node_modules/.bin/detect-libc,
node_modules/.bin/openai dangle)`, although neither is a workspace package and
`bun run build` cannot fix it. `find node_modules/.bin -xtype l` lists them;
the copyfile reinstall under [The experiment tier](#the-experiment-tier)
removes them.

```sh
bun run check:pr --all
```

## The experiment tier

Tests that exercise only measurement and eval harnesses live under
`experiments/`, outside `bun run test`, `check:pr` and hosted CI. Release
preparation runs every one of them, on the post-version candidate:

```sh
bun run test:experiments
```

Run it after `bun run version` (and after any SDK rollback or other lock edit
described above), once the post-version build, typecheck and tests pass. It
needs that build: the workspace bins in `node_modules/.bin` point into the
packages' `dist/`, and it refuses to start while they dangle. It runs offline through the same wrapper and network guard as `bun run test`,
needs `python3`, `bwrap`, `unshare`, `setpriv` and `ip` plus permitted
user/network namespaces, and takes about ten minutes. A missing tool, a
failure, a skipped or todo test, a `test.only`, or an inventoried file that
did not run fails it.

Only a complete clean run writes `tmp/experiment-tier-receipt.json`, naming the
working-tree content, `bun.lock` hash, experiment file inventory and Bun
version it tested. `bun run release` refuses to publish unless that receipt
matches the checkout it is publishing (`Release refused: ... experiment-tier
receipt`). Committing the same tree keeps it valid; any later change to a
source file, the lock or the inventory needs a fresh run. A failure is a
finding to fix or file, never a reason to skip the tier: there is no override.
Debug one file with `bun run test experiments/<file>`; that records nothing.
`bun run release -- --dry-run` stays a plain listing and is not gated.

**`Experiment tier refused: node_modules is hard-linked to Bun's cache`** (or,
from a direct `bun run test experiments/…`, about 34 native/paid-harness
failures with "Installed dependency inode has external hardlinks")? Bun's
default install hard-links `node_modules` to its global cache, and the offline
harnesses refuse runtime bytes they do not own. Reinstall the same lock as
copies and rerun: `rm -rf node_modules && bun install --frozen-lockfile
--backend=copyfile`. The lock is unchanged, so this does not invalidate
anything; do not skip or edit the tests.

## A cold build tries to download an installed CLI

`bunx @tailwindcss/cli` may search for a binary named `cli`, even though the
installed package exports `tailwindcss`, then attempt a registry download.
Name both explicitly: `bunx -p @tailwindcss/cli tailwindcss`. Diagnose against
the frozen install with `bunx --no-install -p @tailwindcss/cli tailwindcss --help`;
it must work without a warm Bun cache or network. The required local editorial capture
verification exercises the actual build script with networking disabled.

## `bun run build` exits 133 with a V8 stack trace

A build that dies with `error: script "build" exited with code 133` and a
`V8_Fatal` / `ReduceStringAt` / `TurboshaftAssemblerOpInterface` stack has
failed compilation. The stack alone does not establish the crashing child,
an upstream defect or the input/resource trigger. Preserve complete stderr,
source/configuration/compiler identity, the actual child executable and
exit/signal, and resource conditions before making a controlled comparison.
Keep strict compilation and the offline guards enabled. A passing unchanged
comparison is recovery evidence; it does not erase the failed proof or prove
a correction. Diagnose repeated native termination instead of retrying until
green. The earlier Node v22.18.0 occurrence during 0.35.0 passed once on
retry, with `check-dist-types` clean afterwards; its cause was not established.
See #756 for the distinct retained native failures and matched-source controls.

## The version is wrong — usually a surprise major

A release of minor changesets that lands on `1.0.0` instead of `0.10.0` means
something was promoted to a major and the fixed group spread it to the whole group.
It is nearly always a peer dependency:

- **An internal peer dependency with a range that the new version escapes.**
  `^0.9.0` means `<0.10.0` for a 0.x version, so the very next lockstep bump is
  out of range, and changesets treats an out-of-range peer bump as breaking.
  Internal peers must be ranged `*` — never a caret range, never
  `workspace:*` (changesets cannot evaluate the `workspace:` protocol as a
  semver range, so it reads every new version as out of range).
  `peerDependenciesMeta.optional` does **not** exempt anything.
- **`onlyUpdatePeerDependentsWhenOutOfRange` turned off** in
  `.changeset/config.json`. Without it, changesets majors any peer-dependent
  regardless of range.

`tests/release-manifest.test.ts` guards both. If the version is still wrong,
revert (`git checkout -- . && git clean -fd`), fix the cause, and version again
— never hand-edit the numbers afterwards.

## Publishing

```sh
bun run release        # build, publish, `changeset tag`, publish the template
git push origin main --follow-tags
```

- **Publishing needs interactive npm auth, so it runs from a human's terminal.**
  An agent should prepare the release, verify it, and stop here.
- **`Release refused: no experiment-tier receipt`** (or a receipt that "does
  not cover this candidate") means `bun run test:experiments` has not passed on
  exactly this tree, lock and inventory. Run it, then `bun run release` again;
  nothing has been published or read from the registry yet.
- A dead npm token does not say so plainly: it surfaces as a 404 "version does
  not exist" and then a 403 "cannot publish over <previous>".
- Publishing is ordered so a failure lands as little as possible, and a partial
  release is finished by **re-running `bun run release`**. It asks the registry
  which versions are already live and skips them, so the run continues where it
  stopped. Nothing gets commented out of `scripts/publish.ts` — that was the old
  runbook, and hand-editing release tooling mid-release is how a restored list
  gets forgotten. `tests/release-resume.test.ts` guards the skip.
- Publishes go out back to back, in dependency order, and the whole set is
  confirmed against the registry afterwards. Confirming between publishes used
  to stretch a run over enough minutes for the npm web-login session to
  expire: 0.36.0 stopped on its sixth package with a 403 on the login callback.
  One 2FA prompt at the first publish now covers the run.
- The confirmation poll has no deadline: it keeps asking, backing off to once
  a minute, and prints what is still propagating. 0.32.0 gave up on a healthy
  publish that merely took longer than a budget to appear. A version that never
  shows up is a registry incident — open its package page; a publish that
  failed would have stopped the run with its exit code instead.
- **`403 ... cannot publish over the previously published versions`** says that
  version is already out. Re-run: the plan skips it rather than retrying it.
- Tags are pushed by hand — `bun run release` creates them, it does not push.
  GitHub omits tag-push events when more than three tags are pushed together
  ([event limit](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push)).
  The public website's Actions workflow also reconciles the latest canonical
  release every 15 minutes; its direct trigger alone cannot observe a bulk
  `--follow-tags` push. Check the website run/provenance after a release, or
  manually dispatch the same workflow to rebuild immediately.
- **The template repository goes out as the last step of `bun run release`**,
  after the registry has confirmed every package. It has to be last: a clone of
  `schlessera/brain-template` runs `bun install` against the pin in
  `template/package.json`, so publishing it before the packages are live hands a
  new user a brain that cannot install. If that step is the one that fails, the
  packages are published and tagged and only the template is behind — re-run
  `bun scripts/publish-template.ts` on its own. It is idempotent, and
  `--dry-run` prints the file list without touching the remote.

## After publishing

- **Bump the content repo's `@schlessera/brain` pin BEFORE the deploy.**
  It must satisfy ui-server's `MIN_BRAIN_CLI_VERSION` (currently 0.41.0),
  including every command and flag the server invokes. Hygiene review needs
  0.41.0; `stats --history` and module settings need 0.40.0. The original
  0.33.0 floor covered the `--` separator but did not cover those later calls.
  A CLI below the floor refuses server startup with the required version.
  Rolling the image back does **not** roll back that pin — it lives in the
  content repo's own `package.json` and lockfile and is managed separately.
- Consumers pin these by version. A brain repo picks the release up with
  `bun update @schlessera/brain @schlessera/brain-module-*`; a deployment takes
  it through its own lockfile bump and a redeploy.
- If a release retires a local skill that was shadowing a packaged one, delete
  the local copy and run `brain skills sync`, or the fork keeps winning.

## When the release hits something not in this skill

**Capturing it is part of the release, not follow-up work.** Do it in the same
commit as the fix, while the evidence is still in front of you — every item
above was written down somewhere before it went wrong a second time, which is
exactly what this section exists to stop.

Take the first option that fits:

1. **Can a check catch it?** Add it to `tests/release-manifest.test.ts` and
   stop. A test fails the build; a checklist only helps whoever reads it.
   Anything decidable from a manifest, a config file, or a script's contents
   belongs here. Prove it fails before you fix it — reintroduce the mistake,
   watch the assertion go red, then revert.
2. **Is it a sequence, a judgment call, or something about the environment?**
   Add it to this skill, in the section it belongs to, in the same voice as its
   neighbours: what to do, and the symptom that tells you to do it. Symptoms
   matter more than causes — "lands on 1.0.0 instead of 0.10.0" is what a future
   agent will actually be looking at.
3. **Is it the reasoning behind a rule that is already here?** Put it in
   `CONTRIBUTING.md` and link it, rather than growing this file. The skill stays
   the procedure; the docs carry the why.

If a pitfall recurred despite already being written down, that is a signal about
*placement*, not diligence: the note was somewhere nothing loads automatically.
Move it into this skill or into a test.
