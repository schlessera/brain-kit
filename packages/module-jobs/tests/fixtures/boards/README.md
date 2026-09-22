# Board fixtures

What each job board actually served, on the day it was measured, for the boards
whose adapter got it wrong. This is the durable half of issue #33: the table
below moves, the markup does not.

Every fixture is a **verbatim slice** of a real response, cut down to what a
parser reads. Where several slices come from one page they are joined by an
`<!-- ... elided ... -->` comment; where anything else was changed, the board's
`capture.json` says so in `excerpt_edited`. Raw no-break spaces are spelled
`&#160;` so the tree stays greppable (`bun run lint`); an HTML parser sees the
same character.

`capture.json` next to each fixture records the URL, the HTTP status where it
matters, the SHA-256 and byte count of the **full** response the slice came
from, and the vantage point of the capture.

## Vantage point

| | |
| --- | --- |
| Captured | 2026-09-22, 16:18–16:45 UTC |
| Egress country | DE |
| User-Agent | `brain-scrape (+https://github.com/schlessera/brain-kit)` — the shipped default |
| Browser | Chrome, headless, for the three `needsBrowser` boards |

This is not decoration. A board that geo-gates its markup, rewrites it for a
test bucket, or rate-limits one User-Agent and not another looks exactly like a
parser bug to whoever reads the fixture next. `simplyhired` answered 403 and then
200 to the same URL fifteen minutes apart from this one vantage point, and
`nodesk` returned 51 rows and then 103 — so the header above is the difference
between a reproducible result and an anecdote.

## How to re-measure

```sh
bun packages/module-jobs/scripts/measure-boards.ts <source> <out-dir> <country>
```

One board per run. It writes every response it saw to `raw/`, named with its
HTTP status, so a 410 or a 403 is kept rather than thrown away with the
exception. It needs the network, so **no test may call it** — the fixtures here
are what tests use.

To run a browser board's page extractor against a capture instead, with no
network at all:

```sh
bun packages/module-jobs/scripts/measure-boards.ts --replay <source> <file.html>
```

That launches Chrome with every hostname resolving to nothing and page scripts
turned off, so the DOM is exactly the bytes on disk. Opening a captured page in
an ordinary browser is not a replay of it: it can re-fetch what the markup
references, and the inline scripts a rendered capture contains run again and
can rebuild or drop the very cards being counted. (`page.evaluate` still works
with script execution disabled, which is what makes the extractor runnable over
a page that cannot run its own code.) The file must end in `.html`, or Chrome serves it as text and
there is no DOM to extract from.

## What the measurement found

Each board scraped on its own, 2026-09-22. "Stored" is the number of rows in
the database afterwards — not `ingestJobs`'s `new + updated`, which counts
OUTCOMES and reports two for one row when an adapter emits the same key twice.
It is rows
that survived `ingestJobs`, which drops anything with no `source_id`, `title` or
`company`.

| board | found | stored | errors | title | company | description |
| --- | --- | --- | --- | --- | --- | --- |
| `remoteok` | 99 | 99 | 0 | job titles | 91 distinct, none `Unknown` | 99/99 |
| `remotive` | 0 | 0 | 5 | — | — | — |
| `weworkremotely` | 82 | 82 | 0 | job titles | 55 distinct, none `Unknown` | 82/82 |
| `workingnomads` | 56 | 56 | 0 | job titles | 16 distinct, none `Unknown` | 56/56 |
| `builtin` | 35 | 35 | 0 | job titles | **0/35** — all `Unknown` | 0/35 |
| `nodesk` | 51 | 51 | 0 | job titles, 2 category links | **26/51** right, 18 `Unknown`, 7 a neighbour's | 0/51 |
| `simplyhired` | 20 | 20 | 2 | job titles | 20/20 | **0/20** |
| `jobgether` | 0 | 0 | 5 | — | — | — |
| `dice` | 102 | 102 | 0 | job titles | 92/102, 10 `Unknown` | **0/102** |
| `remotelyde` | 18 | 18 | 0 | **0/18** — all category chrome | 0/18 — all `Unknown` | 0/18 |
| `remoteineurope` | 0 | 0 | **0** | — | — | — |

Healthy: `remoteok`, `weworkremotely`, `workingnomads`. They have no fixture
here because there is nothing to repair.

**A rendered fixture is a second page load.** For the three `needsBrowser`
boards the harness scrapes the page and then re-opens it to capture the DOM, so
a site that rotates promoted cards or paginates differently serves a slightly
different page the second time. Replaying each extractor against that captured
page, offline (see above), gives:

| board | cards on the captured page | company blank | company right | href relative |
| --- | --- | --- | --- | --- |
| `builtin` | 19 | **19** | 0 | 0 |
| `nodesk` | 103 | 39 | 63 | 0 |
| `dice` | 35 | 0 | 35 | **35** |

**Those three rows are not reproducible from this directory**, and saying so
matters more than the numbers do. They were measured against the FULL captured
pages — 1.3 MB, 528 KB, 436 KB — which are not committed, because "small
enough to read" and "a whole rendered page" cannot both be true. What is
committed is a one-card slice of each. Each `capture.json` carries the full
response's SHA-256 and byte count, so a fresh capture can be compared against
the page these counts came from, but the count itself cannot be re-derived
here.

What the committed slices DO support is every per-card claim below, and
`tests/board-fixtures.test.ts` asserts each of them by running the real page
extractor over the slice: builtin's card yields no company, nodesk's card
yields no company, dice's card yields a relative href. Those are the facts the
repairs in #34-#37 are tested against. The page-level counts are context for
how often each one bites.

### Board by board

- **`remotive`** — `remotive.com/robots.txt` disallows `/api/*`, the only path
  the adapter fetches, so the politeness layer refuses all five category
  requests. Reported as five errors, not silently. It is still one of the six
  default-enabled `SOURCES` in `src/types.ts`. Fixture: `remotive/robots.txt`.
- **`builtin`** — the browser path works (August's "parser matched nothing" is
  closed), but the company is never extracted. `src/adapters/builtin.ts:44`
  calls `link.closest('[class*="job"], [class*="card"], …')` and the anchor's
  own class is `card-alias-after-overlay`, so `closest()` returns the anchor
  itself and the card text it scans is just the title. The company has a stable
  selector, `a[data-id="company-title"]`, contradicting the comment at `:26`.
  The same page also carries an `@graph` whose `ItemList` holds a name, a url
  and a **description** for every job on it — 19 descriptions the adapter
  throws away by reading the DOM instead. No `hiringOrganization`, so the
  company still has to come from the card.
  Fixtures: `builtin/rendered-card.html`, `builtin/listing-jsonld.html`.
- **`nodesk`** — the company is the `<h3>` under the title, but
  `src/adapters/nodesk.ts:66` looks for `a[href*="/remote-companies/"]`, and
  an Algolia hit card does not have one. Replaying the extractor against the
  captured page gives 39 of 103 cards no company at all. The slug filter at
  `:51-52` also admits category pages (`blockchain-cryptocurrency-jobs`,
  `full-time-remote`) as jobs. The seven rows the live run stored under a
  *neighbouring* company came from promoted blocks that the page rotates; the
  captured page does not hold them, so treat that count as observed, not as
  reproducible against this fixture.
  Fixture: `nodesk/rendered-card.html`.
- **`simplyhired`** — title and company parse correctly. There is no description
  anywhere in the listing markup, so every stored row has `description_text`
  NULL. The 403s are intermittent rate limiting, not a block: the same URL
  answered 200 fifteen minutes later. Fixture: `simplyhired/listing-card.html`.
- **`jobgether`** — all five category URLs in `src/adapters/jobgether.ts:6-12`
  answer HTTP 410, exactly as measured in August. The body's canonical link
  names the replacement page, and the site's own `robots.txt` explicitly allows
  a JSON endpoint carrying title, company, url, location and salary.
  Fixtures: `jobgether/response-410.html`, `jobgether/astroapi-ai-jobs.json`.
- **`dice`** — the biggest board and the best titles, but the card link's `href`
  is **relative**, and `src/adapters/dice.ts:47` stores it unchanged as both
  `source_id` and `url`, so all 102 rows carry an unresolvable URL. The company
  has a stable selector here too (`a[href^="/company-profile/"]`) while the
  adapter recovers it by scanning card text. No descriptions.
  Fixture: `dice/rendered-card.html`.
- **`remotelyde`** — two independent defects. The JSON-LD script carries
  `id="collection-page-jsonld"`, which the bare-tag regex at
  `src/adapters/remotelyde.ts:53` does not match; and the `ListItem`s inside it
  carry only `@id` and `name`, so `mapJobPosting` would skip them even if the
  regex matched. The fallback at `:102` then stores `/remote-jobs/<slug>`
  category chrome — real jobs are `/job/<slug>`.
  Fixture: `remotelyde/listing.html`.
- **`remoteineurope`** — the board no longer exists. Every configured URL
  answers 301 to `weworkremotely.com`, so the adapter parses We Work Remotely's
  markup, finds no `/job/<slug>` links, and returns **0 found with 0 errors** —
  the failure mode the epic is named after.
  Fixture: `remoteineurope/redirect-target.html`.

### How the company column is counted

`companies_ok` in the harness output is a shape check — it cannot tell a
company that is right from one belonging to the card next to it, which is the
whole of the nodesk failure. The three-way split in the table above comes from
`quality.company_vs_url`, which compares each stored company against the slug
in the posting's own URL: `matched` is the company its own URL agrees with,
`unknown` is the literal placeholder, `other` is a name that came from
somewhere else. Boards whose job URLs are opaque ids report `not_applicable` —
dice returns 92 of them, so its "92/102" is the shape check and not a
verification.

The company slug is matched as the PREFIX of the posting's own slug, not
anywhere in the path: these boards build the URL as `<company>-<title>`, so a
match anywhere counts a company that merely appears in the title, and a short
name matches almost anything. On nodesk that difference was one row.

Re-running gives a different day's numbers: nodesk answered 26/18/7 on
2026-09-22 and 28/15/8 four hours later. The method reproduces; the board does
not hold still.

## The four cross-cutting claims

PR #2 reported four problems that were not about one board. Re-measured against
`main` on 2026-09-22:

| claim | verdict | evidence |
| --- | --- | --- |
| `dice` rows duplicated because the HTTP and browser passes keyed them differently | **closed by the refactor** | There is one Dice adapter (`src/adapters/dice.ts`), registered once (`src/scrape.ts`), and `--browser` unions the source list through a `Set` (`src/cli.ts`). A live run stored 102 rows with 102 distinct `source_id`s. |
| the rate limiter lets concurrent callers burst past the pacing | **still live** | `packages/scrape/src/politeness/rate-limit.ts` reads `lastStart`, awaits, and only then claims the slot. Pinned by `packages/scrape/tests/politeness.test.ts` — "CONCURRENT callers to one host all wake at the same instant". |
| `SOURCES` shadowed by the `boards` config default | **still live** | `src/module.ts` defaults `boards` to `["remoteok"]`, and the selection in `src/cli.ts` prefers the configured boards over `SOURCES`. An ordinary `brain jobs scrape` therefore scrapes one board, and the six in `SOURCES` are reachable only via `--all` or an edited config. |
| a missing Chrome is indistinguishable from an empty browser result | **closed, but not by the cited mechanism** | Three errors naming the missing executable, and `jobs_found: 0` alongside them. The `Browser boards unavailable` branch in `src/scrape.ts` is unreachable: `createBrowserSession` launches lazily and never throws at construction. Pinned by `tests/browser-absence.test.ts`. |
