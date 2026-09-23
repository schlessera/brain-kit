---
"@schlessera/brain-scrape": patch
---

`RateLimiter` reserves a host's slot before it waits, so concurrent callers to
one host are spaced by the delay instead of reading the same last-request time
and firing together. A `Crawl-delay` override still spaces its own call by the
larger value, and the caller behind it queues from that later slot.
