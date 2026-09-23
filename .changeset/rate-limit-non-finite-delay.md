---
"@schlessera/brain-scrape": minor
---

`RateLimiter` ignores a delay that is not a finite positive number. A `NaN` or
`Infinity` delay used to hold every later delayed caller for that host forever;
now it counts as no delay, and the default still applies. A finite delay longer
than a timer can wait (2^31 - 1 ms) is waited out once at that length, where it
used to spin on the timer's 1 ms overflow. `ScrapeClient` drops an unusable
per-call `delayMs` before combining it with the site's `Crawl-delay`, so the
site's floor survives. A `Crawl-delay` longer than any crawler can wait,
including `Infinity`, now refuses the request with `RobotsDisallowedError`,
which gains an optional `reason`.
