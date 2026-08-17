---
name: release
description: Use when cutting a release of the brain-kit packages — versioning, publishing to npm, or preparing a release PR — and when a release has gone wrong and needs diagnosing. Also use before adding a package, a peer dependency, or anything else that changes what a release ships.
compatibility: Requires bun (and bunx) and git. Publishing additionally needs npm with an authenticated account.
---

# Releasing brain-kit

**This skill is the procedure; `CONTRIBUTING.md` and `AGENTS.md` carry the
reasoning behind it.** Every trap listed here has actually happened at least
once, and most were documented in prose before they happened again.

Eleven packages move in lockstep through a changesets `fixed` group. One
mistake therefore lands on all eleven at once.

## Before you version

1. **Changesets exist for everything user-visible.** `.changeset/*.md`, one per
   change, each naming the packages it affects and a bump type. No changeset
   means no version bump and no changelog entry.
2. **`bun test packages tests` and `bunx tsc --noEmit` are green.** The `tests/`
   directory holds the release guards — a failure there is about the release
   itself, not the code.
3. **New package added this cycle?** It must appear in `scripts/publish.ts`,
   `scripts/build.ts`, the `fixed` group in `.changeset/config.json`, and the
   package map in `README.md`. `tests/release-manifest.test.ts` enforces the
   first three. In `publish.ts` and `build.ts`, order matters: a package must
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

```sh
bunx tsc --noEmit && bun test packages tests && bun run build
```

## The version is wrong — usually a surprise major

A release of minor changesets that lands on `1.0.0` instead of `0.10.0` means
something was promoted to a major and the fixed group spread it to all eleven.
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
bun run release        # build, publish all packages, then `changeset tag`
git push origin main --follow-tags
```

- **Publishing needs interactive npm auth, so it runs from a human's terminal.**
  An agent should prepare the release, verify it, and stop here.
- A dead npm token does not say so plainly: it surfaces as a 404 "version does
  not exist" and then a 403 "cannot publish over <previous>".
- Publishing is ordered so a failure lands as little as possible. If it fails
  midway, packages already live cannot be republished at the same version:
  comment the published names out of the list in `scripts/publish.ts`, re-run,
  then restore the list.
- Tags are pushed by hand — `bun run release` creates them, it does not push.

## After publishing

- Consumers pin these by version. A brain repo picks the release up with
  `bun update @schlessera/brain @schlessera/brain-module-*`; brain-ui takes it
  through its own lockfile bump and a redeploy.
- If a release retires a local skill that was shadowing a packaged one, delete
  the local copy and run `brain skills sync`, or the fork keeps winning.
