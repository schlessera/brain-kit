---
"@schlessera/brain-scrape": patch
---

`RateLimiter` grants concurrent callers to one host one at a time, in arrival
order, so they are spaced by the delay instead of reading the same
last-request time and firing together. Each caller's delay is measured from
when the previous request was actually granted and re-checked after every
sleep, so a timer that fires late never lets the next caller in early. A
`Crawl-delay` override still spaces its own call by the larger value.
