---
"@schlessera/brain-scrape": minor
"@schlessera/brain-module-travel": patch
---

`ScrapeClient` gains `addressPolicy: "any" | "public-only"` (default `"any"`) and a `lookup` option (#2502). `"public-only"` is for callers that fetch a URL a user supplied. It refuses loopback, private, link-local, documentation and other non-public addresses with the new `NonPublicAddressError`, on the initial request, every redirect hop and the robots.txt fetch, whether or not `respectRobots` is on. The request then connects to the address that was checked, keeping the host name for `Host` and TLS verification, so a changed DNS answer cannot redirect it. A request through a proxy cannot be pinned this way; the README describes that window.

The robots.txt fetch now identifies itself with the client's User-Agent instead of Bun's default. It follows at most 5 redirects one hop at a time and refuses a body over 1 MiB, and `RobotsCacheOptions` gains `userAgent`, `maxBytes`, `maxRedirects`, `addressPolicy` and `lookup` to change that. Hitting a bound counts as a failed fetch and stays permissive. A redirect to a URL with embedded credentials is now refused. Travel's route import uses `"public-only"` instead of its own private address check, with the same refusals.
