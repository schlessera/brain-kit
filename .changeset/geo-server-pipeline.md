---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Map geometry for anywhere, not just the five fixture locations.

`MapView` draws whatever `[lon, lat]` paths it is handed and fetches nothing —
that is D13 and it stays that way. What was missing was the other half: a
server that can produce those paths for an arbitrary place. Without it the kit
had real coastline for five Mediterranean islands and a bare graticule
everywhere else, which is a demo rather than a feature.

`@schlessera/brain-ui-sdk/server` gains `fetchCoastline` and the pure geometry
behind it — `clipLine` (Liang-Barsky), `simplify` (Douglas-Peucker),
`toleranceMetres` and `prepare`. The build-time fixture pipeline shells out to
mapshaper, which is 15 MB and 31 dependencies for exactly two operations;
pulling that into a server to run per request would be the wrong trade. What
must NOT be hand-rolled is polygon ring closure, which D25 measured getting
three of five locations wrong — that is fill, and this does not attempt it.

Validated against the tool it replaces rather than assumed: the same Overpass
response through both pipelines gives **identical extents to four decimal
places**, with 16% more vertices and more separate polylines because mapshaper
joins contiguous ways.

`@schlessera/brain-ui-server` gains `GET /api/geo/coastline?bbox=w,s,e,n`,
fetched once and cached on disk forever. The cache is not an optimisation, it
is what makes using a free shared service defensible: Overpass's usage policy
is written for light interactive use, and one request per place ever is that.
Coastlines do not move, so there is deliberately no TTL. Keys are quantised to
~110 m and bucketed by render width so near-identical views share an entry, and
concurrent requests for one place collapse to a single fetch.

It cannot return a 500. Every failure path is empty geometry with a 200,
because a map without coastline is still a correct locator and a 500 is a chat
message that will not render. An empty result is never cached, so an outage
does not become permanent.

Four new environment variables, all optional: `BRAIN_UI_COASTLINE`,
`OVERPASS_URL`, `OVERPASS_USER_AGENT`, `COASTLINE_CACHE_DIR`.
