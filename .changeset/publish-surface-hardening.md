---
"@schlessera/brain": patch
"@schlessera/brain-module-finance": patch
"@schlessera/brain-module-images": patch
"@schlessera/brain-module-jobs": patch
"@schlessera/brain-module-speaking": patch
"@schlessera/brain-render-template": patch
"@schlessera/brain-render-puppeteer": patch
"@schlessera/brain-scrape": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-server": patch
---

Harden the publish surface: what a consumer installs now matches what the
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
