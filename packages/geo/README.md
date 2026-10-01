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

## Routing

`geo.route(orderedPoints, "car" | "foot" | "bike")` needs 2–100 valid points.
Configure `routing.endpoints.<mode>` with the service URL **through `/route/v1`**,
its `profile` path token, `preparedMode`, dataset name and verification evidence.
OSRM selects its mode when preparing a dataset; changing the URL profile token
does not establish foot/bike capability. Mismatched configured capability refuses.

```ts
routing: {
  endpoints: {
    foot: {
      url: "https://routes.example.com/foot/route/v1",
      profile: "driving",
      preparedMode: "foot",
      dataset: "operator-prepared foot dataset",
      verification: "https://routes.example.com/datasets/foot",
    },
  },
  demo: { enabled: false, noncommercialLightUse: false },
}
```

Configured routing wins. With `demo.enabled` **and** `demo.noncommercialLightUse`,
the approved FOSSGIS preset can handle a missing configured endpoint or one genuine
failure: timeout/network, malformed/oversized reply, upstream 408/5xx or explicitly
disabled dataset. There are at most two attempts. Admission/denial/cooldown,
invalid input, no segment, no route and local cache/admission failure never escape
to another service. A public demo configured as primary requires the same eligibility
and verified mode mapping, and cannot retry itself as fallback.

The verified presets use `/routed-car/route/v1`, `/routed-foot/route/v1` and
`/routed-bike/route/v1` at `https://routing.openstreetmap.de`, all with the `driving`
URL token and distinct prepared datasets. Current operator source and its pinned
router implementation establish this mapping; [the decision](../../docs/decisions/geo-operations.md)
records the evidence. Respect [full FOSSGIS terms](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/)
and [routing information](https://routing.openstreetmap.de/about.html): noncommercial
light use under this preset, aggregate 1 request/s, one script connection,
identification, attribution and error-reporting links, reachable operator contact,
no mass/high-traffic use and no service/data-update guarantee. Eligibility flags
record informed responsibility, not permission. Replace the service with configured
endpoints when it is unsuitable.

A route retains all requested/snapped stops, leg distances/durations, unsimplified
GeoJSON geometry and explicit unknown reasons. It is calculated planning evidence,
not a recording. Missing estimates stay unknown; actual zero remains zero. Genuine
`NoRoute` caches distinctly; `NoSegment`, invalid query and disabled dataset retain
different errors/service codes and never become cached no-route. Source identifies
the served endpoint, declared prepared dataset/profile/evidence, fetch/cache age,
coordinate transfer and fallback/cause. `attempts` lists every endpoint and whether
coordinates were sent on that attempt, including a primary attempt before a cached
demo result. Changing dataset identity invalidates its cache context. No original
points are changed or replaced by snapped ones.

## POIs

`geo.poi({near: {lat,lon}, tags, radiusM})` or
`geo.poi({alongTrack: parsedTrack, tags, radiusM})` queries the ordered configured
`overpass.endpoints` when `overpass.enabled` is true. There is no implicit public
endpoint. All 1–10 tag filters must match: a string is an exact value and `true`
requires presence. Values are escaped; no user-supplied QL or regex runs. For
example, `{amenity: "cafe"}` finds cafés and `{amenity: "parking"}` finds car parks.

Radius is 1–5,000 m. Track queries retain at most 2,000 points / 100 nonempty
sections without simplification, with each section queried independently; retained
singletons remain spatial evidence. The radius-expanded extent must fit 5 degrees
on each axis without crossing a pole; wide/date-line-crossing track envelopes are
refused with a spatial-budget explanation, without invalidating the source.
UTF-8 QL is capped at 64 KiB, declares at most the configured timeout and 32 MiB
server memory, and requests only tags plus node coordinates/way or relation centers.
The shared transport bounds the actual timeout/body to the configured budget/5 MiB.

At most 1,000 results are returned. An extra sentinel indicates a partial capped
answer and that more matches may exist; larger replies fail distinctly. Invalid
elements and duplicate identities have exact omission counts; wholly malformed
nonempty replies fail. A genuine empty answer caches as `no_match`. Results keep
OSM identity, tags, nullable name, representative position, distance in metres and
raw nullable opening-hours text. **Current open/closed status is unknown.** A
way/relation's bounding-box center may lie outside the requested radius; selection
uses the object's geometry, while the reported distance uses its representative
point and the documented shared sphere. It is not an entrance or accuracy claim.

Recovered tracks remain partial with their exact counts/omissions. Distances and
queries cover retained geometry, preserving gaps. Source/fallback/cause, fetch age
and every attempt's geometry transfer remain visible on fresh and cached answers.
Duplicate endpoints are attempted once, with at most three configured attempts.
Only genuine timeout/network/bad-response/oversized replies and upstream 408/5xx
permit fallback. HTTP 401/403/429 and Overpass 504 are admission refusals; resource
or quota remarks in JSON also stop fallback and persist cooldown. No denial escapes
to another endpoint, including an endpoint with a previously cached answer.

Read the [Overpass commons/admission rules](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)
and [FOSSGIS full service terms](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/)
before choosing a public endpoint. Those services are shared resources, not a bulk
or high-traffic backend. FOSSGIS aliases (including `gall.openstreetmap.de` and
`lambert.openstreetmap.de`) share routing/Overpass admission and one script connection.
Identification, reachable operator contact, aggregate pacing/caching, attribution
and error-reporting links remain the caller's responsibility. Configure an appropriate
service for workloads the public operator cannot sustain.
