# Design kit — maps

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-15--d25-mapview-gets-real-coastline-geometry-not-tiles"></a>

## 2026-09-15 — D25: MapView gets real coastline geometry, not tiles

Maintainer's constraint: the map stays **static — no panning, no zooming** — but
must be **recognisable**, not the "radar view" the graticule alone produces.
Research and measurements in [map-geometry.md](../map-geometry.md).

**Decision: ship simplified OSM coastline as fixture data and let `MapView`'s
existing projection draw it as SVG polylines.** No tiles, no network at render
time, no key, no new dependency.

This is **not a rule change**. The design already writes the escape hatch:
*"street and coastline geometry only ever appears if the app passes real
[lon,lat] paths."* We are using the sanctioned path, through machinery the
component already has.

<a id="natural-earth-is-out--measured-not-assumed"></a>

### Natural Earth is out — measured, not assumed

Public domain and attribution-free, so it was the preferred answer on paper. It
fails on resolution. Vertices were counted inside each fixture bbox and median
segment length converted to pixels at 348px:

| Location | span | m/px | NE 10m verts | median segment |
|---|---|---|---|---|
| Ithaca | 20.9 km | 60.1 | 51 | 1 281 m = **21.3 px** |
| Gozo | 18.0 km | 51.7 | 19 | 1 675 m = **32.4 px** |
| Corfu | 51.5 km | 147.9 | 128 | 1 296 m = **8.8 px** |
| Messina | 23.6 km | 67.9 | 33 | 2 397 m = **35.3 px** |
| Troy | 29.9 km | 85.8 | 15 | 1 103 m = **12.9 px** |

Recognisable coastline needs **2-4 px** segments; NE 10m is 5-10× too coarse —
fifteen vertices for the whole Troy shoreline. Natural Earth's own spec agrees:
islands under 2 km² go in a separate file, because 10m is built for continental
scale. **Public domain and still unusable.**

<a id="osm-coastline-simplified--measured"></a>

### OSM coastline, simplified — measured

Raw Overpass coastline is ~100× over-detailed (Ithaca: 4 482 vertices, 312 KB,
median segment 0.45 px). Douglas-Peucker at **1 px of the target render**:

| Location | raw verts | simplified | JSON | gzipped |
|---|---|---|---|---|
| Ithaca | 4 482 | 735 | 13.0 KB | 3.2 KB |
| Gozo | 6 755 | 441 | 7.7 KB | 2.0 KB |
| Corfu | 22 141 | 1 293 | 23.3 KB | 5.6 KB |
| Messina | 5 074 | 211 | 3.7 KB | 1.1 KB |
| Troy | 996 | 131 | 2.3 KB | 0.7 KB |
| **all five** | | **2 811** | **50 KB** | **12.6 KB** |

Tolerance sweep on Ithaca: 0.5 px → 4.8 KB gz, 1 px → 3.2, 1.5 px → 2.6,
2.5 px → 2.1. **1 px is the knee.** For scale: one raster map tile is ~16 KB, so
**the entire five-location vector set is smaller than a single tile.**

Verified by rendering, not by reasoning: drawn at exactly 348×170 through
MapView's own Mercator maths and screenshotted headless in both themes. Gozo is
unmistakable, Messina reads as a strait, Troy reads as a coast. **Dark and paper
are the same data rendered twice** — which is the entire argument against raster,
where each theme needs its own baked image set (400-700 KB, two asset sets).

<a id="ship-stroke-only-first-fill-is-a-real-trap"></a>

### Ship stroke-only first; fill is a real trap

An outline alone is ambiguous — it does not say which side is land, and filling
is a large legibility gain. But filling needs closed rings, and **mainland
coastline never closes inside a bounding box**: Messina and Troy yielded zero
closed rings from 21 and 26 ways. Hand-rolled viewport closure was tried and
**got three of five wrong** — diagonal seams and inverted land/sea on Corfu,
Ithaca and Messina. The concept is sound; ad-hoc clipping is where it breaks.

So: **stroke-only first**, because it needs no clipper and `paths` renders it
today. Fill later via already-assembled land polygons
(`osmdata.openstreetmap.de`, which repairs OSM errors in the process) clipped
with `ogr2ogr -clipsrc` or `mapshaper` — a real clipper, not our own.

<a id="licensing--the-distinction-that-decided-this"></a>

### Licensing — the distinction that decided this

- **Rendered output is a Produced Work.** The OSMF guideline names SVG and
  raster images explicitly; a Produced Work may carry any licence. So the drawn
  map carries no share-alike.
- **The fixture geometry is a Derivative Database.** It is data, shipped to be
  read as data, so **ODbL share-alike does attach to the JSON.** That needs
  `packages/ui-kit/fixtures/geo/LICENSE` naming OSM and ODbL, plus attribution.

**Verified consequence: the npm package is unaffected.** `packages/ui-kit`
declares `files: ["src", "dist", "README.md"]`, and `bun pm pack --dry-run`
confirms **zero fixture files in the tarball**. The published package stays pure
MIT. The ODbL obligation attaches to the public repository and to the deployed
Storybook, both of which carry the LICENSE and the attribution line.

<a id="what-the-shipped-component-does"></a>

### What the shipped component does

Keep the projection, graticule and scale bar as the default — "an accurate
locator, not a picture of a map" is still right for one pin in a 348px message.
Coastline arrives through the existing `paths` prop, so consumers supply their
own geometry under their own licence.

<a id="the-rule-narrowed-rather-than-overturned"></a>

### The rule, narrowed rather than overturned

The design's stated reason — *"public tile servers block embedded clients"* — is
**factually wrong** and should be removed: OSM's policy says modern browsers in
standard configuration pass all technical requirements. The conclusion survives
on three stronger grounds:

1. **A browser component cannot set a `User-Agent`**, and OSM §3.4 treats a
   published library as an SDK that must identify itself. Every consumer would
   sit in one anonymous bucket. Both policies also say never hardcode the tile URL.
2. **Every hosted alternative needs a key we cannot commit**, and the free tiers
   needing no key forbid commercial use — which we cannot impose on consumers of
   an MIT package.
3. **Our own CI would violate the policy on every run.** It lists *"headless
   bots that pan/zoom the map to force rendering"* under bulk downloading, which
   is exactly what visual-regression screenshots are.

Replacement rule: **a published component may not fetch map tiles at render
time.** Themed backdrops, if ever wanted, are baked at build time and passed in.

MapLibre is out on determinism rather than size: v6 requires WebGL2 and throws
without it, headless falls back to SwiftShader, and its own render suite needs
`xvfb-run`. No stable visual-regression baseline. A full-screen pannable map is
a legitimate thing to build — **in the app, not in the kit.**

<a id="d25-addendum--natural-earths-coarser-scales-and-where-geometry-runs-out"></a>

### D25 addendum — Natural Earth's coarser scales, and where geometry runs out

The 1:50m scale was measured after the fact and is **worse, not better**: Gozo
drops to 8 vertices (76 px median segment), Troy to 3 (154 px). At 1:110m, four
of the five locations return **zero vertices** — the islands are not in the
dataset at all. Natural Earth's scales run the wrong way for this use: 10m is
already its most detailed. Comprehensively rejected on detail, which is what
makes OSM *necessary* rather than merely preferred — and therefore what makes
the ODbL obligation unavoidable rather than a choice.

Where coastline alone is enough, measured by rendering each at 348×170:

- **Well served:** Gozo, Corfu, Ithaca — closed island silhouettes.
- **Adequate:** Strait of Messina — two facing coasts read as a strait.
- **Weak:** Troy — a single shoreline curve is ambiguous. The fix is **roads**
  (`highway~motorway|trunk|primary`) through the same pipeline for a few KB more,
  **not a raster**. Same licence position, same theming, same determinism.

Pipeline, for when this is built:
`mapshaper -clip bbox= -simplify dp interval= -o precision=0.0001`, with
`interval = span_metres / 348` (one pixel of the target render), coordinates at
4 dp. Output is already the shape `MapView`'s `paths` prop accepts, so
**stroke-only needs no component API change.**

<a id="2026-09-28--the-map-block-the-model-names-places-the-surface-draws-them-44"></a>

## 2026-09-28 — the `map` block: the model names places, the surface draws them (#44)

D41 §2 held agent-authored pins back as "a later variant". This is that
variant. `show_block` gains `map`: 1 to 30 places with optional
coordinates. The kit gains `PlaceMap`, which is one frame, two, or none,
with a numbered list that always carries every place. `MapView` gains a
numbered pin mode whose merges are lettered. The payload is data only, as
D41 requires, and it carries nothing that shapes the drawing. The geometry
ruling, the rules that came with it, the design and the two points the
build changed are recorded in [map-geometry.md §8](../map-geometry.md#8-places-the-model-names-on-the-same-geometry--2026-09-28-44),
which is where anything about maps is decided.

The classification pass does not route to `map`. Its figures are
coordinates, and a coordinate the text does not state is exactly what the
block must never invent. That is D45's reason for leaving `trend` and `bars`
to the tool, and it applies here for the same reason.

