# @schlessera/brain-scrape

The scraping base for brain-kit modules that fetch from the web: an HTTP client
that obeys `robots.txt` and paces itself per host, an optional headless-Chrome
session for pages that only exist after JavaScript runs, HTML and feed parsing,
and one site-adapter seam.

It knows nothing about what is being scraped. Job postings, articles, prices —
that is the consuming module's business, and this package has no dependency on
`@schlessera/brain` to make sure it stays that way.

## Why it exists

`@schlessera/brain-module-jobs` had grown two scrapers. One was an
`adapters/` directory behind a base class with a `needsBrowser` flag; the other
was a separate module with its own inline site registry, its own hand-rolled
CDP-over-WebSocket client, and its own copy of the ingest path. One site was
implemented in both. Neither honoured `robots.txt`, both shared a
process-global rate-limit clock, and the default `User-Agent` impersonated
Chrome.

## Usage

```ts
import { ScrapeClient, runAdapters, ok, type SiteAdapter } from "@schlessera/brain-scrape";

const listings: SiteAdapter<Listing> = {
  id: "example",
  name: "Example Board",
  needsBrowser: false,
  needsProxy: false,
  async scrape(ctx) {
    const html = await ctx.http.getText("https://example.com/list", { delayMs: 2000 });
    return ok(parse(html));
  },
};

const outcomes = await runAdapters({
  adapters: [listings],
  client: new ScrapeClient({ userAgent: "my-tool (+https://example.com/bot)" }),
});
```

## Politeness

Enforced by default, because this is a library and the consumer who never
thinks about it should still behave.

- **`robots.txt`** is fetched once per origin, cached for the process, and
  applied before any request goes out. A disallowed URL throws
  `RobotsDisallowedError` rather than being fetched. The escape hatch is
  per-call — `{ allowDisallowed: true }` — so it is always visible which site
  it applies to.
- **`Crawl-delay`** raises that host's rate-limit floor. Most scrapers that
  parse `robots.txt` at all still ignore this directive; it is the one that
  actually protects the site operator.
- **A missing or broken `robots.txt` is permissive.** A 404 means no rules; a
  timeout or a 5xx means the site could not tell us its rules, and treating
  that as a blanket `Disallow` would make an unrelated outage look like a
  policy decision.
- **Rate limiting is per host and per client instance.** Two clients do not
  throttle each other, and a test constructs one with an injected clock.
- **The default `User-Agent` identifies this package.** Sites that filter on
  `User-Agent` will refuse it — that becomes a deliberate per-site
  configuration decision instead of a package-wide default that makes every
  consumer misrepresent themselves.

## Headless Chrome

`createBrowserSession()` needs the optional peer `puppeteer-core`. It is
optional because most scraping is HTTP and should not drag in a browser
driver.

The lifecycle is modelled on `@schlessera/brain-render-puppeteer` — lazy
launch, idle close, a wall-clock budget per page, a bounded concurrency queue —
but the two must never share an instance. That renderer's identity is
"JavaScript off, network denied", because it renders caller-supplied HTML next
to personal data. A scraper is the exact inverse. Two packages, two postures,
no flag between them.

## Configuration

<!-- env:begin -->

| Variable | What it controls | Unset |
| --- | --- | --- |
| `SCRAPE_CHROME_NO_SANDBOX` | Set to 1 to launch Chrome with --no-sandbox. Required only when the process runs as root (a container). Weaker: a renderer exploit then lands on the host user. | unset (sandbox stays on) |
| `SCRAPE_CHROME_PATH` | Chrome/Chromium executable to launch for browser-rendered sites. Unset falls back to the usual distro paths. | — |
| `SCRAPE_CHROME_URL` | DevTools endpoint of an ALREADY RUNNING Chrome to drive instead of launching one (e.g. http://127.0.0.1:9222). Unset means this package launches and owns its own browser. | — |
| `SCRAPE_RESPECT_ROBOTS` | Set to 0/off/false to stop enforcing robots.txt process-wide. The per-site opt-out is preferred; this exists for a run against a host you operate. | on |
| `SCRAPE_USER_AGENT` | User-Agent sent with every request, and the token matched against robots.txt groups. Override per site via fetch options rather than globally where possible. | brain-scrape (+https://github.com/schlessera/brain-kit) |

Generated from `packages/scrape/src/config/env.ts` by `bun run env-docs`. Edit the descriptor, not this table.
<!-- env:end -->

## Adapters

`SiteAdapter` is the only way in. `needsBrowser` is what decides whether an
adapter is handed an HTTP client or a browser session — not a convention, not a
second code path. `runAdapters` creates the browser only if some selected
adapter wants one, and an adapter that needs a browser on a host without Chrome
reports that in its own result while the rest of the run completes.

For sites whose markup is genuinely declarative, `SiteSelectors` + `extractCards`
express the whole extraction as data, so a broken selector is a config edit
rather than a release.
