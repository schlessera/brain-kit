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

## Service cache and admission — 2026-10-01

Concrete clients share one disk response cache and operator admission. Per-instance
promise chains would give each CLI/SDK process its own public-service allowance.
An atomic exclusive file spans request/body consumption; persisted start/cooldown
state outlives clients. Public floors are anchored after actual dispatch, avoiding
the interval lost to a pre-dispatch fsync. Configured response-cache directories
do not partition the default global admission group. FOSSGIS routing and Overpass
aliases share script connection admission; custom endpoints group by origin.

A crashed owner's lock fails closed. Automatic stale-file removal or lease expiry
could admit another request while the first owner remains alive or its network
operation continues. Recovery requires an exited owner and retained operator
state. This concrete file protocol keeps server imports usable under Node as well
as Bun; adding `bun:sqlite` transitively to the existing SDK server export would
break its packed Node import contract.

The [Nominatim public-service policy](https://operations.osmfoundation.org/policies/nominatim/)
requires identification, aggregate pacing/caching, endpoint replacement and informed
developer responsibility. Its restrictions exclude bulk/autocomplete/systematic
usage and generic LLM-platform offerings. The new client defaults off and requires
an explicit eligibility flag for that public endpoint; the flag is no permission
grant. Reverse candidates remain unverified nearby mapped-object evidence per
the [API documentation](https://nominatim.org/release-docs/latest/api/Reverse/).

The full [FOSSGIS terms](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/)
were verified in the [operator's website source](https://github.com/fossgis/fossgis-webseite/blob/master/content/arbeitsgruppen/osm-server/nutzungsbedingungen.md)
at blob `cc2ffcc98def5a82c7c058f3df1a0b2a2f64571b` on 2026-10-01; the rendered
site presented an access challenge. They cover routing and Overpass, require
attribution/error-reporting links and an identifiable reachable website/app
operator, an application User-Agent and origin where feasible, one connection for
scripts, and one routing request per second. Heavy/mass downloading and high-traffic
uses are prohibited; their general limited commercial allowance does not broaden
#525's narrower noncommercial/light-use demo ruling. Permission may be revoked,
terms/services changed without notice, and availability is not guaranteed. Data's
ODbL license and service permission are distinct. No raster tiles are used; their
additional tile-only conditions do not become a tile feature here.

Recorded-response fixtures distinguish empty matches from malformed/partial replies,
HTTP/admission errors, network/timeout and bounded body failures. Valid matches
retain attribution, fetch/cache age and actual text/coordinate-transfer metadata.
A separate-process fixture uses distinct response-cache directories and one shared
admission directory, with requests lasting beyond the start interval. Restored
mutations fail actual start spacing, the independent no-overlapping-connections
assertion, persisted cooldown, Overpass resource admission, transient-cache request
count, identifying/eligible requests, recognized no-match, coordinate validation,
partial status, response-byte/body-time budgets and visible transfer metadata.


## Prepared routing and bounded fallback — 2026-10-01

The [routing ruling](https://github.com/schlessera/brain-kit/issues/525#issuecomment-5928012558)
selects configured OSRM-compatible endpoints before an explicitly enabled,
noncommercial/light-use FOSSGIS fallback. Endpoint metadata records its prepared
mode and verification evidence; a profile path token cannot establish capability.
The [OSRM API](https://project-osrm.org/docs/v26.4.0/http) makes dataset preparation
the mode boundary. The [operator's frontend](https://github.com/fossgis-routing-server/osrm-frontend/blob/master/src/leaflet_options.js)
(blob `ef945e9eefe12eb8ed5d555a3138892e997d431f`, inspected 2026-10-01) supplies
separate routed-car/bike/foot service paths. Its
[pinned router implementation](https://github.com/sosm/leaflet-routing-machine/blob/fa91a9160cb5b1bc8ed00beb40f253bc68204d24/src/osrm-v1.js)
uses the `driving` URL token for all three. Recorded responses prove the client's
actual requested paths and result source; no live public geo query is claimed.

One availability failure can use one eligible matching fallback
(`calculateRoute`, `packages/geo/src/server/routing.ts:66-110`).
Admission/denial, invalid input, no-route/no-segment and local storage errors cannot
escape to another endpoint. A public demo configured as primary needs the same
eligibility/mode mapping and cannot retry itself as fallback. Every attempted
coordinate transfer remains visible, including primary traffic before a cached
demo result. Dataset identity participates in cache context so a configuration
change cannot relabel an earlier fetch.

The decoder preserves full requested/snapped stop and leg evidence, nullable
provider estimates, true zero and calculated provenance
(`decodeRoute`, `packages/geo/src/server/routing.ts:35-60`).
Geometry, waypoint and leg structure must fit the request. Service errors retain
OSRM codes and never become cached no-route. Genuine no-route retains the complete
request for text/legend evidence. Requested points are snapshotted before awaits;
caller mutations cannot alter fallback transfer.

Restored mutations failed actual configured source, an extra public request with
demo disabled, prepared-mode/public-profile eligibility, the bike endpoint path,
extra traffic after denial, cached dataset identity, hidden fallback/cause, zero
estimates, self-retry, a third attempt and changed fallback coordinates. The
zero-demo receipt removes both layered enablement checks and fails on request count;
a prior single-check mutation changed the error but did not send a public request
and is not offered as that proof.


## Bounded POIs and Overpass refusal semantics — 2026-10-01

A near-point query or a query along retained track sections uses the concrete
Overpass client, with exact AND tag filters. Separate around clauses preserve
section/omission gaps; simplifying a track for its query would change which POIs
it can find, so oversized input refuses rather than becoming silently incomplete
(`findPois`, `packages/geo/src/server/poi.ts:72-119`).
The 5-degree extent budget includes radius, separate from valid track-coordinate
ranges; pole/date-line or wide-envelope refusal does not corrupt source geometry.
Query points, sections, UTF-8 bytes, radius, server time/memory and response size
are bounded and documented.

The [operator's around documentation](https://dev.overpass-api.de/overpass-doc/en/full_data/polygon.html)
provides point/polyline selection. The [data-format documentation](https://dev.overpass-api.de/overpass-doc/en/targets/formats.html)
distinguishes node coordinates from the representative centers returned for ways
and relations. A representative center can lie outside the selected radius;
reporting its distance as an entrance/full-object distance would overstate the
answer. Results retain that distinction, OSM identity and raw mapped tags. Missing
opening hours remains unknown; a schedule string does not prove current opening.
Malformed elements/duplicates have omission counts; a bounded extra sentinel
signals partial output and possible further matches
(`decodePois`, `packages/geo/src/server/poi.ts:39-69`).

The ordered endpoint chain attempts at most three unique configured endpoints
(`queryOverpass`, `packages/geo/src/server/overpass.ts:29-55`).
The [Overpass admission documentation](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)
assigns HTTP 429 to rate refusal and HTTP 504 to resource admission. Those are
not availability failures authorizing a different quota bucket. Neither denial
nor local admission/cache failure reaches another endpoint, even when it has a
cached answer. Genuine network/timeout/bad-response/upstream failures can fall
through. JSON query-timeout remarks remain errors rather than cached empty matches;
resource/quota remarks stop fallback and persist cooldown. Official individual
server aliases also share the FOSSGIS script connection/pacing group.

Recorded-response mutations fail the intended assertions for gap-separated clauses,
unknown opening hours, escaped values, radius-expanded extent/point/section/query
budgets, refusal even with a cached alternate, persisted JSON-resource cooldown,
partial track metadata, bounded result count and sentinel overflow, duplicate
endpoint attempts and the no-overlapping-connections assertion across operator
aliases. Every mutation was restored; none relies on live public queries.


## Shared SDK geometry ownership — 2026-10-01

The pure coastline pipeline now belongs to geo; SDK names remain compatibility
exports. The clip/simplify/stitch/witnessed-land implementation moved byte-identical
and its existing regression tests run through those aliases. No place-map fixture,
projection, tier threshold, land fill or UI baseline was changed
(`prepareLand`, `packages/geo/src/coastline.ts:801-851`).

A new concrete coastline operation applies the same shared Overpass cache/admission
before invoking that geometry. Each layer preserves its complete endpoint/cache/
fallback/transfer/error evidence, so a map assembled from different replies cannot
pretend one source describes all of them
(`coastlineGeometry`, `packages/geo/src/server/coastline.ts:41-84`).
Usable earlier geometry survives a genuine failed later layer and remains partial.
Admission/configuration/storage failure stops later queries; the transport remains
an independent refusal guard. Bounds retain the existing 5-degree background budget.
The 10,000-way/200,000-vertex cap counts malformed structures before parsing, as
well as the shared actual byte/time limits. No transient failure becomes a cached
complete background. Raw ways, not simplified drawing lines, produce land.

The legacy result-or-empty adapter keeps existing return keys, off behavior and
endpoint/User-Agent/timeout/fetch injection. Additive canonical configuration/cache
and shared admission-path options allow CLI/server callers to cooperate
(`fetchCoastline`, `packages/geo/src/server/coastline.ts:87-96`).
The SDK depends on geo one way; the browser-facing SDK root/client has no import of
this server adapter. Existing route-level permanent geometry caching stays intact.
The new response cache is disposable and does not become authoritative content.

Restored mutations failed on later-layer query membership, failed/malformed-layer
partial status, the background extent rejection, way/vertex caps (including a
malformed structure whose guard was moved after parsing), correct served fetch age
and the legacy disabled wrapper's actual request boolean. Recorded responses also
assert nonempty geometry and every layer's cache transfer. No live service was used.

## Reverse-geocoding compatibility — 2026-10-01

The SDK wrapper delegates to the concrete shared client and returns the same
three address fields or null (`reverseGeocode`,
`packages/ui-sdk/src/server/reverse-geocode.ts:34-61`). Configured endpoints retain
their role; canonical configuration takes precedence and legacy `enabled:false`
still prevents any request. The former comment assumed occasional single-user
location use qualified for public Nominatim. Frequency alone cannot establish
eligibility under the policy above. Explicit informed eligibility is now required,
and its absence uses the existing nullable failure path: the actual location bridge
still returns raw coordinates. No tool/result/wire revision is needed.

The first-party backend environment flag defaults false, recognizes only deliberate
truthy tokens and remains server-only in child-process filtering. Successful
evidence shares endpoint/exact-coordinate cache entries with GeoClient; failures
are not cached as empty locations. A copied address avoids caller mutations leaking
into later results. Recorded requests and the real location bridge exercise these
paths without public queries. Eight restored mutations failed the intended
assertions for the disabled guard, shared-cache source, nonempty address, both
backend eligibility defaults/forwarding and actual subprocess filtering.

## Canonical consumer adapters — 2026-10-01

Core accepts the concrete geo shape under an optional root block, retaining
`{}` as an empty config and all new services off. Its authoring type is schema
input, so new nested defaults do not force fully populated objects on callers.
Loaded output remains assignable to that input. Core's configured response-cache
path uses the same repo-relative schema as every configured filesystem path,
then resolves through existing symlink containment; global admission is not
partitioned by a per-brain cache (`resolveGeoConfig`,
`packages/core/src/lib/geo-config.ts:6-15`).

The SDK server re-exports the same configuration schema/types. UI servers accept
optional explicit `coastline.geo` or canonical JSON at startup. This passes
through the mounted geometry route to the shared adapter, with legacy Overpass
service settings retained when canonical input is absent. Invalid configuration
refuses startup, avoiding an accidental public fallback. The legacy privacy
switch, permanent geometry cache and 5-degree place-map guard remain intact.
Canonical response caching remains a separate disposable layer.

A native local HTTP fixture verifies a nonempty mounted route, actual canonical
endpoint/User-Agent, cached evidence after deleting only the route cache, and
no new request after disabling. Core loads a real config into GeoClient without
creating a database or modifying the file. Six restored mutations failed the
intended lexical/symlink/path assertions, startup refusal, actual endpoint path
and subprocess filtering. No public service query is claimed.
