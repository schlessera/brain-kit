---
"@schlessera/brain-ui-kit": minor
---

ui-kit: real coastline on the map, and three MapView bugs it made visible.

Simplified OpenStreetMap coastline for five Mediterranean locations, plus roads
for Troy, drawn through `MapView`'s existing `paths` prop — no tiles, no
network at render time, no key, no new runtime dependency. **2,611 vertices,
11.6 KB gzipped for all five**; one raster map tile is about 16 KB. The
generation script is committed and re-runnable and is never run in CI.

The geometry is ODbL where the rest of the repo is MIT — a rendered map is a
Produced Work and carries no share-alike, but the JSON is a Derivative Database
and does. `fixtures/geo/LICENSE` carries the obligation, and a test asserts
that the npm tarball still contains zero fixture files, so the published
package stays pure MIT.

One new prop: `attribution`, rendered in the foot row. It is a prop rather than
something the component infers because `MapView` cannot know where a caller's
paths came from — a consumer drawing their own survey has nothing to credit.

Three fixes the coastline exposed, each invisible while there was nothing to be
wrong about:

- **Every overlay was positioned in the wrong unit.** Pins, graticule labels
  and the scale bar sat at the projected SVG pixel on a drawing that scales to
  the card's fluid width — 30% of the box out on a 232px card. They are
  percentages now, and the SVG carries `preserveAspectRatio="none"`, which is
  what the projection already assumed: `px()` and `py()` map longitude and
  latitude across the full width and height independently.
- **The scale bar claimed a distance the map was not drawn at** on any card
  that was not exactly `width` wide.
- **A pin's dot was not on its coordinate.** `translate(-50%,-50%)` centred the
  whole label row on the point, putting the dot half a label away — 19% of the
  width — and displacing two pins by different amounts according to their label
  lengths, so the distance between them was wrong too.
