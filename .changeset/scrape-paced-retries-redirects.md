---
"@schlessera/brain-scrape": patch
---

`ScrapeClient` now paces every retry and checks every redirect. A retry after a 429, a 5xx or a failed request waits out the host's `Crawl-delay` and per-host spacing, the same as the first attempt. Redirects are followed by the client one hop at a time, at most 20, on both the native and the proxy path: each hop is checked against its own site's robots.txt and paced for its host, and a disallowed hop throws `RobotsDisallowedError` without being requested. `allowDisallowed` covers only the origin that was asked for. `Authorization` and `Cookie` headers are not sent to another origin, and a redirect to anything but http(s) is refused. `getPage` reports the final URL on the proxy path too.
