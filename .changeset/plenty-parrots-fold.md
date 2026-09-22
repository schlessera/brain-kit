---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-kit": minor
---

Land fills for a mainland view: an open coastline is closed against the viewport on the land side.

`prepareLand` used to keep only the rings that closed on their own, so an island came back filled and a mainland shore came back as a bare stroke that does not say which side is water. It now closes an open shore against the requested bbox using OSM's land-on-the-left winding: a counterclockwise walk from where the shore leaves the box to where the next shore comes in. That gets a peninsula and a bay right without deciding between them, and two shores bounding the same land — an island wider than the view, an isthmus — come out as the one ring they bound rather than as two overlapping claims.

Two things come with it. `stitch` now joins ways from both ends rather than only forward, which is what makes a shore that Overpass returned out of order one chain instead of two half-chains that close against nothing. And `prepareLand` takes an optional `onLand` witness — the road network from the same response — and drops the closure rather than drawing it when the fill turns out not to contain the roads.

New from `@schlessera/brain-ui-sdk/server`: `closeAgainstViewport`, `signedArea`, `stitch`, and the `LandOptions` type. `CoastlineResult`'s shape is unchanged; its `land` key now carries mainland rings where it was empty before. The strait fixture in `@schlessera/brain-ui-kit` is regenerated with its three land rings.
