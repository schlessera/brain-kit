---
"@schlessera/brain-ui-sdk": minor
---

Map geometry picks its detail from how much ground fits on screen.

A coastline is the right answer for a region and the wrong one for a street: at
a kilometre across, a shoreline is one curve at the edge and the map is empty
except for its own pins. `fetchCoastline` now chooses between three tiers —
shape only, the road network, every street — and the caller does not ask, so it
cannot get it wrong.

The thresholds are the same one-pixel reasoning the simplification tolerance
uses, applied to the SPACING of a feature class rather than to its detail.
Major roads sit roughly a kilometre apart and read as a network below ~40 m/px;
minor streets sit roughly a hundred metres apart and need ~8 m/px before they
are twelve pixels apart. `detailFor(bbox, widthPx)` is the rule, and `detail`
on the request forces a finer tier for the one case a size rule cannot see — a
single shoreline curve at a span the rule calls coastline-sized.

Each tier's query now degrades on its own. The street tier is three sequential
requests and a free service under load refuses them individually; all-or-nothing
threw away a perfectly good coastline because the minor streets timed out. The
result reports `partial` when that happens, and the server route declines to
cache a partial — the cache has no TTL, so a bad afternoon would otherwise
become a street map that never gets its streets.

`GET /api/geo/coastline` takes `detail=` and keys its cache by tier: the same
box at the same width can legitimately be asked for at two levels, and serving
the coarse one for the fine request draws an empty map.
