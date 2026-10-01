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

## Configured geocoding

Import `GeoClient` from `@schlessera/brain-geo/server`; the root export remains
free of server I/O. `geoConfigSchema` validates concrete configuration. All
services default to disabled/unconfigured, and the default User-Agent is empty:
the application supplies its identity. For example:

```ts
import { GeoClient } from "@schlessera/brain-geo/server";

const geo = new GeoClient({
  userAgent: "OdysseusGeo/1.0 (+https://example.com/contact)",
  geocoding: { enabled: true, url: "https://geo.example.com/nominatim" },
});
const candidates = await geo.geocode("Ithaca");
const address = await geo.reverse(38.36, 20.71);
```

`geocode` returns up to ten requested matches, retaining ambiguity. `reverse`
returns the nearest suitable mapped object, whose address can differ from the
query point. Candidate coordinate/address accuracy is unverified and numeric
accuracy remains explicitly unknown. Valid matches in a partly malformed reply
retain partial status and input/retained/omitted counts; a wholly malformed reply
is an error. An empty search or recognized reverse no-match is distinct from
timeouts, HTTP failures, admission denial and malformed data. Only valid replies,
including genuine no-match, enter the disk cache. Source metadata reports the
endpoint, fetch time/cache age and whether text/coordinates were sent on this call.

The [public Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/)
requires deliberate informed developer responsibility. Its endpoint also requires
`publicServiceEligible: true`; the flag records responsibility rather than granting
permission. No autocomplete, systematic/bulk lookup or generic LLM-platform
offering is provided. Configure an appropriate endpoint where the public service
is unsuitable. Results carry attribution; requests identify the application and never
follow redirects to an unconfigured service.

## Cache and request admission

`cacheDir` defaults to `~/.cache/brain-kit/geo`; `cacheTtlMs` defaults to one day
and is bounded to 30 days. Caches are disposable, private files rather than
authoritative content. Cache keys include endpoint, query/body, method, service
and application identity. Expired, future-dated or malformed entries cannot answer
as fresh evidence. Network replies are bounded to 5 MiB and `timeoutMs` (default
5 s, range 100 ms–60 s), including body consumption.

Admission is shared across cooperating processes at
`~/.cache/brain-kit/geo/admission`, independent of response-cache location. Server
callers can supply `admissionDir`; all callers for an operator must share it.
These limits do not police other applications/users or a distributed installation;
operators remain responsible for aggregate traffic beyond this local boundary.
The default configurable request floor is 1 s. Public Nominatim and FOSSGIS have
an enforced 1 s minimum regardless of a lower configured floor. FOSSGIS routing
and Overpass aliases share one group and one script connection. Starts are timed
from actual dispatch, and the lock spans body consumption. Admission waits default
to 5 s and are bounded to 100 ms–60 s. Denial/cooldown replies persist across
clients; fallback must not bypass them. Overpass 504 is resource admission, while
an OSRM 504 can represent a genuine upstream failure.

Locks fail closed after a crash or failed state persistence; there is no unsafe
lease expiry while a request might remain active. Recover an orphan only after
its owner has exited, with the request interval/cooldown respected. Retain the
admission state; never remove a live owner's lock or reset a denial to evade it.
