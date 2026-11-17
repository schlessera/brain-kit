---
"@schlessera/brain-ui-server": patch
---
Fix `/geo/coastline` fetching the same geometry twice under load. A request whose cache read missed could resolve after another request had already fetched, written the cache and finished, and would then fetch again. A request now joins the in-flight fetch before it reads the cache.
