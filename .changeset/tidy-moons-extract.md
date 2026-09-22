---
"@schlessera/brain-scrape": minor
"@schlessera/brain-module-jobs": minor
---

JSON-LD extraction moves into the scraping base, and the `JobPosting` mapping
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
