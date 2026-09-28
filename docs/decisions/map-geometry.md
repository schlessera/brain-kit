# Decision — map geometry, not map tiles

Why `MapView` draws real coastline and street geometry from OpenStreetMap data
committed as fixtures, rather than fetching raster or vector tiles. Recorded as
D25 in [design-kit.md](design-kit.md); this is the research behind it.

`packages/ui-kit/tools/geo/generate.ts` cites this document, because the
generator's tiering and size budget only make sense against it.

Note the licence boundary it creates: geographic data under
`packages/ui-kit/fixtures/geo/` is **ODbL, not MIT** — see the LICENSE in that
directory.

**Superseded in part.** §2.4's ruling — *do not hand-roll viewport closure* —
held until the winding was measured. §7 records what changed and why the
conclusion moved; read it before §2.4 sends you to `ogr2ogr`.

---


Researched 2026-09-15. Licensing, pricing and API claims were checked against the
provider's own page or the npm registry on that date; URLs cited inline. The
geometry numbers in §2 were **measured**, not estimated — commands and outputs
below are reproducible.

Constraint as sharpened by the maintainer: **the map stays static.** No panning,
no zooming, no interaction. The failure being fixed is legibility — today's
output is a radar view (graticule, pin, scale bar) from which you cannot tell
*where* you are. The reader must recognise real geography: a coastline, an island
shape, a road, a city outline.

Decisive properties, in order: **deterministic** (Storybook runs visual-regression
screenshots, CI is offline) · **serves dark and paper** · **no API key** (MIT
package, public demo). Fixture locations are Mediterranean: Ithaca, Troy, the
Strait of Messina, Gozo, Corfu.

---

## 1. Answer up front

**Ship simplified OpenStreetMap coastline geometry as fixture data and let the
projection `MapView` already has draw it.** It costs 0.7–5.6 KB gzipped per
location, re-themes for free because it is SVG strokes taking design tokens, is
perfectly deterministic, needs no key, and is *not a rule change* — the design
already sanctions it: *"street and coastline geometry only ever appears if the app
passes real [lon,lat] `paths`."* This is the escape hatch the design wrote, used.

**Natural Earth is not detailed enough** at this scale and has to be ruled out on
measurements, despite being the cleanest licence available (§2.1).

Pre-rendered raster stays viable but is now clearly second (§4): it cannot
re-theme, it costs ~6× more bytes, and it buys detail we do not need at 348px.

## 2. Real vector geometry through the existing projection

### 2.1 Natural Earth is too coarse — measured, not assumed

`ne_10m_coastline.geojson` and `ne_10m_minor_islands.geojson` from
`nvkelso/natural-earth-vector`, vertices counted inside each fixture bbox and
median segment length converted to pixels at 348px width:

| Location | span | m/px @348 | NE 10m verts | median segment |
| --- | --- | --- | --- | --- |
| Ithaca | 20.9 km | 60.1 | 51 | 1 281 m = **21.3 px** |
| Gozo | 18.0 km | 51.7 | 19 (+12 minor-islands) | 1 675 m = **32.4 px** |
| Corfu | 51.5 km | 147.9 | 128 | 1 296 m = **8.8 px** |
| Strait of Messina | 23.6 km | 67.9 | 33 | 2 397 m = **35.3 px** |
| Troy | 29.9 km | 85.8 | 15 | 1 103 m = **12.9 px** |

**1:50m and 1:110m are worse, as expected** — measured the same way: at 50m, Gozo
is **8 vertices** (median segment 76 px), Troy **3** (154 px), Messina **8**
(159 px). At 110m, four of the five locations return **zero vertices** — the
islands do not exist in the dataset at all. Natural Earth's scales go the wrong
direction for us; 10m is already its most detailed.

Recognisable coastline needs segments around **2–4 px**. Natural Earth 10m is
**5–10× too coarse** here — 15 vertices for the whole Troy shoreline, 19 for Gozo.
You get a blob, not an island. Natural Earth's own spec bears this out: it
separates "islands 2 sq. km or less" into a different file, i.e. 10m is built for
world and continental scales, not for a 20 km strait.

Public domain (<https://www.naturalearthdata.com/about/terms-of-use/> — *"No
permission is needed… Crediting the authors is unnecessary"*), which would have
been ideal. It simply does not have the vertices. **Rejected on detail.**

### 2.2 OSM coastline, simplified — measured

Source: Overpass, `way["natural"="coastline"](bbox); out geom;`. Raw OSM is ~100×
more detailed than needed (Ithaca: 4 482 vertices, 312 KB, median segment 27 m =
**0.45 px**). Douglas–Peucker at a tolerance of **1 px of the target render**
(implemented in ~20 lines; `mapshaper -simplify` does the same) collapses it:

| Location | raw verts | simplified | JSON | gzipped |
| --- | --- | --- | --- | --- |
| Ithaca | 4 482 | 735 | 13.0 KB | **3.2 KB** |
| Gozo | 6 755 | 441 | 7.7 KB | **2.0 KB** |
| Corfu | 22 141 | 1 293 | 23.3 KB | **5.6 KB** |
| Strait of Messina | 5 074 | 211 | 3.7 KB | **1.1 KB** |
| Troy | 996 | 131 | 2.3 KB | **0.7 KB** |
| **all five** | | **2 811** | **50 KB** | **12.6 KB** |

Coordinates rounded to 4 dp (~11 m — a fifth of a pixel here). Tolerance sweep on
Ithaca: 0.5 px → 1 091 verts / 4.8 KB gz; 1 px → 735 / 3.2 KB; 1.5 px → 593 /
2.6 KB; 2.5 px → 472 / 2.1 KB. **1 px is the knee** — below it you pay bytes for
sub-pixel detail, above it the shoreline starts visibly faceting.

Twelve kilobytes gzipped for all five locations. One raster tile is 16 KB.

### 2.3 It is recognisable — rendered and checked

Both themes rendered at exactly 348×170 through `MapView`'s own Web Mercator
maths, screenshotted headless. **Gozo is unmistakable.** Messina reads as a
strait. Troy reads as a coast with a landmass inland. Stroke colour is one token,
so dark (teal `#5bb5a2` on `#0b0d11`) and paper (`#2f7f6d` on `#f7f5f1`) are the
same data rendered twice — which is the whole argument against raster.

### 2.4 The one real difficulty: fill

Stroke-only is ambiguous — an outline does not say which side is land. Filling
land fixes it and is a large legibility gain, but needs closed rings:

- **Islands close cleanly.** Stitching coastline ways head-to-tail gave Gozo a
  3 619-vertex closed ring and Corfu a 13 059-vertex ring. Fill, done.
- **Mainland never closes** inside a bbox — Messina and Troy produced 0 closed
  rings out of 21 and 26 ways. The polygon has to be closed against the viewport
  rectangle, walking the boundary on the land side.

I hand-rolled that closure to test it. Gozo and Troy came out right; **Corfu,
Ithaca and Messina came out wrong** — a diagonal seam on Corfu, inverted land/sea
on Ithaca. The concept is fine; ad-hoc clipping is where it breaks.

**So do not hand-roll it.** Two off-the-shelf fixes, either acceptable:

- **`osmdata.openstreetmap.de` land polygons** (ODbL) — coastline ways already
  assembled into polygons, *"Some errors in the OSM data are repaired in the
  process"*, split variant for larger scales. Clip a bbox with
  `ogr2ogr -clipsrc` and the closure is done correctly for you.
- **`mapshaper@0.7.61`** (MPL-2.0, published 2026-09-09) — `-clip bbox=` plus
  `-simplify` in one pass.

**Recommendation: ship stroke-only first.** It needs no clipper, no new concept,
and `paths` already renders it today. Add `landPaths` (filled) in a second pass
once the pipeline uses a real geo tool.

### 2.5 Concrete pipeline

```sh
# 1. fetch coastline for one bbox (S,W,N,E), polite UA
curl -A "brain-kit-fixtures/1.0 (+repo url)" \
  --data-urlencode 'data=[out:json][timeout:90];way["natural"="coastline"](35.98,14.16,36.10,14.36);out geom;' \
  https://overpass-api.de/api/interpreter -o gozo.raw.json

# 2. clip + simplify at ~1px of the target render, 4dp coords
mapshaper gozo.raw.json -clip bbox=14.16,35.98,14.36,36.10 \
  -simplify dp interval=52 -o precision=0.0001 format=geojson gozo.geo.json
#   interval = metres-per-pixel at 348px = span_m / 348

# 3. emit fixture
#    { "id": "gozo", "center": [14.245, 36.045], "spanKm": 19,
#      "paths": [ [[lon,lat],…], … ],          // coastline strokes
#      "attribution": "© OpenStreetMap contributors" }
```

Output shape is **already what `MapView` accepts** — `paths: {coords: [number,
number][]; tone?: Tone; width?: number}[]`. No component API change is needed for
stroke-only; `tone` carries the theming.

Run it once, commit the JSON, never run it in CI. Overpass is for the one-off
build, not for tests — its usage policy is for interactive/light use, and a test
suite hammering it is exactly what it asks you not to do.

**Roads, if coastline is not enough** (Troy is the weak case — a single shoreline
curve). `way["highway"~"motorway|trunk|primary"](bbox)` through the same pipeline
adds a road network for a few KB more, same licence, same fixture shape, drawn at
a lower-contrast tone. Worth it only where coastline alone does not locate you.

### 2.6 Licences for this route

| Source | Licence | Attribution |
| --- | --- | --- |
| Natural Earth | **Public domain** | none required (rejected on detail) |
| OSM via Overpass | **ODbL** | `© OpenStreetMap contributors` required |
| `osmdata.openstreetmap.de` land polygons | **ODbL** | same |
| `mapshaper` (tool) | MPL-2.0 | n/a — build-time tool, not shipped |

Simplified coastline in a fixture file is a **Derivative Database**, not a Produced
Work — it is data, intended to be read as data. ODbL share-alike therefore *does*
attach to the JSON: the fixture files must be offered under ODbL. That is a
`packages/ui-kit/fixtures/geo/LICENSE` naming OSM + ODbL; it does not touch the
MIT licence of the code, and the kit ships both today's mixed-licence way. (The
rendered SVG output is a Produced Work and carries no share-alike — §3.)

## 3. Raster: what the licences actually require

Kept from the first pass because attribution applies to every option above.

**ODbL does not attach share-alike to a rendered image.** The OSMF Produced Work
guideline is explicit: *"We can clearly define things that are USUALLY Produced
Works: .PNG, JPG, .PDF, SVG images and any raster image"*
(<https://osmfoundation.org/wiki/Licence/Community_Guidelines/Produced_Work_-_Guideline>).
A Produced Work may carry any licence. What attaches is attribution (§4.3) and
§4.6 — the underlying database must be available, satisfied for unmodified OSM by
linking `openstreetmap.org/copyright`.

**The OSM tile policy** (<https://operations.osmfoundation.org/policies/tiles/>;
vector tiles are a separate service and policy at
<https://operations.osmfoundation.org/policies/vector/>) rules out fetching tiles
from a shipped component regardless of the static/interactive question:

- §3.4 treats a published library as an SDK — it must set a User-Agent naming
  itself. **A browser component cannot set `User-Agent` at all.** Every consumer
  of the kit would sit in one anonymous bucket, blocked when any one misbehaves.
- Both policies say **do not hardcode the tile URL**.
- *"Headless bots that pan/zoom the map to force rendering"* is listed by name
  under prohibited bulk downloading — that is the Storybook screenshot runner.

The README's stated reason, *"public tile servers block embedded clients"*, is
**false** and should be deleted. The policy says the opposite: *"modern web
browsers in standard configuration pass all the above technical requirements."*
The conclusion survives; the reason must be replaced.

**Hosted providers, for the record** (all rejected — key in an MIT repo):
Protomaps self-host (no key, ODbL tiles, CC0 styles, BSD-3 code, 5 flavors incl.
`dark`) is the only keyless one; CARTO vector (5M req/mo, commercial OK, no
account, `dark-matter`/`positron`) needs no key *today* but the FAQ says that may
change; **Stadia, MapTiler and Protomaps-hosted free tiers forbid commercial
use**, which we cannot impose on downstream consumers; Thunderforest 150k/mo, key.
MapLibre as a runtime renderer is off the table per the sharpened constraint —
for the record `maplibre-gl@6.9.1` (BSD-3) measures **300 KB gzipped JS**,
requires **WebGL2**, and its own render tests need `xvfb-run` on Linux.

## 4. Pre-rendered raster, re-weighed

Still deterministic, still keyless, still legitimate — and now clearly second.

- **Cannot re-theme.** One PNG per location per theme. Dark and paper are two
  separate asset sets that will drift, and any future palette change is a
  re-render rather than a token edit. Against SVG strokes that take `tone` for
  free, this is the deciding difference, not a detail.
- **~6× the bytes.** Measured live from `tile.openstreetmap.org`: z14 = 16.6 KB,
  z15 = 14.1 KB, z16 = 4.3 KB. A 348×170 viewport is ~4–6 tiles ≈ 40–70 KB per
  location; five locations × two themes ≈ **400–700 KB**, versus **12.6 KB
  gzipped** for the vector fixtures.
- It buys building footprints, landuse and labels — detail that is noise at 348px
  in a chat bubble, and that the "accurate locator, not a picture of a map"
  principle was right to exclude.
- Generation must avoid OSM's servers (their policy forbids the prefetch); it
  would come from a Protomaps `pmtiles extract`, rendered offline.

Keep it as the documented path for a *photographic* backdrop if one is ever
wanted. It is not the answer to "make this recognisable".

## 5. Attribution at 348px

Required text: `© OpenStreetMap contributors`, with "OpenStreetMap" linking to
`openstreetmap.org/copyright`. The Attribution Guidelines (adopted 2021-06-25,
<https://osmfoundation.org/wiki/Licence/Attribution_Guidelines>) leave plenty of
room:

- **Any corner** is acceptable, not only bottom-right; adjacent to the map is fine.
- It may **collapse** — on dismiss, on interaction, or automatically after five
  seconds — if the licence stays findable behind an `(i)`.
- For static images, **one instance per document suffices** — one line per
  transcript, not per `MapView`.
- Exemptions exist (fewer than 100 features; areas under 10 000 m²) but a 20 km
  span blows past the area one. **Do not rely on them**; the cost of complying is
  one 9px line.

Concretely: a `9px` mono `#8a8691` line in the existing `foot` row. It fits.
Per-provider extras do not apply on the recommended route (OSM only).

## 6. Decision

| Option | Licence | Key | Deterministic | Dark+paper | Bytes / 5 loc | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| Status quo (graticule only) | n/a | no | yes | yes | 0 | none |
| Natural Earth coastline | public domain | no | yes | yes | ~5 KB | S — **but unrecognisable** |
| **OSM coastline strokes** | **ODbL (data)** | **no** | **yes** | **yes** | **12.6 KB gz** | **S** |
| OSM land polygons, filled | ODbL (data) | no | yes | yes | ~15 KB gz | M (needs a real clipper) |
| Pre-rendered raster | MIT output, ODbL attrib. | no | yes | **no — 2 asset sets** | 400–700 KB | M |
| MapLibre at runtime | BSD-3 | usually | **no** | yes | 300 KB gz lib | L — out of scope now |

**Do this:**

1. **Now — stroke-only coastline fixtures.** Pipeline in §2.5. No component API
   change: `paths` already takes `[lon,lat]` polylines and already themes by
   `tone`. Five locations, 12.6 KB gzipped, committed, offline, keyless.
   Add the `© OpenStreetMap contributors` line to `foot` whenever `paths` carries
   OSM-derived geometry, and a `fixtures/geo/LICENSE` for the ODbL data.
2. **Next — filled land**, via `osmdata.openstreetmap.de` land polygons clipped
   with `ogr2ogr`/`mapshaper`, surfaced as a separate `landPaths` prop so fill and
   stroke theme independently. Do not hand-roll the ring closure; I tried, and it
   failed on three of five locations.
3. **Add roads only where coastline does not locate you** — Troy is the one weak
   case of the five.
4. **Amend the README.** Delete "public tile servers block embedded clients" — it
   is false. Replace with: *a published component may not fetch map tiles at render
   time — no key we can ship, no User-Agent we can set, no determinism in CI.
   Geography comes in as real `[lon,lat]` geometry, which themes with the rest of
   the kit.* The static rule stands, and it now has a true reason behind it.

The design's instinct was right and its escape hatch was the answer all along.
What was missing was not permission — it was the fixture data.

---

## 7. Viewport closure, reopened — 2026-09-22

Supersedes §2.4's *"do not hand-roll it"* and step 2 of §6. The concern was
right and the remedy was the wrong shape: what the first attempt was missing was
not a better clipper, it was **one fact**.

### What was missing

§2.4 tried to decide which side of an open shore is land from the geometry in
front of it. Nothing in a polyline says that. But OSM's own convention does:
**a coastline way is wound so that land is on its LEFT**. Measured before this
was built, and recorded in
[design-feedback.md](design-feedback.md): **486 of 486 closed rings across Gozo,
Corfu and Ithaca are counterclockwise**, which is the same statement for a ring
that encloses its land.

A polygon traversed counterclockwise also has its interior on the left. So the
shore and the land polygon agree about direction, and closing one stops being a
judgement: follow the shore, then keep going counterclockwise around the
rectangle until you are back where you started. `closeAgainstViewport` in
`packages/ui-sdk/src/server/coastline.ts` is that sentence, and the whole of it.

That single rule also settles the case §2.4's attempt got wrong. A shore that
enters and leaves through the **same edge** is a peninsula one way round and a
bay the other, wanting opposite closures — a short hop along the edge, or a walk
around all four. The direction the shore runs in already says which; nothing has
to guess.

### Why not the land polygons after all

§2.4's recommended route was `osmdata.openstreetmap.de`'s pre-assembled land
polygons clipped with `ogr2ogr`. It is still a fine route for a batch pipeline,
and it is the wrong one here for the same reason mapshaper was dropped from the
generator: this code has to run **in a request handler**, for an arbitrary bbox,
against the Overpass response it already has. A second data source with its own
download, its own staleness and its own 15-MB-class tooling to clip it is a
larger commitment than the twenty lines above, and it would still have to agree
with the coastline strokes drawn over it.

### The two things that were not obvious

- **Ways must be stitched in BOTH directions.** The original stitcher only
  walked forward from a way's end. Overpass returns ways in no particular order,
  so a walk that starts in the middle of a shore leaves the half behind it as a
  separate chain — and both halves then end *inside* the box, where a closure
  has nothing to attach to. Capo Peloro is two ways meeting at the lighthouse:
  the strait's first regeneration came out with Calabria filled and Sicily
  missing. An island never showed this, because a loop closes whichever way you
  walk it.
- **Closing each shore on its own is wrong the moment two of them bound the same
  land.** An island wider than the view, an isthmus, a coastal plain between two
  seas: each shore closes to "everything on my side", the two claims overlap,
  and the even-odd rule paints their symmetric difference — both seas, with the
  land between them left empty. An independent review of the first
  implementation produced exactly this case. The fix is to stop the boundary
  walk at the next shore's entry point rather than at the walking shore's own,
  which stitches the two sides of the strip into the one ring they bound. With a
  single shore in view the next entry IS its own, so the simple case is
  unchanged.
- **A shore that only grazes the box clips to one point, repeated.** It bounds
  nothing, and its entry and its exit are the same place — so it sits zero
  distance ahead of every other shore's exit, every walk that can reach it ends
  there, and the ring being built is thrown away. A view with a perfectly good
  mainland shore in it came back with no fill at all. Point-only pieces are
  dropped before the linking; the same tangency from the INSIDE — a lobe that
  returns to the point it came in by — is real land, so the walk takes it and
  simply does not offer a shore twice within one ring.
- **Which side is land is still not decidable from the geometry.** Wound the
  other way, the same shores link into the water between them — a shape just as
  closed and just as plausible. That is what `LandOptions.onLand` is for: roads
  are on land by definition, so a fill that does not contain them is the sea,
  and the closure is dropped rather than drawn. The map then goes back to a
  stroke, which is what it drew before any of this.

### What it measured

The strait, regenerated through the same generator, with its coastline and road
geometry coming back **byte-identical** to the committed file — the only change
is the `land` key, which went from empty to three rings: Calabria, a promontory
clipping the south edge, and the tip of Sicily closed against the west edge.
527 road vertices inside the envelope, **99.4% of them inside the fill**. The
set of six fixtures is 24.3 KB gzipped against a 28 KB guard.

The fill is still `map-land` at 6% alpha under the stroke, and still a Produced
Work — §3 and §5 are untouched.

---

## 8. Places the model names, on the same geometry — 2026-09-28 (#44)

The location card was the only caller of `/geo/coastline`: one pin, the
user's own fix. #44 asked whether the model may put pins on a map too, and
what geometry would back them.

### The ruling

The maintainer chose **arbitrary coordinate-based pins, drawn over the
existing server geometry and its cache**. A place does not have to be saved
in the brain first. The model supplies places and coordinates. The app
controls the bounds, clustering, labels and drawing, and the map stays
static. Nothing in this section changes §1–§7: no new service, no tiles, no
interaction, and the same ODbL credit.

Three rules came with the ruling, and each is now code that a test holds:

- **A missing coordinate is never an invented pin.** A place without one is
  a row in the list that says `no position`. `0, 0` and latitudes past ±85°
  are also rows and not pins: the first is almost always a missing value,
  and the second is past what Mercator draws.
- **Real geography does not verify a pin.** A coastline under a pin says
  nothing about whether the pin is right, so the card says so in words
  whenever it draws one: `Positions as given by the brain · the map does not
  check them`. A row states what its position rests on: the digits it was
  given with, an accuracy only if a source stated one, and the source.
- **No geometry is a place list, not an empty frame.** An empty answer
  from the route, or a failed request, collapses the frame to
  `No map for this area · places listed below`. The list carries every
  place, because it always does.

### What the design added

The design on #44 settled the rest:

- The list is the record and the map illustrates it. Every place is a row,
  numbered in payload order in every mode, and 30 is a schema cap that the
  model sees and has to fix.
- Names go on the map only when there are three pins or fewer and every
  name has at most 18 characters. Otherwise every pin is a numbered badge,
  and a merge is a lettered badge whose members' rows say `in A`.
- The mode comes from the coordinates alone. One frame is used when its
  envelope fits the route's 5°. Two frames are used when the pins form two
  groups that each fit. Otherwise there is no frame, and a line gives the
  great-circle distance that ruled a map out.

Two points in that design were changed during the build:

- **A frame's box is not location-card's 1.5 × 1.0 bleed.** The bleed is
  correct for one pin at the card's default height. It is not correct for a
  set of pins, whose height can dominate and which the aspect correction
  then widens. A frame now asks for the union of what `MapView` draws at
  the narrowest card (238px) and at the widest (420px), at the plan's own
  height. The SDK cannot import the kit, so `planPlaces` repeats
  `MapView`'s rule as `drawnBounds`, and
  `packages/ui-react/tests/map-block.test.ts` compares it with the kit's
  exported `mapViewBounds` in six cases at nine card sizes.
- **The plan takes no pane width.** Clustering happens in the drawing at
  the width it is laid out at. `MapView.onClusters` reports which pins
  merged, so the list and the map can never disagree about it. The plan
  itself is a function of the places only. That also means one request per
  frame, whatever the width.

### Alternatives not taken

- **Only places saved in the brain.** This would bind every pin to a
  document with a position. It needs a saved-place resolution step first,
  and it would not help an answer about somewhere the brain has not
  recorded yet. The ruling chose not to make that a prerequisite.
- **The model chooses the frame.** A span, zoom or box in the payload is a
  way to draw a misleading map: a crowded set at a zoom that hides the
  crowding, or a continent at a scale that makes two cities one dot. The
  payload has none of these fields, and unknown fields are stripped.
- **One map at any extent.** The route refuses a box wider than 5°. The
  drawing would be a continent's outline with dots on it, and the scale bar
  would be the only honest thing in it. Two frames at their own scales
  show more, and a list with a distance shows the rest.
- **Truncate past the cap on the client.** A dropped place is the failure
  the list exists to prevent. A 31-place call is a schema rejection
  instead.

### What it costs

The `show_block` input schema goes from 10,682 to 11,749 characters (+10%).
The description goes from 2,299 to 2,616 characters. The brief stays within
its measured ceiling: 11 lines and 749 characters, with `map` named once.
Nothing here needs a key or the network in a test: the render tests answer
the route themselves, and the stories draw the committed Vathy and Troy
geometry.

