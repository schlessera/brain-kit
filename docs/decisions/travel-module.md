# Travel ownership and canonical visit history

## Decision — 2026-09-30

Travel is a content module alongside speaking, not a speaking feature. The
[ownership ruling](https://github.com/schlessera/brain-kit/issues/60#issuecomment-5869107262)
and [travel scope ruling](https://github.com/schlessera/brain-kit/issues/524#issuecomment-5869656145)
require overnight journeys, repeated day trips and visited places without
changing existing travel paths, type values, links or party settings.
The later [example-world ruling](https://github.com/schlessera/brain-kit/issues/566#issuecomment-5909879203)
uses Odysseus for new fixtures and documentation.

`travel` retains the existing journey meaning. `trip` is one canonical file
per repeatable route or place, with proposed/done/dismissed state and an
embedded visit history. `place` is a canonical country, city, town or spot.
A visit's identity is its owner's root-relative document path plus a stable
visit ID. Route labels identify variants inside one trip; one primary route
makes selection explicit. The parser checks those invariants
(`parseTravelDocument`, `packages/module-travel/src/content.ts:78-97`).

Place summaries union references from the place and from canonical
journey/trip visits, deduplicating the document/visit pair. They never read
stored counts or dates as authority
(`summarizePlaceVisits`, `packages/module-travel/src/content.ts:178-201`).
Unknown dates and coordinates stay unknown. An undated visit still counts;
first/last bounds remain unknown if any included date is unknown. Valid
zero coordinates remain zero. Domain parsing uses YAML JSON scalars through the
cache-free frontmatter helper so timestamp coercion cannot turn a written
nonexistent date into another day. A failing fixture showed unquoted
`2026-02-30` becoming `2026-03-02` under the default timestamp parser. Relative assets must resolve within the brain,
and place ancestry and visit references must resolve in canonical files
(`readTravelCorpus`, `packages/module-travel/src/content.ts:105-167`).
Markdown remains authoritative; no travel database or geocoding is introduced.

## Migration boundary

Speaking retains talks and conferences. Both modules contribute the same
legacy directory anchors, so enabling travel alone preserves directory links
through `status.md`, `itinerary.md` and `outline.md`. Speaking's deck exclusions
stay in speaking. The journey planning skill moves with travel; conference
outcome and aftermath skills link to that owner rather than owning travel.

Migration is an explicit CLI source-edit job, not startup behavior. Speaking
accepts and warns about its deprecated nonempty party field until the user
moves it. `brain travel migrate` supports canonical package-keyed JSON blocks
and directly exported TypeScript literals. It copies the complete literal
value, removes only the legacy property and preserves unrelated source text.
Equal target values collapse safely; conflicts, duplicate keys, dynamic
values and ambiguous targets refuse without writing
(`planTravelConfigMigration`, `packages/module-travel/src/migration.ts:97-146`).
The TypeScript compiler is loaded only for this job: its AST identifies syntax
without executing or serializing configuration logic. Symlinked config files
are refused and successful writes use the existing atomic writer.

[Module settings #528](https://github.com/schlessera/brain-kit/issues/528)
owns future per-module JSON precedence and the shared CLI/API writer. This
migration uses today's canonical config and refuses when either travel or
speaking already has a saved settings file; it never guesses that future
precedence. Normal commands continue using validated context configuration.
The approved pre-1.0 ownership break and upgrade instructions are recorded in
the [integration contract](../integration-contract.md#travel-ownership-and-canonical-content).

## Alternatives and evidence

Keeping travel in speaking would prevent a travel-only brain and duplicate
type ownership when both modules load. A real loader/taxonomy test failed at
the duplicate-type assertion with that old behavior; travel alone and both
modules now pass actual CLI module listing and linting. Real indexing and
validation also check all three legacy directory anchors.

One file per occurrence, or deduplicating by title/date, would fragment a
repeatable route and collapse distinct visits on identical or unknown dates.
The canonical fixture deliberately links one event more than once and stores
an incorrect display count; its summary still has one visit. A separate
fixture has two different known dates, then adds an undated visit, proving
both chronological bounds and the retained uncertainty.

Automatically rewriting config on load, reserializing evaluated TypeScript,
or choosing one conflicting party would risk unrelated settings or data.
Loadable old-behavior migration stubs failed assertions about nonempty party
preservation, conflicts and changed source. Real CLI tests apply JSON and TS
migrations, reload in a fresh process, verify content bytes and repeat the job
without another edit. Domain formats are checked by `brain travel validate`;
core validation keeps its existing common metadata and wiki-link contract,
without adding a validator extension seam.

## Photo processing — 2026-10-01

The [approved travel scope](https://github.com/schlessera/brain-kit/issues/524#issuecomment-5869656145)
requires reduced photo copies, original capture provenance and removal of input
metadata. `brain travel photo` performs that deterministic job; a later travel
workflow can decide which visit receives the reported values. It stores no
originals, albums or sidecar authority and performs no network requests.

Sharp supplies real codec decoding, EXIF pixel orientation, bounded resizing
and mozjpeg encoding. Its default fresh output strips metadata; adding metadata
back is deliberately absent from the pipeline
(`preparePhotos`, `packages/module-travel/src/photo.ts:110-146`).
The native dependency loads only in the photo command. Bun 1.3.14 on Linux
loaded Sharp 0.35.5 with bundled libvips 8.18.7 and mozjpeg, and encoded actual
JPEG bytes. Other supported binaries follow Sharp's [installation requirements](https://sharp.pixelplumbing.com/install/);
the command reports unavailable formats instead of promising HEIC everywhere.

exifr reads the original EXIF block exposed by the decoder, independently of
the source container. Camera time is read as written text: constructing it
through the process timezone would invent an instant when the camera supplied
none. Calendar validation rejects nonexistent dates, written offsets/fractions
are retained, and valid zero coordinates survive
(`captureTime`, `packages/module-travel/src/photo.ts:82-95`;
`capture`, `packages/module-travel/src/photo.ts:97-108`).

Completed sibling bytes are published with an exclusive hard link. A rename
can replace a destination that arrived after an existence check; the exclusive
operation retains that entry and tries the next numeric suffix. Directory
identity is checked before publication, symlink destinations are refused, and
partial writes are removed before any JPEG name appears
(`writePhotoCopy`, `packages/module-travel/src/photo.ts:19-54`).
This requires hard-link support. Cleanup after successful publication is
best effort, so a cleanup error cannot turn an existing completed copy into
a reported failure.

Real CLI fixtures contain nonempty EXIF/GPS, XMP, ICC, IPTC and JPEG comments.
An independent reader and marker scan check their removal; decoded corner
pixels check rotation separately from the reported dimensions. A filesystem
test injects an arriving destination and verifies its bytes remain unchanged.
Invalid, truncated and animated inputs, repeated jobs, source/output collisions,
and root/symlink escapes exercise the actual command and writer.

## Route geometry and privacy — 2026-10-01

The approved route work in [#568](https://github.com/schlessera/brain-kit/issues/568)
is a deterministic travel CLI job. Local/direct GPX and public Komoot tour
and smarttour pages provide geometry; no route planning or geocoding is
introduced. Travel depends on the existing scrape package for this concrete
HTTP job, sharing its robots/pacing policy rather than adding an adapter or
browser-driver seam. URL/DNS checks run before every route hop and bounded
robots redirect; unavailable robots retains the shared permissive policy
(`RouteRobots`, `packages/module-travel/src/route.ts:68-83`).

**2026-10-01 — Shared ownership.** The #525 ownership ruling moves the
concrete GPX reader, metrics and trimming to `@schlessera/brain-geo`. Travel
uses its strict compatibility entry point; the new recovered-track policy
does not alter travel's rejection, serialization or measurement contracts.

GPX parsing is strict XML with explicit same-namespace geometry paths.
Saxes checks well-formedness; doctypes are refused, and foreign extensions,
metadata and waypoints cannot supply track points. Track segments take
precedence over routes. Invalid coordinates reject; missing optional data
stays unknown (`parseGpx`, `packages/geo/src/track.ts:144-147`).
This uses a verified parser dependency rather than a partial XML regular
expression reader. Komoot's observed boot payload is decoded as JSON, never
executed as JavaScript.

Trimming measures great-circle edges independently within each continuous
segment and interpolates cut boundaries. Segment gaps are never joined
(`trimRoute`, `packages/geo/src/track.ts:185-210`).
The writer rebuilds a whitelist GPX from retained points and new bounds;
source metadata and ancillary geometry are never copied
(`writeGpx`, `packages/geo/src/track.ts:255-262`).
Metrics use the exact quantized points written to that file. Unknown
elevations/timestamps remain null; smoothed ascent resets at segment gaps,
and duration requires ordered absolute timestamps
(`routeMetrics`, `packages/geo/src/track.ts:236-252`).
The package README specifies units, smoothing, shape and serialization
tolerances. Original inputs and occupied output names remain untouched
(`importRoute`, `packages/module-travel/src/route.ts:121-176`).

Outdooractive has a readable public route page, but GPX export requires
login and its geometry API is covered by its `/api/*` robots disallow.
The [scraping-politeness decision](scraping-politeness.md) requires written
site permission before fetching a disallowed path; observing normal browser
subrequests does not authorize importing through them. Its source criterion
therefore remains open in #568 with the exact human permission prerequisite.
The independently usable GPX/Komoot slice does not complete that criterion.

## Descriptive output names — 2026-10-04

The maintainer's [Date A ruling](https://github.com/schlessera/brain-kit/issues/906#issuecomment-5973876272)
and [Slug B ruling](https://github.com/schlessera/brain-kit/issues/906#issuecomment-5973974551)
make naming explicit CLI work. Photo and route accept a complete descriptor
and optional calendar date; photo can explicitly force the visit date over the
camera date. They still create assets, never attach them to a visit or write
content records.

`date_source` is provenance of the date actually applied to a requested name,
not the provenance of every available date. With no descriptor, names remain
source-derived and the field is `none`, even with valid EXIF or date flags.
Photo `captured_at` remains original capture metadata when a forced flag wins.
The selected camera day is taken from validated text rather than converted
through UTC or a host timezone
(`preparePhotos`, `packages/module-travel/src/photo.ts:110-146`).

Date B, reporting an available/selected date on every call, would imply a
naming date even when the legacy filename has none. Replacing capture metadata
with a forced visit date would erase a distinct fact. Both lose under Date A.
Route never derives a naming date from track timestamps or reports `exif`.

Slug B normalizes the complete descriptor to NFKD, removes combining marks,
lowercases, replaces non-ASCII filename runs with hyphens and trims edge
hyphens. It preserves underscores, folds accents, refuses an empty result and
never strips an apparent extension or invents a fallback
(`validateOutputNaming`, `packages/module-travel/src/output-naming.ts:10-23`).
Legacy source-name normalization is a separate branch. Keeping Unicode
descriptors or transliterating all scripts would be different policies;
`Straße` deliberately becomes `stra-e`, while Greek-only text is refused.
Built-in normalization is sufficient; no dependency or extension seam is added.

Real CLI fixtures use a nonempty camera timestamp near midnight with a written
`+14:00` offset under Honolulu and Kiritimati process timezones, a conflicting
visit flag, forced/no-name/undated controls and positive output bytes. They
check composed/decomposed accents and complete dotted descriptors in photo
and local-route commands, plus recorded Komoot tour/smarttour replay. Invalid
dates/empty descriptors fail before output creation or remote dispatch.
Existing asset and original source bytes survive repeated/batch jobs.

The legacy-result test first failed with `date_source` absent. Mutations then
reported EXIF for an unnamed photo, a flag for an unnamed route, preferred an
unforced flag over EXIF, and skipped numeric suffixes. Each failed on its
intended field/filename assertion rather than a load error. The original
implementation was restored before the verification suite. These receipts
protect selected naming/provenance semantics; existing atomic publication and
containment guards remain the writers' responsibility.
