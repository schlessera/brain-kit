# @schlessera/brain-scrape

## 0.37.0

### Minor Changes

- ba4ef6b: A job board that parses nothing says so, instead of reporting zero found and
  zero errors.

  `jobs scrape` now reports a **state** per board rather than only a count, in the
  run summary and in the `--json` envelope's `sources[]` rows: `ok`, `empty`
  (the board's own envelope, carrying no postings), `unparseable` (a page arrived,
  did not say it was empty, and yielded nothing) or `not_run` (nothing readable
  arrived at all). `empty` is the only zero-row state allowed to carry no errors, and an
  adapter may only claim it from a positive signal — an API answering with its
  envelope and an empty record list, a feed with a channel and no item markup
  at all — so a
  board with no way to prove its own empty state reports a served page it read
  nothing off as drift.

  Fed a page that is not its board's, every one of the eleven adapters now
  reports; four of them returned in silence before. `remoteineurope`, whose
  domain 301s to another job site and answers 200 there, is the one this was
  named after: it reports an error per page, and names the site that served the
  redirect. Every selected board keeps a row in the report, including one whose
  adapter never returned, and `scrape_runs.status` follows — `unparseable` and
  `not_run` are logged as `failed`, so a board that could not be read stops
  advancing its cursor.

  `@schlessera/brain-scrape` gains `ScrapeClient.getPage`, which returns a text
  body alongside the URL it was actually served from. `getText` delegates to it
  and is unchanged.

- d242f3a: `RateLimiter` ignores a delay that is not a finite positive number. A `NaN` or
  `Infinity` delay used to hold every later delayed caller for that host forever;
  now it counts as no delay, and the default still applies. A finite delay longer
  than one timer can wait (2^31 - 1 ms) is clamped to that length, where it used
  to spin on the timer's 1 ms overflow. `ScrapeClient` drops an unusable
  per-call `delayMs` before combining it with the site's `Crawl-delay`, so the
  site's floor survives. A `Crawl-delay` longer than this client can wait,
  including `Infinity`, now refuses the request with `RobotsDisallowedError`,
  which gains an optional `reason`. With `allowDisallowed` it contributes no delay,
  and the caller's own delay still applies. `SCRAPE_RESPECT_ROBOTS` is described
  as what it is: a switch for clients built from `resolveEnv()`, not the whole
  process.
- c75da0d: JSON-LD extraction moves into the scraping base, and the `JobPosting` mapping
  into one place in `module-jobs`.

  `extractJsonLd(html)` matches an `application/ld+json` script whatever other
  attributes it carries, in whatever order, quoted or not — measured against real
  boards, the bare-tag pattern this replaces saw none of them — and reports a
  malformed tag as one error instead of throwing or swallowing it.
  `jsonLdNodes`, `jsonLdByType` and `itemListEntries` flatten the four shapes a
  page serves nodes in: bare, an array, a `@graph`, or nested inside another
  node.

  On top of it, `module-jobs` gains one shared mapper: both documented
  `baseSalary` shapes reach the same internal figure, hourly and monthly rates
  are annualized through the factor `salary.ts` already uses, employment type is
  read in the spellings boards actually write, and a publication date that is not
  ISO-8601 — Jobgether serves a JavaScript `Date.toString()` — is converted or
  dropped rather than stored as an ISO string it is not. An `ItemList` that names
  jobs without describing them comes back as references, never as rows with an
  invented company.

  The remotely.de adapter loses its private copy of all of this and reads through
  the shared path instead. Wiring the remaining boards onto it is per-board work.

### Patch Changes

- f6d3e4f: `RateLimiter` grants concurrent callers to one host that have a delay one at a
  time, in arrival order (a zero-delay call still goes straight through), so they
  are spaced by the delay instead of reading the same
  last-request time and firing together. Each caller's delay is measured from
  when the previous request was actually granted and re-checked after every
  sleep, so a timer that fires late never lets the next caller in early. A
  `Crawl-delay` override still spaces its own call by the larger value.

## 0.36.0

## 0.35.0

## 0.34.1

## 0.34.0

## 0.33.1

## 0.33.0

## 0.32.0

### Patch Changes

- 82f5971: Ship the package's LICENSE file with every release.

## 0.31.0

## 0.30.1

## 0.30.0

## 0.29.0

## 0.28.1

## 0.28.0

## 0.27.0

## 0.26.0

## 0.25.0

## 0.24.0

## 0.23.0

## 0.22.0

## 0.21.0

## 0.20.0

## 0.19.0

## 0.18.0

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

## 0.16.0

### Minor Changes

- f068ec2: Make browser crash recovery testable, and give the scraper the recovery it was
  missing.

  Both packages launch Chrome lazily and cache the handle. A few lines decide
  whether a crashed browser is replaced on the next call or leaves a dead handle
  cached until the process restarts — and with `puppeteer.launch` hardcoded, the
  only way to exercise them was to start real Chrome and kill it. Both now take a
  `launch` option, so a fake browser can be crashed on demand.

  **`brain-render-puppeteer`** gains the seam and tests for all four behaviours
  that were previously "verified by inspection": a crashed browser is replaced; a
  FAILED launch is not cached (a rejected promise left there is returned to every
  future caller, so one transient failure — Chrome mid-install, a momentary OOM —
  disables rendering for the life of the process); a late crash handler cannot
  discard the browser that already replaced it; and repeated failures keep
  retrying rather than latching. Four of the five tests fail against the code
  with the recovery removed.

  **`brain-scrape` had no recovery at all.** Its session was modelled on the
  renderer's lifecycle but shipped without the `disconnected` handling, so a
  Chrome crash mid-scrape left the dead handle cached and every subsequent page
  load failed against it. Fixed, with the same identity guards and the same
  seam. This is a bug fix, not a testing improvement.

  A caller overriding `launch` owns the isolation arguments too — the renderer's
  defaults are its security posture, not a convenience.

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
