# @schlessera/brain-module-jobs

## 0.38.0

### Minor Changes

- 8e5229a: The job pipeline now lives in frontmatter. An opportunity's `status.md` records `stage` (`researching` to `offer`, or `closed`), `fit`, `applied`, `next_step` (with its date in `deadline`) and `closed_reason`.
  - `brain jobs scaffold` writes `stage: researching`, `tags: [job-search]` and the research-opportunity section set.
  - The `research-opportunity` and `interview-scheduled` skills set these fields instead of editing prose and the index table.
  - New `brain jobs pipeline` gives the opportunities' `_index.md` a registry spec, with an Active and a Closed table by `stage`, and regenerates it. From then on `brain registry` and `brain maintain` keep it current. It refuses, with the file untouched, an index whose frontmatter it cannot extend safely, and a path outside the brain root.
  - Two `jobs-stage` audit checks flag an opportunity without a stage and one still researching after 60 days.
  - A registry `split` can now be `{ key, tables: { Label: [values] } }`, one table per label.
  - `runRegistry` and `registrySpecSchema` are exported from `@schlessera/brain`.

### Patch Changes

- 12bed13: The Built In and NoDesk boards now read the company from each job card instead of storing it as `Unknown`. Built In reads the card's company link; NoDesk reads the result card's company heading and no longer takes a neighbouring card's company. Rows already stored pick up the company on the next scrape.
- 35d8fe3: The reasons recorded for the jobs boards that are off by default no longer say "Cloudflare 403 or empty responses" for three boards where that is no longer true. `builtin` now gives the browser reason `nodesk` and `dice` give, `simplyhired` names the intermittent rate limiting that was measured, and `jobgether` names the robots.txt rule that limits a run to one page.
- ddbaaa9: The `research-opportunity` and `interview-scheduled` skills now resolve the opportunity directory before writing, as `brain jobs scaffold` does: `taxonomy.types.opportunity.dir` from `brain config check --json`, else the module's `opportunitiesDir` from `brain config get`. They stop when the config is invalid or the module is not enabled, and every path they name goes through the resolved directory. A brain that moved its opportunities with `opportunitiesDir` no longer gets new files in `career/opportunities`.
- 259c934: The NoDesk board no longer stores category pages such as `full-time-remote` as jobs. It reads only the title link of each result card, and waits for the result cards rather than the page's navigation before reading.
- Updated dependencies [1751c05]
- Updated dependencies [ee55f82]
- Updated dependencies [6757475]
- Updated dependencies [e2325b2]
- Updated dependencies [3c2b20e]
- Updated dependencies [3bcb130]
- Updated dependencies [8c6a3f5]
- Updated dependencies [9ce7d84]
- Updated dependencies [61d2869]
- Updated dependencies [93e12bd]
- Updated dependencies [8c97273]
- Updated dependencies [60e9fbd]
- Updated dependencies [bad7650]
- Updated dependencies [0268bf1]
- Updated dependencies [7668c7c]
- Updated dependencies [3c1310c]
- Updated dependencies [a57da97]
- Updated dependencies [25e4911]
- Updated dependencies [00391fd]
- Updated dependencies [c7aed00]
- Updated dependencies [2ed2d21]
- Updated dependencies [a554aa7]
- Updated dependencies [e499c82]
- Updated dependencies [e89de6e]
- Updated dependencies [968d151]
- Updated dependencies [1c30db2]
- Updated dependencies [995ed30]
- Updated dependencies [d176c64]
- Updated dependencies [5bef3b7]
- Updated dependencies [ff9ebc2]
- Updated dependencies [6b30469]
- Updated dependencies [5d9a179]
- Updated dependencies [55fe04c]
- Updated dependencies [a59b3b1]
- Updated dependencies [548561f]
- Updated dependencies [2fac781]
- Updated dependencies [48377ab]
- Updated dependencies [6f9ab3b]
- Updated dependencies [82f6b55]
- Updated dependencies [54b21fe]
- Updated dependencies [5b9daa4]
- Updated dependencies [2d59201]
- Updated dependencies [8e5229a]
- Updated dependencies [dd5e87f]
- Updated dependencies [d1ad02b]
- Updated dependencies [2b02102]
- Updated dependencies [97baef6]
- Updated dependencies [f82fc83]
- Updated dependencies [9c53741]
- Updated dependencies [8e84ba8]
- Updated dependencies [d4b62d3]
- Updated dependencies [acd47da]
- Updated dependencies [faba978]
- Updated dependencies [3b71a3a]
- Updated dependencies [b5bf884]
- Updated dependencies [ff023f6]
- Updated dependencies [18c4495]
- Updated dependencies [550a41e]
- Updated dependencies [d350daa]
- Updated dependencies [e4b5251]
- Updated dependencies [51ad062]
- Updated dependencies [7e5e363]
- Updated dependencies [bc10acc]
- Updated dependencies [2025590]
- Updated dependencies [4224247]
- Updated dependencies [5b8e614]
- Updated dependencies [cc5b868]
- Updated dependencies [cb19184]
- Updated dependencies [48c4000]
- Updated dependencies [7c513fb]
- Updated dependencies [02b3d13]
- Updated dependencies [2cb91e2]
- Updated dependencies [4cdb0c3]
- Updated dependencies [806d061]
- Updated dependencies [532347f]
- Updated dependencies [02b2c85]
- Updated dependencies [803a496]
  - @schlessera/brain@0.38.0
  - @schlessera/brain-scrape@0.38.0

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

- 7581178: `remotive` is no longer enabled by default. Its `robots.txt` disallows `/api/*`,
  the only path the adapter fetches, so every run ended in five refused requests.
  The adapter stays, and `jobs scrape remotive` or a `boards` entry still selects
  it, but it can only succeed with the site's permission.
- bcb16c7: `jobs scrape` follows a job with no description to its own page on the board
  (`source_url`, only on the hosts the adapter names, never the apply link) and takes the description from that page's
  `JobPosting` structured data. This covers `nodesk`, `simplyhired`, `dice`,
  `remotelyde` and `jobgether`. `builtin` now reads its descriptions from its own
  listing's structured data. A row that already has a description, from the feed
  or an earlier run, is not fetched, and two rows for one posting cost one
  request (none, if either already has a description). The description is stored
  as the page served it and stripped once. Detail requests go through the run's shared client and the run's
  `--proxy`, so robots.txt and per-host pacing apply, with a 2 s floor between
  detail requests to one host (retries and redirects are not paced separately;
  see #259). The new `enrichment` config (`concurrency`, default 4;
  `maxDetailPages`, default 100, `0` = off) bounds them, and the cap is shared
  round-robin across boards. Each board's row in the `--json` report gains
  `jobs_enriched`, `enrichment_failed` and `enrichment_truncated`, and a non-zero
  failed or truncated count also has a line in `errors`. A failed detail page never
  costs the row. A stored row that gains a description is scored again, and an
  automatic queue or dismiss decision on it is reconsidered. A decision a person
  made is kept.
- ea9f125: Re-scraping a stored job now refreshes its `source_url` and `company`, so an
  adapter repair reaches rows stored before it. A changed company or title
  recomputes `company_normalized`, `title_normalized` and `fingerprint`, and
  rebuilds the job's full-text row. An incoming `Unknown` company never replaces
  a real one. When a row's fingerprint changes, it leaves its dedup group: it
  stops being marked as a duplicate, the rows marked as duplicates of it are
  released, and the dedup pass after the scrape regroups them.
- 97d19d9: Removed the `remoteineurope` board, which was retired because its domain now
  redirects every page to We Work Remotely (already scraped as `weworkremotely`).
  It is gone from `ALL_SOURCES` and the default `SOURCES`. `jobs scrape
remoteineurope` now exits 1 and says the board was retired. Before, it fetched
  the redirected pages and reported that it could parse nothing from them. A `boards` config that names it gets the same reason
  as a warning, and the other boards still run. The new `RETIRED_SOURCES` export
  lists retired names with their reasons.
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

- ef5fba5: No behaviour change. The jobgether adapter's comments no longer say it is
  capped at ten rows or that the endpoint can only page by query string. The
  page size is the server's, and a POST body can page too, which is the route the
  scraping-politeness decision rules out.
- a8fbf67: No behaviour change. A one-line comment in the jobgether adapter, where it
  makes its single request, now points at `docs/decisions/scraping-politeness.md`,
  the record of why the board is capped at one page.
- 75e6e19: `jobs scrape jobgether` and `jobs scrape remotelyde` store job postings again.

  Both boards reported rows that were not jobs. `jobgether` fetched five
  `/remote-jobs/<location>/<category>` pages that answer HTTP 410; it now reads
  the JSON endpoint the site's `robots.txt` points a crawler at, in one request
  with no query string, and every row carries a title, a company and an ISO
  posting date. `remotelyde` fell back to scanning `href="/remote-jobs/<slug>"`,
  which is the site's own category navigation, so every stored row was a
  navigation link with the company `Unknown`; it now parses the `/job/<slug>`
  cards, from `www` and `/remote-jobs/seite/<n>` rather than from the apex and a
  `?page=` query that both redirect. A card whose company or title cannot be read
  is dropped with an error naming the field, instead of being stored as
  `Unknown`.

- 7c79a42: `brain jobs scrape dice` stores an openable link. Dice is the only board whose
  result card carries a relative `href`, and the adapter handed it on unchanged,
  so every stored row's `url` and `source_url` was `/job-detail/<guid>` — a link
  nothing in the review queue, an opportunity doc or the CLI could follow. The
  card link is now resolved against `https://www.dice.com`, the way every other
  adapter already prefixes its origin.

  The company comes off the card's `/company-profile/` link instead of being
  guessed at by scanning the card's text lines, which had left one row in ten
  stored as the literal `Unknown`.

  `source_id` is unchanged — still the relative path — so the next scrape updates
  the rows already stored rather than inserting a second copy of each. The ingest
  upsert refreshes `url` but not `source_url` or `company`, so a row stored before
  this release keeps the older values in those two fields; new rows are correct in
  all three.

- ead8379: When a re-scraped job joins an existing dedup group, a duplicate whose canonical
  was deleted (by `jobs gc --purge` or a delete) stays hidden. Before, regrouping
  released it back into the review queue.
- e21686c: Manifest only: `happy-dom` joins this package's devDependencies, so the three
  browser boards' page extractors can be run against their committed fixtures in
  a test without launching Chrome. Nothing a consumer installs or calls changes —
  `dependencies`, `peerDependencies`, `exports` and `engines` are untouched — but
  the manifest ships, so this is recorded rather than waved through.
- Updated dependencies [dd8ae8a]
- Updated dependencies [0970d31]
- Updated dependencies [ba4ef6b]
- Updated dependencies [b3529ac]
- Updated dependencies [5f7dbb5]
- Updated dependencies [e802456]
- Updated dependencies [acad158]
- Updated dependencies [ac94af4]
- Updated dependencies [95ef35d]
- Updated dependencies [731282f]
- Updated dependencies [d242f3a]
- Updated dependencies [f6d3e4f]
- Updated dependencies [2d553e2]
- Updated dependencies [fb1d784]
- Updated dependencies [4fc7f0b]
- Updated dependencies [4157941]
- Updated dependencies [0d28bae]
- Updated dependencies [f4edb02]
- Updated dependencies [af2affb]
- Updated dependencies [c75da0d]
  - @schlessera/brain@0.37.0
  - @schlessera/brain-scrape@0.37.0

## 0.36.0

### Patch Changes

- @schlessera/brain@0.36.0
- @schlessera/brain-scrape@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [545f2f9]
- Updated dependencies [7a4b5af]
- Updated dependencies [cc48069]
- Updated dependencies [1ddc4bb]
- Updated dependencies [60e05c6]
- Updated dependencies [84b748c]
- Updated dependencies [8adb53d]
  - @schlessera/brain@0.35.0
  - @schlessera/brain-scrape@0.35.0

## 0.34.1

### Patch Changes

- @schlessera/brain@0.34.1
- @schlessera/brain-scrape@0.34.1

## 0.34.0

### Patch Changes

- @schlessera/brain@0.34.0
- @schlessera/brain-scrape@0.34.0

## 0.33.1

### Patch Changes

- @schlessera/brain@0.33.1
- @schlessera/brain-scrape@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [54725c0]
  - @schlessera/brain@0.33.0
  - @schlessera/brain-scrape@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies [82f5971]
  - @schlessera/brain-scrape@0.32.0
  - @schlessera/brain@0.32.0

## 0.31.0

### Patch Changes

- @schlessera/brain@0.31.0
- @schlessera/brain-scrape@0.31.0

## 0.30.1

### Patch Changes

- @schlessera/brain@0.30.1
- @schlessera/brain-scrape@0.30.1

## 0.30.0

### Patch Changes

- @schlessera/brain@0.30.0
- @schlessera/brain-scrape@0.30.0

## 0.29.0

### Patch Changes

- @schlessera/brain@0.29.0
- @schlessera/brain-scrape@0.29.0

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
