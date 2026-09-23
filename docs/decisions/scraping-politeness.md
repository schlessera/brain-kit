# Scraping politeness: robots.txt wins

**Decided 2026-09-22 by the maintainer**, on
[#153](https://github.com/schlessera/brain-kit/issues/153). Binds every adapter
in `packages/module-jobs` and every caller of `packages/scrape`.

## The rule

When a site's robots.txt and its API's capabilities disagree, **robots.txt
wins, by intent as well as by letter.** An adapter does not route around a
`Disallow` through another HTTP method, another spelling of the path, or an
alias the rule happens not to name. If the rule plainly asks a crawler not to do
something, it is not done, even when some technically compliant way of doing
it exists.

**One thing overrides it: a written yes from the site.** Asking is always
available, per site, and a yes is recorded where the next reader will find it.
Nothing else counts, including a reading of the rule that the site never
offered.

## The case that produced it

jobgether. After #35 (#146), the adapter fetches the site's JSON endpoint
`https://jobgether.com/api/v1/jobs` once per run. Measured on 2026-09-22 for
#153:

- The endpoint pages only through `?page=` / `?limit=`.
- The site's robots.txt reads:

  ```
  Allow: /
  Allow: /astroapi/ai/jobs.json
  Allow: /astroapi/ai/jobs.json?*
  Disallow: /*?*
  ```

  On `/api/v1/jobs`, `Disallow: /*?*` wins by longest match. The repo's own
  `RobotsCache` agrees: `/api/v1/jobs` is allowed and `/api/v1/jobs?page=2` is
  denied.
- The one query-string allowance is on `/astroapi/ai/jobs.json`. The site's own
  docs list that alias as deprecated, with a **2026-09-28 sunset**, and name
  `/api/v1/jobs` as its successor. After the sunset, no GET query form is
  allowed anywhere on the API.
- The same endpoint also accepts **POST with a JSON body** carrying the same
  `page` / `limit` parameters (documented under `methodNotes` in the site's API
  docs). A POST has no query string, so it would not trip `Disallow: /*?*`.

The last point is why this is a decision and not a bug. POST paging complies
with the letter of the rule while doing exactly what the rule asks a crawler
not to do.

**Outcome:** jobgether returns **ten rows per run**, the first page of the
unqualified path, against a board advertising 200,000+ postings. Runs are daily,
so it contributes about ten new or refreshed rows a day and never backfills. It
stays out of the default `SOURCES`. The cap is set where the adapter makes its
one request (`packages/module-jobs/src/adapters/jobgether.ts`), and any
detail-page enrichment (#36) is sized to those ten rows.

## A second example: a plain disallow

remotive ([#130](https://github.com/schlessera/brain-kit/issues/130)) is the
simple form of the same rule: nothing disagrees with anything. Its robots.txt
disallows `/api/*`, and `/api/remote-jobs` is the only path the adapter
fetches, so `ScrapeClient` refuses every request. It was demoted rather than
worked around. The adapter stays, it is out of the default `SOURCES`, and
`DISABLED_BY_DEFAULT` in `packages/module-jobs/src/types.ts` says it needs the
site's permission. Fixture: `packages/module-jobs/tests/fixtures/boards/remotive/robots.txt`.

## Alternatives rejected

- **POST paging without asking.** It passes the letter of `Disallow: /*?*`, on
  the reading that the rule is about query strings rather than volume, a
  reading the site never offered. It would also have needed a POST method on
  `ScrapeClient`, which has none, so it is published surface added only to
  route around a rule. Rejected. The rule exists so that the next adapter to
  meet this shape does not have to reason its way to the same answer.
- **Ask the site first, and wait.** This was not rejected as wrong. It stays
  open for jobgether and for any other site, and a written yes overrides this
  record for that site. It was not the ruling because it costs a round trip and
  an unknown wait, and the answer for the time being had to hold without one.
- **Treat an API as outside robots.txt.** robots.txt governs URL paths on the
  host, and an API path is a path. A site that wanted its API crawled freely
  could have said so, as jobgether did for `/astroapi/ai/jobs.json?*`.

## Where it is enforced

- **`RobotsCache`** (`packages/scrape/src/politeness/robots.ts`) fetches
  robots.txt once per origin and answers `isAllowed`. A 404, a timeout or a 500
  means no rules rather than a blanket disallow, so an outage is not read as a
  policy. `Crawl-delay` is honoured as well.
- **`ScrapeClient`** (`packages/scrape/src/fetch/http.ts`) checks every request
  against `RobotsCache` before the rate limiter and the network. On a
  disallowed URL it throws `RobotsDisallowedError`, and the adapter reports that
  as an error for the page rather than as an empty board.
- **`allowDisallowed`** on the fetch options is the per-site way past a
  `Disallow`. It is for a host you operate, or one you have written permission
  for, and nothing else. It is a per-call option on purpose, so there is no way
  to set it once and forget which sites it covers. Neither jobgether nor
  remotive sets it. An adapter that sets it cites the permission it relies on.
- **`SCRAPE_RESPECT_ROBOTS`** (`packages/scrape/src/config/env.ts`) turns
  enforcement off for a whole process. It exists for a run against a host you
  operate. It is an operator's switch, not an adapter's, and no adapter or
  default configuration sets it.
- **Not yet enforced on the headless-browser path.** `BrowserSession.load`
  (`packages/scrape/src/browser/session.ts`) navigates without consulting
  `RobotsCache`, so the rule binds the three `needsBrowser` boards but nothing
  checks it for them today. Tracked in
  [#244](https://github.com/schlessera/brain-kit/issues/244).

## What does not change

- Respect for robots.txt stays the default in `packages/scrape`
  (`respectRobots` defaults to true). This record is about what an adapter may
  do on top of that default, not about the default itself.
- The terms-of-service note in `packages/module-jobs/README.md` still applies.
  robots.txt is the machine-readable floor, not the whole of a site's terms.

## Corrections

**2026-09-23.** The ruling above is unchanged. Several of the statements that
describe how it plays out were wrong or too strong, found when the record was
read against the code. Each correction below supersedes the statement it quotes.
The original text is left as written.

- *"The endpoint pages only through `?page=` / `?limit=`."* Only a **GET**
  pages that way. The same endpoint pages through a POST body too, which is the
  route the rule rules out.
- *"The site's own docs list that alias as deprecated, with a 2026-09-28
  sunset … After the sunset, no GET query form is allowed anywhere on the
  API."* The docs' deprecation names the suffixless `/astroapi/ai/jobs` (as
  recorded in `packages/module-jobs/tests/fixtures/boards/jobgether/capture.json`).
  The robots.txt allowance is on `/astroapi/ai/jobs.json`, which the docs list
  as an alias. Nobody established whether the `.json` alias goes on the same
  date, so the claim that no GET query form will be allowed after it is
  unsupported. The ruling does not depend on it: `/api/v1/jobs?page=` is
  disallowed today either way.
- *"jobgether returns **ten rows per run** … The cap is set where the adapter
  makes its one request."* The limit is **one page per run**, not a count. Ten
  is the server's page size when measured (the response's own `limit: 10` in
  `packages/module-jobs/tests/fixtures/boards/jobgether/api-v1-jobs.json`). The
  adapter processes the whole page with no numeric cap and keeps every offer
  that has a title, a company and a URL. *"Runs are daily, so it contributes
  about ten … rows a day"* holds only if the host runs the module's advisory
  daily schedule and the page size stays at ten. Likewise *"any detail-page
  enrichment (#36) is sized to those ten rows"*: enrichment is sized to the
  qualifying offers on that one page, however many the server returns.
- *"`ScrapeClient` … checks every request against `RobotsCache` before the rate
  limiter and the network."* It checks the URL of each request before that
  request's first attempt. Retries are paced by backoff or `Retry-After`, not by
  `Crawl-delay`, and redirects are followed without checking the target against
  robots.txt. Both are tracked in
  [#259](https://github.com/schlessera/brain-kit/issues/259).
- *"`SCRAPE_RESPECT_ROBOTS` … turns enforcement off for a whole process."* It
  turns enforcement off only for clients built from `resolveEnv()`, which is
  how `runScrape` in `packages/module-jobs/src/scrape.ts` builds its client. A
  `ScrapeClient` constructed directly ignores it and follows its own
  `respectRobots` option.
