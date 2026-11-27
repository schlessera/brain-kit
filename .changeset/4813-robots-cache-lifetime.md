---
"@schlessera/brain-scrape": minor
---

`RobotsCache` no longer keeps an origin's robots.txt answer for its whole life (#4813). A definite answer (a 200, with or without rules, or a 4xx) is used for `maxAgeMs`, default 24 hours as RFC 9309 asks, and a failed fetch (a 5xx, a thrown or timed-out fetch, an exceeded bound) for `failureMaxAgeMs`, default 5 minutes; the next check after that fetches robots.txt again, and concurrent checks still share one fetch, including that reload. `maxEntries`, default 1,000, bounds the origins kept, dropping the least recently used. `RobotsCacheOptions` gains these three optional fields and a `now` clock for tests. A failed fetch still means "no rules", as before. A cache built for one scrape run behaves as it did; a cache held for days, like the hosted Apify site-permission checker's, now re-reads a site's rules daily and retries a failed fetch after five minutes instead of allowing everything until a restart.
