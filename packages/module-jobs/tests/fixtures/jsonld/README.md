# JSON-LD fixtures

The structured data real job boards actually serve, for the shared extractor
(`packages/scrape/src/parse/jsonld.ts`) and the shared `JobPosting` mapper
(`packages/module-jobs/src/jsonld.ts`).

These are DETAIL pages, which is where the vocabulary is complete. The listing
pages live next door in [`../boards/`](../boards/README.md) and carry the other
half of the picture: `builtin/listing-jsonld.html` is an `@graph` whose
`ItemList` entries have no `@type`, and `remotelyde/listing.html` is a
`CollectionPage` whose entries carry only an `@id` and a `name`.

Every file here is whole `<script>` elements lifted verbatim out of one
response, joined by an `<!-- ... elided ... -->` comment where the page served
more than one. Nothing inside the JSON was rewritten except invisible
codepoints, which are spelled as `\u` escapes so the tree stays greppable
(`bun run lint`); a JSON parser sees the same characters. `capture.json`
records the URL, the SHA-256 and byte count of the **full** response each slice
came from, and the vantage point.

## Vantage point

| | |
| --- | --- |
| Captured | 2026-09-22, ~19:30 UTC |
| Egress country | DE |
| User-Agent | `brain-scrape (+https://github.com/schlessera/brain-kit)` — the shipped default |
| Transport | plain HTTP, no browser |

## What each one is here to prove

| fixture | shape | why it is in the tree |
| --- | --- | --- |
| `remotelyde-detail.html` | bare `JobPosting` | The type attribute comes **second** (`id="job-posting-jsonld" type="…"`). Its sibling `BreadcrumbList` is the same `ListItem` → `{@id, name}` shape as a job listing, and must not be read as jobs. |
| `nodesk-detail.html` | bare `JobPosting` | The attribute value is **unquoted** (`type=application/ld+json`). `employmentType` is an array; `baseSalary` is the long form, `minValue`/`maxValue`/`unitText: YEAR`. |
| `simplyhired-detail.html` | bare `JobPosting` | `data-next-head` after the type attribute, and an **hourly** `baseSalary` — the annualization case. |
| `dice-detail.html` | bare `JobPosting` | `data-testid` and `id` after the type attribute — the exact shape PR #2 recorded as the reason Dice matched nothing — and the **short** `baseSalary` form, a number straight on the `MonetaryAmount`. |
| `jobgether-offer.html` | three scripts: `BreadcrumbList`, `JobPosting`, `@graph` | `datePosted` is a JavaScript `Date.toString()`. The `@graph` holds `Organization`/`WebSite`/`WebPage` nodes that are not jobs. |

## Two shapes that could not be captured

Both are in the mapper because schema.org and Google's own `JobPosting`
reference document them, and both are covered by unit tests over inputs
assembled from nodes captured here. Neither was observed on **17 pages across
14 hosts** probed on 2026-09-22 — the eleven registered boards plus
`arbeitnow`, `stepstone`, four ATS hosts (`recruitee`, `greenhouse`, `ashby`,
`bamboohr`) and `teamtailor`:

- **A top-level JSON array of nodes.** Every page that served more than one
  node used either several `<script>` tags (remotely.de, Jobgether) or a
  `@graph` (Built In, Jobgether, arbeitnow).
- **A `baseSalary` quoted per `MONTH`.** Only `YEAR` and `HOUR` were seen,
  including on the German and Austrian postings.

## The `Date.toString()` publication date, re-measured

PR #2 recorded in August that Jobgether serves `datePosted` as a JavaScript
`Date.toString()` rather than ISO-8601. Issue #33 could not re-measure it,
because the five category URLs in `src/adapters/jobgether.ts` answer HTTP 410
and there was nothing left to read it from.

The **offer** pages answer 200, and the defect is still live:

```json
"datePosted": "Tue Sep 22 2026 06:31:26 GMT+0000 (Coordinated Universal Time)",
"validThrough": "2026-11-22T06:31:26.510Z"
```

Same posting, same page, one field ISO and the other not. So the acceptance
criterion that called for it is a reproduced finding rather than a defensive
requirement.
