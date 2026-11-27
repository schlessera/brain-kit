---
"@schlessera/brain-scrape": patch
---

`maxBytes` must now be a whole number of bytes, `0` or more (#4963). `ScrapeClient.getJson`, `getPage` and `getText` refuse `NaN`, `Infinity`, a negative or a fractional `FetchOptions.maxBytes` with a `RangeError` naming the option, before any request is made; `new RobotsCache()` refuses such a `RobotsCacheOptions.maxBytes` the same way. Before, `NaN` and `Infinity` silently read the whole body and a negative bound refused every non-empty one. Every valid bound behaves as before, and `0` still reads only an empty body.
