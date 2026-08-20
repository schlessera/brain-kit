# @schlessera/brain-scrape

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
