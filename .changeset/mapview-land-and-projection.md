---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-sdk": minor
---

MapView: a subtle land fill, and a projection that no longer stretches.

**Land.** A coastline stroke says where the edge is and not which side of it is
water, which is the first thing a reader needs. `MapView` gains a `land` prop —
separate from `paths`, because a route is a line somebody travelled and land is
the ground it was travelled over — drawn as one `<path>` with `fill-rule:
evenodd` so a lagoon inside an island comes out as a hole. `--bk-map-land` is 6%
white; 3.5% was tried first and was genuinely invisible.

Islands only, and that is a measured decision rather than a limitation accepted
by default. An island's coastline stitches head-to-tail into a closed loop and
is land beyond argument; a mainland shore has to be closed against the viewport,
which D25 measured getting three of five locations wrong. Verified before
building that OSM's land-on-the-left winding holds — 486 of 486 closed rings
counter-clockwise — so the mainland case is now a contained second step rather
than a research problem.

`@schlessera/brain-ui-sdk/server` gains `closedRings` and `prepareLand`. Ring
simplification splits at the two most distant vertices so the loop cannot be
opened, and land is built from RAW ways: clipping and simplifying both move
endpoints, and a way whose endpoint moved no longer meets its neighbour.

**The projection.** It mapped longitude across the full width and latitude
across the full height independently, so a degree of each stopped being the same
distance on screen — an island got wider as the window did and the scale bar was
only true east-west. The projection is now built for the width the card actually
is, and the bbox is expanded on its short axis until one pixel is the same
distance both ways. Expanded, never cropped: a wider card shows more ground at
the same scale rather than the same ground stretched.

`spanKm` consequently means the span across the WIDTH. Applied to both axes it
made a card captioned "18 km" draw forty, because with one scale a minimum on
the short axis lets the long one show roughly twice it.
