# @schlessera/brain-module-speaking

## 0.34.1

### Patch Changes

- @schlessera/brain@0.34.1

## 0.34.0

### Patch Changes

- @schlessera/brain@0.34.0

## 0.33.1

### Patch Changes

- @schlessera/brain@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [54725c0]
  - @schlessera/brain@0.33.0

## 0.32.0

### Patch Changes

- @schlessera/brain@0.32.0

## 0.31.0

### Patch Changes

- @schlessera/brain@0.31.0

## 0.30.1

### Patch Changes

- @schlessera/brain@0.30.1

## 0.30.0

### Patch Changes

- @schlessera/brain@0.30.0

## 0.29.0

### Patch Changes

- @schlessera/brain@0.29.0

## 0.28.1

### Patch Changes

- @schlessera/brain@0.28.1

## 0.28.0

### Patch Changes

- Updated dependencies [e381a99]
  - @schlessera/brain@0.28.0

## 0.27.0

### Patch Changes

- @schlessera/brain@0.27.0

## 0.26.0

### Patch Changes

- @schlessera/brain@0.26.0

## 0.25.0

### Patch Changes

- @schlessera/brain@0.25.0

## 0.24.0

### Patch Changes

- @schlessera/brain@0.24.0

## 0.23.0

### Patch Changes

- @schlessera/brain@0.23.0

## 0.22.0

### Patch Changes

- @schlessera/brain@0.22.0

## 0.21.0

### Patch Changes

- @schlessera/brain@0.21.0

## 0.20.0

### Patch Changes

- @schlessera/brain@0.20.0

## 0.19.0

### Patch Changes

- @schlessera/brain@0.19.0

## 0.18.0

### Patch Changes

- @schlessera/brain@0.18.0

## 0.17.0

### Patch Changes

- a714ee1: Per-package `test` scripts now pass `--timeout 30000`, so `bun run test` inside a package no longer flakes on bun's 5s default when suites spawn the CLI.
- ef519d1: Harden the publish surface: what a consumer installs now matches what the
  declarations, bundler and runtime actually reach for.

  - `@schlessera/brain-backend-pi` declares `@earendil-works/pi-agent-core`
    (exact-pinned, like its sibling pi pins) instead of borrowing it from
    hoisting — its public `history.d.ts` types reference the package, so a
    strict installer (pnpm, npm with isolated modes) could not typecheck it.
  - `@schlessera/brain-ui-react` sets `sideEffects` to `["**/*.css"]` — the
    blanket `false` licensed bundlers to tree-shake a direct
    `import "@schlessera/brain-ui-react/styles.css"` away entirely.
  - `./theme.css` now resolves from `dist/` (copied verbatim at build) like
    `./styles.css` already did, so both stylesheets survive a dist-only tarball
    and the export map is uniform. The import specifier is unchanged.
  - `@schlessera/brain-module-finance`, `-images` and `-speaking` declare the
    same optional `@types/bun` peer that `-jobs` already carried: their module
    declaration graphs reach `bun:sqlite` types through `@schlessera/brain`.
  - Every package exports `"./package.json"` — tooling like Vite, Tailwind and
    Jest stats it, and the export map previously made that unreachable.
  - `engines.bun` is aligned with reality: bun-runtime packages require
    `>=1.3.5` (the CVE-2026-24910 floor `brain doctor` warns below), and
    packages that import cleanly under plain Node carry no bun engines field.
    Scrape keeps its (bumped) engines despite importing node-clean: its proxy
    fetch path shells out through `Bun.spawn`, so the runtime constraint is
    real even though the import is not.
  - Backend loading in `@schlessera/brain-ui-server` uses `await import()`
    instead of CJS `require()`, and only "the backend package itself is not
    installed" maps to the install-hint error. An installed-but-broken backend
    (missing transitive dep, syntax error, `ERR_REQUIRE_ESM`) now surfaces its
    real error instead of a misleading "not installed".

- Updated dependencies [210446f]
- Updated dependencies [6e1fd43]
- Updated dependencies [a714ee1]
- Updated dependencies [ef519d1]
  - @schlessera/brain@0.17.0

## 0.16.0

### Patch Changes

- @schlessera/brain@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [4d3d28a]
- Updated dependencies [0af99c4]
  - @schlessera/brain@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies [59de559]
  - @schlessera/brain@0.14.0

## 0.13.1

### Patch Changes

- Updated dependencies [01004ef]
  - @schlessera/brain@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [a4eb4d0]
- Updated dependencies [fc5c897]
- Updated dependencies [2be49b8]
  - @schlessera/brain@0.13.0

## 0.12.1

### Patch Changes

- @schlessera/brain@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [4281c59]
  - @schlessera/brain@0.12.0

## 0.11.0

### Patch Changes

- @schlessera/brain@0.11.0

## 0.10.0

### Minor Changes

- 683f3e3: Rewrite every skill description as a trigger, not a summary

  A skill's description is the entire triggering mechanism — it is all an agent
  sees when deciding whether the skill is relevant to what the user just asked.
  Most of these descriptions were written as summaries: they led with what the
  skill does and how it works, and appended a short "Use when …" clause at the
  end. Some had no trigger at all.

  All 24 shipped descriptions now lead with the situation that should pull the
  skill in, phrased the way a user would actually put it, with mechanism left to
  the body where it belongs. `content-hygiene`, `sync` and `talk-ideas` gained a
  trigger they never had.

  Three CI gates keep it that way: shipped skills must lint clean (no errors _and_
  no warnings), must describe when to use them, and must stay within the
  specification's 1024-character cap.

### Patch Changes

- Updated dependencies [e6f55e0]
- Updated dependencies [e33db75]
- Updated dependencies [50f6ec7]
- Updated dependencies [683f3e3]
- Updated dependencies [fc79a8f]
  - @schlessera/brain@0.10.0

## 0.9.0

### Patch Changes

- @schlessera/brain@0.9.0

## 0.8.0

### Patch Changes

- @schlessera/brain@0.8.0

## 0.7.2

### Patch Changes

- @schlessera/brain@0.7.2

## 0.7.1

### Patch Changes

- @schlessera/brain@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [b8cbf72]
  - @schlessera/brain@0.7.0

## 0.6.3

### Patch Changes

- @schlessera/brain@0.6.3

## 0.6.2

### Patch Changes

- @schlessera/brain@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [89d8a72]
  - @schlessera/brain@0.6.1

## 0.6.0

### Patch Changes

- @schlessera/brain@0.6.0

## 0.5.1

### Patch Changes

- @schlessera/brain@0.5.1

## 0.5.0

### Patch Changes

- @schlessera/brain@0.5.0

## 0.4.0

### Patch Changes

- @schlessera/brain@1.0.0

## 0.3.0

### Patch Changes

- Updated dependencies [9e4668b]
- Updated dependencies [e08752c]
  - @schlessera/brain@0.3.0

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.
- Updated dependencies
  - @schlessera/brain@0.2.1

## 0.2.0

### Minor Changes

- rename brainform to brain-kit

### Patch Changes

- Updated dependencies
  - @schlessera/brain@0.2.0
