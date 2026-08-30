# @schlessera/brain-module-jobs

## 0.28.1

### Patch Changes

- @schlessera/brain@0.28.1
- @schlessera/brain-scrape@0.28.1

## 0.28.0

### Patch Changes

- Updated dependencies [e381a99]
  - @schlessera/brain@0.28.0
  - @schlessera/brain-scrape@0.28.0

## 0.27.0

### Patch Changes

- @schlessera/brain@0.27.0
- @schlessera/brain-scrape@0.27.0

## 0.26.0

### Patch Changes

- @schlessera/brain@0.26.0
- @schlessera/brain-scrape@0.26.0

## 0.25.0

### Patch Changes

- @schlessera/brain@0.25.0
- @schlessera/brain-scrape@0.25.0

## 0.24.0

### Patch Changes

- @schlessera/brain@0.24.0
- @schlessera/brain-scrape@0.24.0

## 0.23.0

### Patch Changes

- @schlessera/brain@0.23.0
- @schlessera/brain-scrape@0.23.0

## 0.22.0

### Patch Changes

- @schlessera/brain@0.22.0
- @schlessera/brain-scrape@0.22.0

## 0.21.0

### Patch Changes

- @schlessera/brain@0.21.0
- @schlessera/brain-scrape@0.21.0

## 0.20.0

### Patch Changes

- @schlessera/brain@0.20.0
- @schlessera/brain-scrape@0.20.0

## 0.19.0

### Patch Changes

- @schlessera/brain@0.19.0
- @schlessera/brain-scrape@0.19.0

## 0.18.0

### Patch Changes

- @schlessera/brain@0.18.0
- @schlessera/brain-scrape@0.18.0

## 0.17.0

### Patch Changes

- 210446f: Unify boolean environment parsing across all packages: every boolean variable
  now accepts 1/true/on/yes and 0/false/off/no (case-insensitive, trimmed), and
  an unset, empty, or unrecognised value falls back to the variable's documented
  default instead of being misread. Defaults and directions are unchanged;
  previously `"1"`-only flags (the Chrome sandbox switches, `TRUST_PROXY`,
  `BRAIN_UI_DANGEROUSLY_DISABLE_AUTH`, `BRAIN_UI_ALLOW_PASSWORD`,
  `BRAIN_UI_ALLOW_LOOPBACK_ORIGIN`) accept the full truthy set, and the disable
  set for `BRAIN_UI_REVERSE_GEOCODE` / `BRAIN_UI_MODEL_DISCOVERY` gains `no`.
  `NO_COLOR` keeps its presence-based contract. Published descriptor types
  (`ENV_VARS` shapes) are unchanged.
- 6e1fd43: Fix per-connection protocol state never reaching the WS dispatcher (declared
  protocolRev was dropped, so the rev-3 turnId-echo requirement was never
  enforced), extract the tool-view diff engine into `lib/diff.ts`, and clean up
  dead imports/variables surfaced by the new oxlint gate.
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
  - @schlessera/brain-scrape@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [f068ec2]
  - @schlessera/brain-scrape@0.16.0
  - @schlessera/brain@0.16.0

## 0.15.0

### Minor Changes

- f429307: Add `@schlessera/brain-scrape`, the scraping base, and move `module-jobs` onto
  it.

  `module-jobs` had grown two scrapers. One was an `adapters/` directory behind a
  base class with a `needsBrowser` flag; the other was a `browser-scrape.ts` with
  its own inline site registry, its own hand-rolled CDP-over-WebSocket client and
  its own copy of the ingest path. BuiltIn was implemented in both. Only one of
  the two paths honoured the flag that was supposed to tell them apart, and the
  second one required the user to start Chrome on port 9222 by hand.

  There is now one implementation per site and one way in. `needsBrowser` decides
  whether an adapter is handed an HTTP client or a browser session; both arrive
  through the same context. `browser-scrape.ts`, its CDP client, its ingest path
  and the CLI's parallel browser pipeline are all gone — `--browser` and
  `--browser-only` survive as source selectors.

  What the base package adds that nothing had before:

  - **robots.txt, enforced by default**, cached per origin, with `Crawl-delay`
    raising that host's rate-limit floor. A disallowed URL throws instead of being
    fetched; `allowDisallowed` is a per-call opt-out, so it is always visible
    which site it applies to. A missing or failing robots.txt is permissive — an
    outage is not a policy.
  - **A rate limiter you own.** The previous one kept its clock in a module-level
    Map shared by every caller in the process, so two independently-configured
    scrapers silently throttled each other and a test inherited the previous
    test's timings.
  - **An honest default User-Agent.** It identifies the package instead of
    impersonating Chrome. Sites that filter on User-Agent will refuse it; that is
    now a deliberate per-site decision rather than something every consumer
    inherits.
  - **`puppeteer-core` as an optional peer**, replacing the hand-rolled CDP
    client, with lazy launch, idle close, a per-page wall-clock budget and a
    bounded concurrency queue. It deliberately does not share an instance with
    `@schlessera/brain-render-puppeteer`: that renderer runs with JavaScript off
    and network denied, which is the exact inverse of a scraper.

  **Breaking for `module-jobs` importers:** `scrapeSites` is gone (browser boards
  are ordinary sources now) and `ScraperAdapter` gains `bind(ctx)`. The FX rate
  table moved out of `types.ts`: it is stale by construction in a published
  package, so `rates` in the module config now overrides it per currency.
  `CHROME_CDP_URL` still works, and `SCRAPE_CHROME_URL` wins when both are set.

### Patch Changes

- Updated dependencies [4d3d28a]
- Updated dependencies [0af99c4]
- Updated dependencies [f429307]
  - @schlessera/brain@0.15.0
  - @schlessera/brain-scrape@0.15.0

## 0.14.0

### Minor Changes

- 59de559: - Added: every package reads the environment in one chokepoint that declares
  each variable, exports the contract (`ENV_VARS`, `resolveEnv`, `readEnvVar`)
  from the package entry, and generates its README env table from it.
  - Added: `ui-server` exports a resolved `ServerConfig` and returns an app handle
    (`config`, `db`, `wsHost`, `isTurnActive`, `cancelActiveTurns`, `close`), so
    two differently-configured apps coexist in one process.
  - Added: `openBrainDb`/`withBrainDb` gate every `brain.db` read on
    `schema_version`; `assertBackendResolvable` refuses to boot when the selected
    agent backend is not installed.
  - Changed: `@schlessera/brain-backend-claude` is an optional peer of
    `ui-server`, not a dependency — a deployment declares the backend it uses.
  - Changed: the module contract carries the config generic through
    `CommandContext`, `HygieneContext` and `CommandModule`, so a module author no
    longer casts a value the loader already validated.
  - Changed: the Gemini providers no longer delete and restore `GOOGLE_API_KEY`
    around client construction.
  - Removed: `configureDb`, `getDb`, `closeDb`, `configureWsHost`,
    `defaultWsHost`, `cancelActiveTurn`, `isTurnActive`, the `brainClient`
    namespace and the `getBackends`/`getBackendsInfo` module functions — their
    replacements live on the app handle.

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

### Minor Changes

- 0eb1b03: Ship three skills and make `jobs scrape` cover both source kinds in one run.

  - **Skills** (`jobs-review`, `research-opportunity`, `interview-scheduled`) — the
    module shipped a CLI and no skills, so the conversational half of the workflow
    lived only in the reference brain. Generalized: no personal names, CV variants,
    or example slugs, and they read the configured `criteria` file and
    `opportunitiesDir` rather than hardcoded paths.
  - **`scrape --browser` is now additive.** It ran _instead of_ the API pass, so no
    single invocation ever covered both — and the module's own cron entry therefore
    silently omitted every browser-only board. `--browser` now appends the Chrome
    pass to the API pass, `--browser-only` keeps the exclusive behavior, and the
    cron entry is `jobs scrape --all --browser`. The Chrome pass probes for a
    reachable browser first and skips with a clear message when there is none, so a
    host without Chrome loses the browser boards rather than the whole scrape.

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
