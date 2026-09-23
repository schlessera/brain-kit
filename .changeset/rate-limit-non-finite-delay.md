---
"@schlessera/brain-scrape": patch
---

`RateLimiter` ignores a delay that is not a finite positive number. A `NaN` or
`Infinity` delay used to hold every later caller for that host forever; now it
counts as no delay, and the default still applies.
