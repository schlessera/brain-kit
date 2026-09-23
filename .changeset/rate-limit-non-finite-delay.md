---
"@schlessera/brain-scrape": patch
---

`RateLimiter` ignores a delay that is not a finite positive number. A `NaN` or
`Infinity` delay used to hold every later delayed caller for that host forever;
now it counts as no delay, and the default still applies. `ScrapeClient` drops
an unusable per-call `delayMs` before combining it with the site's
`Crawl-delay`, so the site's floor survives. A `Crawl-delay` of `Infinity`, or
one that overflows in milliseconds, is ignored like a negative one.
