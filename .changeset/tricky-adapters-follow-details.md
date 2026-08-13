---
"@schlessera/brain-module-jobs": minor
---

Fix four job boards that were silently returning nothing, or storing records with no description.

`builtin` and `nodesk` had been reporting "0 jobs found, 0 errors" on every run, `jobgether`'s
category URLs had started returning HTTP 410, and `dice` stored `company: "Unknown"` (or a
stray location/job-type string) with no description at all. Roughly half the job database was
being scored on title and tags alone, because scoring reads the description.

Root causes:

- The JSON-LD extraction regex required `<script type="application/ld+json">` with no further
  attributes. Dice emits `data-testid` and `id` on that tag, so it never matched. Shared,
  attribute-tolerant extraction now lives in `src/html.ts` (`extractJsonLd`, `findJsonLdType`).
- `nodesk` serves minified HTML with unquoted attribute values (`href=/remote-jobs/…`); every
  pattern in that adapter required quotes.
- `builtin` dropped JSON-LD entirely and moved job URLs to `/job/{slug}/{id}`; it is now parsed
  from its stable `data-id="job-card-title"` / `data-id="company-title"` hooks.
- `jobgether` moved browsing to `/search-offers`. Its `?page=N` parameter is client-side and
  serves identical markup, so the extra page URLs have been dropped.

Also:

- **Detail-page enrichment.** `dice`, `nodesk`, `jobgether` and `builtin` now follow each listing
  to the job's own page for description, employer and salary, bounded by a per-run cap and a
  concurrency limit. Truncation is reported through `errors` rather than passing silently.
- **Shared JobPosting mapper** (`src/jsonld-job.ts`) — one implementation of employment-type
  mapping, both `baseSalary` shapes (including annualizing hourly/monthly rates), and date
  normalization. Jobgether emits a JavaScript `Date.toString()` for `datePosted` where every
  other source stores ISO-8601; it is now normalized on the way in.
- **Duplicate-row fix.** `dice` rows were keyed on the bare job UUID by the HTTP adapter and on
  the relative `/job-detail/{uuid}` href by the browser pass, so a unified
  `scrape --all --browser` inserted each posting twice. Both paths now agree.
- **The browser pass no longer skips invisibly.** In JSON mode a missing Chrome produced
  `browser: []`, indistinguishable from "ran and found nothing". It now reports
  `{ status, reason, results }`.
- `builtin`, `nodesk`, `jobgether` and `dice` are enabled by default, since none of them needs a
  browser or proxy any more.
