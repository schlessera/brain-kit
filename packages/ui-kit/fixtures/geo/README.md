# Independent closure witnesses

The generated geometry and `closure-probes.json` have separate lifecycles.
The latter records a land and a sea witness for each expected shore closed
against the fetch envelope, including pieces with no roads. Geographic IDs
describe the shore rather than its position in the generated `land` array.
The ODbL notice in [LICENSE](LICENSE) covers the source coordinates here.

## Provenance

The probe classifications were checked against a **separate raw OSM query**,
using the six fixture fetch envelopes and `way["natural"="coastline"]`, with
`out meta geom`. The Overpass snapshot is `2026-09-30T13:42:06Z`. Each point
records a directed segment from that response, its way ID and way version.
Only coordinates and identifiers are retained; contributor account metadata
is unnecessary. Inspect the way's history at
`https://www.openstreetmap.org/way/<way>/history/<version>` and the surrounding
raw shore, not the generated fill.

[OSM's coastline convention](https://wiki.openstreetmap.org/wiki/Tag:natural%3Dcoastline)
puts land to the left and water to the right of a directed way. Land witnesses
lie on the land side of the nearest raw shore; sea witnesses lie on the water
side, with surrounding shores checked to avoid narrow inlets or another island.
The stored segments make this classification auditable offline. This verifies
the fixture against OSM's geography, not against survey-grade shore positions.

Generated polygons helped locate candidate points with interior clearance;
they did **not** supply the expected classifications. Candidates were checked
against unsimplified, unclipped upstream segments before the fill was tested.
Neither `closeAgainstViewport` nor the current filled side supplies an answer
in the expectation file. The historical winding/road evidence in
[map-geometry](../../../../docs/decisions/map-geometry.md) remains complementary.

## Precision and review

Four-decimal coordinate rounding moves a vertex by at most
`sqrt(2) * 0.00005` degrees. Every witness exceeds that clearance from the raw
shore segment, generated boundaries and fetch-envelope edges. The tests also
read MapView's actual SVG and check clearance after its 0.1-pixel rounding;
both the path and the projected witness can move by half a pixel step.
Chromium's `isPointInFill` verifies the result without the test's ray caster.

The Sicily south sliver in Messina is narrower than the road gate's `1e-4`
degree exclusion. Its witness still exceeds the explicit coordinate rounding
bound and passes the SVG rounding check. The road gate keeps its existing
exclusion. Simplification tolerance is **not** permission to accept either
side of a probe: the raw-source side and the simplified/pixel side must agree.
If that cannot be demonstrated, investigate the geometry and record the gap
on the issue; do not skip the shore or widen an acceptance tolerance.

When regenerating fixtures, first inventory observed closures, then reconcile
them against these independent records. Every observed closure must match
exactly one land witness and every expected witness exactly one closure. A
removed expectation, added closure or missing closure fails coverage review.
Choose new points from separately inspected upstream geography, record the
source version/segment and review land/sea classifications before testing the
generated fill. Retain stable IDs when the same shore merely changes array
position. Do not regenerate expectations automatically from polygons.

Run the coordinate/projection suites and the visual project's browser checks.
The tests delete each closure in memory and replace it with its complement
inside the fetch envelope (viewport XOR original ring under even-odd). Both
mutations must produce named failures for that shore. Reversing winding alone
leaves even-odd fill unchanged and is not an inversion test. Existing roads,
pixel probes and screenshot baselines remain additional evidence.
