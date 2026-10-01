# Shared geo ownership and track evidence

## Ownership — 2026-10-01

The [#525 ownership ruling](https://github.com/schlessera/brain-kit/issues/525#issuecomment-5927878544)
selects a separate concrete `@schlessera/brain-geo` package. Core owns the geo CLI;
SDK server and content modules consume the same implementation. A geo dependency
back on a consumer would couple standalone operations to the UI/content world or
create a cycle. A provider registry would add the seam the ruling excludes.
Concrete endpoint configuration provides replacement without a framework.

The library joins the existing fixed release group. It builds/publishes before
its consumers, with source/dist exports and packed import coverage. The root
geometry entry point contains no server I/O or rasterizer dependency; server
operations remain a separate import boundary.

## Shared XML parsing and recovery — 2026-10-01

The [recovery B ruling](https://github.com/schlessera/brain-kit/issues/525#issuecomment-5930250252)
requires usable sections, exact omissions and partial evidence instead of dropping
an otherwise readable file. Connecting points across an omission invents a line,
distance and elapsed interval. Rejecting the whole file discards usable evidence.
Clamping coordinates or treating poles/zero as invalid confuses parser validity
with the limitations of a drawing projection.

One reader owns namespace/path validation, strict XML, encoding/entity/nesting,
byte and point limits (`readGpx`, `packages/geo/src/track.ts:56-141`). Its strict
entry point preserves travel's existing result/rejection behavior
(`parseGpx`, `packages/geo/src/track.ts:144-147`). The recovery entry point keeps
valid isolated points, reports each omission and returns a clear no-line outcome
(`parseTrackGpx`, `packages/geo/src/track.ts:150-152`). Invalid points still count
toward the resource limit. Structurally duplicated optional fields remain errors
even in omitted points; recovery does not make unsafe XML acceptable.

Failing-first fixtures observed the old parser's error where partial and no-line
results were required. A restored split mutation joined two usable sections and
failed the actual longitude-array assertion. Separate restored mutations proved
strict rejection, invalid-point counting, byte/doctype guards, foreign namespace
exclusion and duplicate-field refusal on their intended assertions. Existing
travel runtime fixtures verify the actual CLI continues to normalize, measure,
trim and write the same strict geometry.

## Measurements and provenance — 2026-10-01

The [measurement A ruling](https://github.com/schlessera/brain-kit/issues/525#issuecomment-5931616277)
selects the existing travel baseline. Elapsed means file-clock intervals,
including pauses within a continuous section. Inferring moving time from a speed
or pause heuristic would introduce the unselected estimator and claim more than
the input proves. Connecting disconnected sections would include absent time
and invented distance. File-provided provenance remains distinct from a person's
separately supplied, unverified claim that a route was recorded.

Distance uses great-circle edges on the existing 6,371,008.8 m sphere. The
three-point median and 3 m hysteresis are one implementation for both elevation
directions (`elevationChanges`, `packages/geo/src/track.ts:219-234`). The same
complete-sample eligibility and loop/one-way/unknown baseline remain available to
strict travel. Alternatives in the earlier design (5 m/90-percent elevation
rules, a pause/speed estimator and inferred recording) were not selected.

The summary exposes units, usable-section scope, explicit unknown reasons and
copied source geometry (`summarizeTrack`, `packages/geo/src/track.ts:286-319`).
Display simplification cannot change its input or measurements. Valid isolated
points remain spatial evidence but do not fabricate a measured line. A no-line
summary reports unknown distance; repeated valid points may have a genuine zero
line length. Missing optional samples never become zero elevation or duration.

Restored mutations measured gap bridging as 111,306 m instead of 222 m and 7,260 s
instead of 720 s; the first respective behavioral assertions failed. Independent
mutations failed descent (0 instead of 20 m), real-zero unknown labels, no-line
distance and source mutation after changing the returned display geometry.

## Normalization and geographic proximity — 2026-10-01

Format adapters share coordinate validation and omission splitting through
`normalizeTrack`; adapters retain ownership of their source format and intake.
Numeric strings are not normalized coordinates. Optional metadata uses the same
unknown policy; the library does not infer recording or repair an omitted point.

Nearest points use minor great-circle arcs on the shared sphere, including arc
interiors. A vertex-only minimum overstates distance near a segment's middle;
planar longitude arithmetic takes the wrong path across the date line and fails
at poles. Antipodal endpoints do not specify a unique minor arc and therefore
yield an explicit unknown instead of selecting an arbitrary route.

Coverage is directional arc length of A within a reported tolerance of B, divided
by usable length of A. Arc-length midpoint sampling provides a bounded estimate;
the distance-to-B function is 1-Lipschitz along A, yielding conservative interval
bounds independently of the estimate. Reported spacing controls uncertainty;
sample/comparison limits bound work and produce unknown rather than a partial
percentage. Singletons are spatial evidence but do not invent a covered line.

Keyless references use exact equatorial lengths/distances and nested half-length
arcs. Self coverage is at least 0.99, disjoint arcs below 0.1, and reversing the
half-length comparison changes about 0.5 to 1. The analytic tolerance extension
lies inside the reported bounds. Date-line/polar fixtures and recovered/original
gaps exercise the actual methods without a map projection or live service.

Restored mutations failed the intended assertions for omitted-point/section limits,
normalization gap splitting, interior nearest distance (157,250 m rather than
111,195 m), proximity across gaps (zero rather than 445 m), directional denominator,
partial metadata, uncertainty bounds, sample/comparison limits, zero denominator
and antipodal ambiguity. The comparison-only mutation returned a percentage below
the sample cap where the independent comparison cap required unknown.
