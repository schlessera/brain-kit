# Shared geo operations

`@schlessera/brain-geo` is the concrete geospatial library shared by the CLI,
SDK server and travel module. It depends on none of its consumers. Endpoints
configure concrete services; there is no provider registry.

## Track parsing

The root export contains geometry helpers without server I/O or a rasterizer.
`parseGpx` preserves travel's strict parser and result: invalid coordinates reject;
track segments take precedence over routes; short sections are omitted.
`parseTrackGpx` uses the same XML reader with explicit recovery. It reports exact
input/retained/omitted counts and per-point reasons, splits at each invalid
coordinate and retains valid isolated points as source evidence. `no_line` means
no section has at least two points. Original segment gaps are preserved. Valid
zero, polar and repeated coordinates remain valid. Neither API changes the input.

Both refuse malformed XML, doctypes/entities, unsupported encodings/namespaces,
more than 128 nesting levels, 20 MiB inputs and more than 200,000 source points.
Invalid points count toward that limit. Missing/invalid optional elevation and
time remain unknown. File timestamps do not prove a route was travelled.

Travel's existing `routeMetrics`, trimming, quantization and whitelist GPX writer
are shared here with their existing meanings. Distances sum great-circle edges
within continuous sections; gaps contribute nothing. Elevation requires complete
samples, a three-point median and 3 m hysteresis. Ordered complete timestamps
supply elapsed intervals including pauses, without inter-section gaps.

## Track summaries

`summarizeTrack(parseTrackGpx(source), { kind: "file", path })` reports copied
geometry, bounds/start/end, status/counts and unit-bearing measurements with
usable-section scope. Distance uses unsimplified great-circle edges on a
6,371,008.8 m sphere. Ascent and descent share the same complete-data smoothing;
elapsed includes pauses within sections and excludes gaps. Moving time stays
unavailable. Missing or decreasing required timestamps, incomplete elevations
and no-line inputs carry explicit unknown reasons; genuine zeros remain zero.
File timestamps do not establish a recording claim. Optional claims stay unverified.
The returned geometry can be changed for drawing without changing the parser input.

## Normalized input and proximity

Format adapters call `normalizeTrack(sections, "track" | "route")` with point
objects containing numeric `lat`/`lon` and optional `elevation_m`/`time`. It uses
the GPX coordinate and recovery policy. Every omission splits a section; original
sections stay separate. Non-array sections/non-object points reject. Numeric
strings are invalid coordinates; metadata remains unknown when invalid. The
200,000-point limit includes omissions; empty sections have a 200,000-section cap.
The source file size/format guards remain the intake adapter's responsibility.

`nearestTrackPoint(track, { lat, lon }, toleranceM)` finds the closest point on
minor great-circle arcs, including segment interiors and retained singletons.
It reports distance in metres, section/edge/fraction and the supplied tolerance.
It handles the date line and poles without planar projection. Section gaps are
never edges. Empty geometry and ambiguous antipodal edges report unknown. Query
coordinates and finite tolerances from zero to Earth's half-circumference validate.

`trackCoverage(A, B, { toleranceM, sampleSpacingM? })` reports the covered usable
length of **A relative to A's usable length**, not a symmetric similarity score.
It samples great-circle arc-length midpoints and reports the tolerance, spacing,
sample count, method and conservative minimum/maximum ratios. Distance to B is
1-Lipschitz, so an interval of length `s` is fully covered if midpoint distance
plus `s/2` is within tolerance, and uncovered if distance minus `s/2` exceeds it.
Other intervals contribute sampling uncertainty to the bounds. This is an
estimate; the bounds express its precision. The default maximum spacing is
`max(0.1, min(5, toleranceM / 4))` metres; explicit spacing is above zero and at
most 1,000 m. A maximum of 100,000 samples or 5,000,000 edge comparisons bounds
work. Exceeding it yields unknown, with no fabricated percentage. Zero usable
length in A, no usable line in B and antipodal ambiguity also yield reasons.
Partial inputs retain counts and partial status. Neither input's gaps are filled;
isolated points remain nearest-point evidence but contribute no covered line.
