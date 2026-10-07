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

All seventeen packages move in lockstep through a changesets `fixed` group. One
mistake therefore lands on the whole group at once.

## Before you version

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
2. **`bun run test` and `bunx tsc --noEmit` are green.** The `tests/`
   directory holds the release guards — a failure there is about the release
   itself, not the code.
3. **New package added this cycle?** It must appear in `scripts/publish.ts`,
   `scripts/build.ts`, the `fixed` group in `.changeset/config.json`, and the
   package map in `README.md`. `tests/release-manifest.test.ts` enforces the
   first three. Include the new package in `scripts/clean.ts` as well.
   Record the issue-approved internal dependencies in
   `tests/allowed-edges.ts`, with their rationale; `tests/dependency-edges.test.ts`
   rejects a package without an edge policy. Add the package to every pack/import
   inventory in `.depot/workflows/ci.yml`, then regenerate the fork adapters with
   `bun scripts/fork-ci-adapters.ts --write`. In `publish.ts` and `build.ts`, order matters: a package must
   be listed **before** anything that depends on it.

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
the validated SDK 0.3.283 / CLI 2.1.283 pair.

```sh
bunx tsc --noEmit && bun run test && bun run build
```

## A cold build tries to download an installed CLI

`bunx @tailwindcss/cli` may search for a binary named `cli`, even though the
installed package exports `tailwindcss`, then attempt a registry download.
Name both explicitly: `bunx -p @tailwindcss/cli tailwindcss`. Diagnose against
the frozen install with `bunx --no-install -p @tailwindcss/cli tailwindcss --help`;
it must work without a warm Bun cache or network. The editorial capture CI
build exercises the actual build script with networking disabled.

## `bun run build` exits 133 with a V8 stack trace

A build that dies with `error: script "build" exited with code 133` and a
`V8_Fatal` / `ReduceStringAt` / `TurboshaftAssemblerOpInterface` stack is node's
JIT crashing, not this repo. It is not deterministic: **re-run the build**. Seen
once on node v22.18.0 while preparing 0.35.0, passing on the immediate retry
with `check-dist-types` clean afterwards. If it repeats on the same package
twice in a row, that is a different problem — bisect the package rather than
retrying a third time.

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
- **The template repository goes out as the last step of `bun run release`**,
  after the registry has confirmed every package. It has to be last: a clone of
  `schlessera/brain-template` runs `bun install` against the pin in
  `template/package.json`, so publishing it before the packages are live hands a
  new user a brain that cannot install. If that step is the one that fails, the
  packages are published and tagged and only the template is behind — re-run
  `bun scripts/publish-template.ts` on its own. It is idempotent, and
  `--dry-run` prints the file list without touching the remote.

## After publishing

- **0.33.0 and later: bump the brain repo's `@schlessera/brain` pin BEFORE the
  deploy.** The ui-server passes `--` before user-controlled positionals, and a
  pre-0.33.0 core parser eats that separator, so every search silently returns
  nothing. ui-server refuses to boot against a CLI below its
  `MIN_BRAIN_CLI_VERSION`, so the symptom is a container that will not start.
  Rolling the image back does **not** roll back that pin — it lives in the brain
  repo's own `package.json` and lockfile and is managed separately.
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
