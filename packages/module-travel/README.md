# @schlessera/brain-module-travel

Journeys, repeated day trips and visited places for brain-kit. Requires Bun
≥ 1.3.5. This package joins the next lockstep release.

Enable it under `modules` in `brain.config.ts` or `brain.config.json`:

```ts
modules: {
  "@schlessera/brain-module-travel": {
    travelParty: [
      { name: "Odysseus" },
      { name: "Penelope", role: "partner", requirementsDoc: "people/penelope.md" },
    ],
  },
}
```

`travelParty` defaults to `[]`. A member has `name: string`, optional
`role: string` and optional `requirementsDoc: string`. Requirements documents
are relative to the brain root. The strict schema preserves the existing
speaking configuration's values and rejects unknown configuration keys.
User taxonomy overrides can retain existing custom directories.

## Ownership

| Type | Default directory | Canonical record |
| --- | --- | --- |
| `travel` | `travel/` | An overnight journey; existing itineraries keep their paths and fields. |
| `trip` | `trips/` | One document per repeatable route or place, containing its visit history. |
| `place` | `places/` | One country, city, town or notable spot, linked to canonical visits. |

Travel retains the legacy `status.md`, `itinerary.md` and `outline.md`
directory anchors and planning skill `plan-travel`. Speaking retains talks,
conferences and the same shared directory anchors. Travel alone introduces no slide-deck exclusions. Both modules can
be enabled together.

## Canonical formats

All three use the ordinary core frontmatter (`title`, `type`, dates, tags,
status and relevance); `brain validate` checks that common metadata and wiki
links. `brain travel validate` checks the domain formats and their references.
Custom frontmatter is preserved. These readers never rewrite content.

An existing `travel` document needs no new fields. It may add `places` and
`visits` using the same references and visit records as a trip.

```yaml
type: trip
title: Ithaca headland
trip_status: done
places: [places/ithaca.md]
routes:
  - label: north-path
    source: own plan
    kind: planned
    gpx: routes/north.gpx
    primary: true
visits:
  - id: homecoming
    date: null
    party: [Odysseus, Penelope]
    route: north-path
    track: recordings/homecoming.gpx
    actual: {distance_km: null, ascent_m: null, duration_s: null}
    verdict: A route to revisit
    photos: [photos/headland.jpg]
cover: photos/headland.jpg
```

The example's referenced assets must exist beside that trip document in the
named subdirectories. Asset/track paths are relative to their document;
`../` can reach a shared asset within the brain. Resolution follows symlinks
and refuses escapes from the root.

- `trip_status` is `proposed`, `done` or `dismissed`. `done` requires at least
  one visit; its date may remain unknown. Changing state never deletes visits.
  The core `status` remains the independent active/archived/draft lifecycle.
- `visits[].id` is a stable lowercase slug, unique within the document.
  Repeated visits, including two on an unknown or identical date, have
  separate IDs. Never derive identity from the date or party.
- A visit's `date` is a real `YYYY-MM-DD`, `null`, or omitted. Its `party`,
  `route`, `actual` and other descriptive fields may be omitted when unknown.
  `actual` holds optional nonnegative `distance_km`, `ascent_m`, `duration_s`;
  each can remain `null`. It describes the recording associated with `track`.
- Route labels are unique within the trip. Visits reference those exact
  labels. A nonempty `routes` list has exactly one `primary: true`.
  `kind` is `planned`, `recorded` or `reference`; `source` is free descriptive
  provenance. Optional `url` is HTTP(S), `gpx` is a relative asset, and
  `distance_km`/`ascent_m` are optional nonnegative derived metrics or `null`.
- `places` on a journey/trip applies to its visits; a visit can also name
  individual places. References use complete root-relative `.md` paths.

```yaml
type: place
title: Ithaca
place_kind: spot
coordinates: null
visits:
  - document: trips/ithaca-headland.md
    visit: homecoming
```

`place_kind` is `country`, `city`, `town` or `spot`. Optional `parent_place`
uses a root-relative place document path. Countries are roots; cities/towns
may belong to a country, and spots to a country or city/town. Missing parents
and cycles are errors. A standalone place can omit its parent.

Coordinates are omitted, `null`, or `{lat, lon}` in latitude −90…90 and
longitude −180…180. `(0, 0)` is valid. Unknown coordinates stay unknown.
No geocoding or network request occurs.

The document path identifies a place. A visit reference is the pair of its
owning journey/trip's path and visit ID. Record an event once in its owning
document and reference it elsewhere. `summarizePlaceVisits` unions explicit
place references with journey/trip place links and deduplicates that pair;
titles, route labels and dates are not deduplication keys.

`visit_count`, `first_visit`, `last_visit` are derived display fields. Their
stored values are ignored when computing a summary. Counts come from
canonical events. First/last are `null` when any included visit's date is
unknown, or when there are no visits; the individual known dates remain
available. Later registry generation consumes these records.

## Photo copies

```sh
brain travel photo originals/ithaca.jpg originals/scheria.png --to trips/ithaca/photos --json
```

Source paths resolve from the brain root; an explicit absolute path may read a
camera file elsewhere. Originals are read only and never stored by this command.
The output directory must remain inside the brain root. Symlinked output
directories and filenames are refused, including links whose targets are inside
the root.

Each supported raster becomes a JPEG with a maximum 1600-pixel long edge,
preserved aspect ratio and no upscaling. EXIF orientation is applied to actual
pixels. Transparent areas become white. The encoder converts to sRGB and uses
mozjpeg at quality 80. The fresh copy contains no input EXIF, GPS, XMP, ICC, IPTC
or comments; ordinary JPEG structural headers remain. Animated and multi-page
images, vector documents and unsupported codecs are refused. Available codecs
depend on the installed Sharp/libvips build; HEIC support is not guaranteed.

Copies use the source basename with `.jpg` unless `--name` is supplied. An occupied name receives `-2`,
`-3` and so on, including when the source already sits in the output directory.
A completed temporary sibling is published with an exclusive hard link, so an
arriving destination cannot be overwritten and readers never see partial bytes.
The output filesystem must support hard links; errors are reported rather than
falling back to an overwrite-prone writer. New files have mode `0600` where the
filesystem supports it. Temporary siblings are normally removed; if cleanup
fails after publication, the completed copy is still reported as successful and
a hidden sibling may remain.

`--json` returns `{photo: {files, errors}}`. Each success contains:

| Field | Meaning |
| --- | --- |
| `source` | Input argument, unchanged. |
| `output` | Brain-root-relative JPEG path, using forward slashes. |
| `width`, `height`, `bytes` | Actual encoded dimensions and byte length. |
| `captured_at` | Original EXIF camera time as ISO text, or `null`. |
| `date_source` | Date applied to a requested filename: `exif`, `flag` or `none`; always `none` without `--name`. |
| `location` | Original EXIF `{lat, lon}` in decimal degrees, or `null`. |

Capture time retains a written fractional second and UTC offset. Without an
offset it stays a local time such as `2026-07-15T12:34:56`; the process timezone
never supplies one. Missing or impossible dates remain `null`. Coordinates
require a finite latitude/longitude pair within their normal ranges; zero is
valid. These values are returned separately, never embedded in the copy or
written to a sidecar.

For dated descriptive names, use:

```sh
brain travel photo camera/IMG_4711.jpg --to trips/scheria/photos --name "Ferry to Scheria" --date 2026-09-27 --json
```

The stem is `<date>-<slug(descriptor)>`. A valid EXIF camera calendar date
wins over `--date`; without usable EXIF, the flag supplies the date, otherwise
the prefix is `undated` and `date_source` is `none`. Add `--force-date` to make
the flag win over EXIF; it requires a valid `--date`, including without a name.
The original `captured_at` is still reported independently. Camera dates are
never shifted through the host timezone. Multiple inputs with one descriptor
use the same non-overwriting numeric suffixes.

Descriptors use the complete text: NFKD normalization, combining-mark removal,
lowercase, runs outside ASCII letters/digits/underscore/hyphen replaced with
`-`, then edge hyphens trimmed. `Café in Ithaca` and its decomposed accent both
become `cafe-in-ithaca`, `Straße` becomes `stra-e`, and `Plan.v2` becomes
`plan-v2`. This is accent folding, not full transliteration. Empty results
(for example, Greek-only or punctuation-only descriptors) and nonexistent
calendar dates are refused before any output directory/file is created.
Dates must be `YYYY-MM-DD`, years 0001–9999. Valid date flags without `--name`
keep legacy filenames and report `date_source: "none"`.

Errors contain `{source, message}`, with the original input argument and a prose
diagnostic. Inputs are processed in argument order; a failed input does not
prevent other copies. Exit `0` means all succeeded, `2` means one or more input
jobs failed, and `1` means invalid arguments or an unusable output directory
before processing (stderr diagnostic, no success envelope). `--human` shows
paths and dimensions, with errors on stderr. Put flags before `--` when passing
a filename that begins with a dash.

Sharp and exifr load only when processing photos. Sharp ships native codec
binaries for its supported platforms; see its [installation requirements](https://sharp.pixelplumbing.com/install/)
and [mozjpeg options](https://sharp.pixelplumbing.com/api-output/#jpeg).

## Upgrade from speaking

This release moves travel taxonomy, planning and configuration out of
speaking. Before indexing an upgraded speaking-only brain, install the matching
travel package and add `"@schlessera/brain-module-travel": {}` to `modules`.
Keep speaking enabled if you use its workflows. Then choose the upgrade path
below based on the files already present.

### Source-only upgrade

When neither `settings/speaking.json` nor `settings/travel.json` exists, run
`brain travel migrate --dry-run --json` to check the reported config path and
whether an edit is needed. Dry run reports that result, not a full source diff.
Review the legacy and target party values, then run `brain travel migrate
--json`. Review and commit the changed config.

Migration moves the complete legacy `travelParty` value, including roles and
requirements-document paths. It leaves the speaking entry and all content
bytes untouched. Rerunning is a no-op. Equal values in both module blocks
remove only the legacy field; conflicting values change nothing and require
review. Speaking accepts the deprecated field during this transition and
warns when a nonempty value is still present.

The deterministic writer supports JSON and directly exported TypeScript
object literals, including `defineConfig({...})`. It edits only the owned
field and target module entry. Duplicate keys, computed/spread/shorthand
targets and dynamic party expressions are refused with manual migration
instructions. Preserve the complete value when migrating those configurations
by hand. Symlinked configs are refused; replacement is atomic and retains
the file's permissions.

### Settings precedence and reviewed manual upgrade

[Module settings #528](https://github.com/schlessera/brain-kit/issues/528) has
delivered per-module JSON settings and the shared validated CLI/API writer.
For each module, the loader merges `settings/<name>.json` over its domain block
in `brain.config.ts` or `brain.config.json`, then validates with the module's
schema and applies defaults. Objects merge per key; arrays and scalars replace.
Thus a saved `travelParty` replaces the entire configured array, including when
the saved array is empty. An absent party defaults to `[]`. Module enablement
stays in the brain-config entry, outside these domain settings. See the
[shared settings guide](../../docs/modules.md#editable-module-settings).

`brain travel migrate` remains a **source-only** command. It refuses if either
speaking or travel already has a settings file, even an empty one, and never
overwrites those files. Travel declares no shared settings migration planner:
`brain module settings travel --migrate` is not an upgrade path. Use the
following reviewed manual path for existing settings files or source layouts
the source-only command refuses:

1. Preserve the original config and both settings files in version control or
   a backup. Review every `travelParty` present in the speaking/travel config
   blocks and settings files, including values hidden by saved overrides.
   `brain module settings speaking --json` and `brain module settings travel
   --json` show `values`, `inherited`, `overrides`, provenance and revision.
   Compare every member, `role` and `requirementsDoc` string. Resolve differing
   complete values explicitly; do not blindly concatenate arrays or discard
   hidden members. Keep the originals while that review is unresolved.
2. Put the reviewed **complete array** in the travel config block or save it
   as a travel JSON override. If choosing the config block, remove only any
   saved travel `travelParty` override that would mask it. Preserve all other
   config logic, keys and settings. To use the shared writer, prepare
   `/tmp/travel-settings.reviewed.json` from travel's current `overrides`,
   replacing only `travelParty` with the complete reviewed array. `--stdin`
   supplies the whole overrides object, so retain every unrelated saved key;
   do not copy schema defaults or the whole settings response into that file.
   Preview, then save using the revision from the reviewed travel snapshot:

   ```sh
   brain module settings travel --stdin --preview --json < /tmp/travel-settings.reviewed.json
   brain module settings travel --stdin --revision '<reviewed revision>' --json < /tmp/travel-settings.reviewed.json
   ```

   Preview validates without writing. A save validates with the original
   module schema and commits changed settings in the initialized brain Git
   repository; it does not edit the config or remove speaking's legacy field.
   A stale revision requires a fresh snapshot and review before saving again.
3. In a fresh process, confirm `brain module settings travel --json` reports
   the complete intended party and requirements-document strings. Only then
   remove the deprecated `travelParty` property from the speaking config block
   and `settings/speaking.json`, wherever present. Remove just that property,
   preserving unrelated source, settings and content; do not replace a whole
   file or set the party to `null`. Review and commit any manual file edits.

### Reload and validate

After either path, start a fresh process/session. Recheck the effective travel
party with `brain module settings travel --json`, then run `brain module lint
travel`, `brain validate`, `brain travel validate` and `brain skills sync`.
Review the diff to confirm every intended member, role and requirements-document
path survived, unrelated config/settings stayed intact and no journey, trip or
place document was rewritten. These commands validate/reload the configuration;
they do not supply a missing automatic settings migration.

## CLI and library

- `brain travel route <url|file> --to <dir> [--trim-start-m N]
  [--trim-end-m N] [--name <label>] [--date YYYY-MM-DD] [--json]`: imports GPX or public Komoot geometry and
  writes a new normalized GPX. See [route import](#route-import) below.
- `brain travel validate [--json]`: `{validation: {valid, files, issues}}`,
  with issues `{file, level: "error", message}`. Exit 0 means valid, 1 means
  domain errors. `files` counts successfully parsed domain documents.
- `brain travel migrate [--dry-run] [--json]`: `{migration: {path, changed,
  dry_run}}`. `changed` reports whether the migration has an edit; dry run
  leaves the file untouched. Refusals exit 1 with an actionable stderr message.
- `brain travel photo <files> --to <dir> [--name <descriptor>] [--date YYYY-MM-DD]
  [--force-date] [--json]`: `{photo: {files, errors}}`;
  see [Photo copies](#photo-copies) for fields, failure behavior and output rules.
- The root export supplies the manifest/config schema, content schemas,
  `parseTravelDocument`, `readTravelCorpus` and `summarizePlaceVisits` with
  their corresponding types. `./module` supplies the manifest for the loader.

Day-trip/place workflows and generated registries are covered by
[#569](https://github.com/schlessera/brain-kit/issues/569).

## Route import

```sh
brain travel route recordings/odysseus.gpx --to routes --json
brain travel route recordings/odysseus.gpx --to routes --trim-start-m 100 --trim-end-m 100 --json
brain travel route recordings/odysseus.gpx --to routes --name "Ferry to Scheria" --date 2026-09-27 --json
```

Input and output paths are relative to the brain root (absolute contained
paths also work). The original stays untouched. An occupied output name
gets `-2`, `-3`, and so on; an existing file is never replaced. Output paths
in the response are relative to the brain root. Importing a recording does
not attach it to a trip or change a Markdown document.

With `--name`, local GPX, direct URLs and Komoot use `[<date>-]<slug(label)>.gpx`,
with the same [descriptor validation](#photo-copies) as photos. The date is
optional and comes only from `--date`, never the recording timestamps. Every
successful route result has `date_source: "flag"` when a date is applied to a
requested name, otherwise `"none"`; routes never report `"exif"`. Without
`--name`, source-derived names are unchanged even if a valid date is supplied.
Route has no `--force-date` option. Invalid dates/descriptors refuse before
fetching a remote route or writing an output.

Supported inputs are local GPX 1.0/1.1 files, direct HTTP(S) GPX URLs, and
public `komoot.com/tour/<id>` or `komoot.com/smarttour/<id>` pages, including
`www` and locale prefixes. Public pages use anonymous requests and discard
query/share tokens. Private, deleted, login-only, malformed and unsupported
pages refuse with an error. Komoot page geometry can have different sampling
from its exported GPX; metrics describe the imported points. The package
does not request account credentials or use Komoot's authenticated export.

HTTP uses the shared scrape client's User-Agent, robots.txt enforcement,
redirect checks and pacing. Embedded credentials, unsupported schemes and
hosts resolving to private/reserved addresses are refused before dispatch;
redirect targets receive the same checks. Files and responses are capped at
20 MiB and geometry at 200,000 points. XML doctypes/entities and unsupported
encodings are refused. These address checks do not pin DNS answers to the
HTTP connection. Robots lookup failures retain the shared client's documented
permissive policy.

GPX track segments take precedence over route elements. Gaps between
segments add no distance, ascent or duration; segments with fewer than two
points are omitted with a warning. Missing/invalid elevations and timestamps
stay unknown. Invalid latitude/longitude rejects the input. Source metadata,
waypoints, links and extensions are discarded. The output contains only
retained track points, optional elevations/timestamps and recomputed bounds.

Metrics derive from the points written to GPX:

- Distance is the sum of spherical great-circle edges (mean Earth radius
  6,371,008.8 m), reported in kilometres to six decimal places. Coordinates
  are written to nine decimal places, elevations to three.
- Ascent uses a three-point median for interior elevations, retaining each
  segment's endpoints, then a 3 m hysteresis: changes smaller than 3 m from
  the last accepted elevation are ignored; accepted upward changes add to
  ascent. This resets at every segment. Ascent and altitude extrema are
  `null` if any retained point lacks a valid elevation. Altitude extrema use
  retained unsmoothed values, in metres.
- A continuous single segment is a `loop` when its endpoints are within
  both 30 m and 5% of its travelled distance; otherwise it is `one_way`.
  Multiple segments have `unknown` shape.
- Recorded duration sums each segment's last minus first timestamp, in
  seconds to three decimals. Every retained timestamp must be valid and
  nondecreasing within its segment. Gaps are excluded. Missing or reversed
  timestamps yield `null`. Komoot's relative `t` values are not absolute
  recording timestamps and are discarded, so its duration stays `null`.

Trimming measures metres along those same edges, excluding segment gaps.
Boundaries interpolate on the great circle; known elevations and ordered
timestamps interpolate linearly. Unknown endpoint data stays unknown.
Nonzero cuts must be at least 1 mm. Trimming away the entire route, a
zero-distance input, an ambiguous antipodal cut or a retained distance below
1 mm reporting precision refuses without writing. For the documented sphere,
each cut's position is within 1 cm after serialization and reported distance
rounding; this is a computational tolerance, not a GPS accuracy claim.
Bounds and all metrics are rebuilt after trimming. Removing departure/end
points does not hide a location that the retained track visits again.

### Source access evidence

Checked 2026-10-01: normal anonymous HTTP requests to Komoot tour and
smarttour pages expose `page._embedded.tour._embedded.coordinates.items` in
the JSON string passed to `kmtBoot.setProps`. The parser decodes that JSON
without running JavaScript. Deterministic CLI fixtures use the observed
structure with invented Odysseus geometry. Komoot documents that its official
[GPX export requires an unlocked region](https://support.komoot.com/hc/en-us/articles/10115477099674-Export-and-import-Routes-and-Activities).
The [GPX schema](https://www.topografix.com/gpx/1/1/) specifies WGS84 positions,
metric elevations and continuous track segments.

Outdooractive import remains an unmet requirement of
[#568](https://github.com/schlessera/brain-kit/issues/568). Its public page
offers a login-gated GPX export; [robots.txt](https://www.outdooractive.com/robots.txt)
disallows GPX download paths and `/api/*`, including the geometry API its
public map uses. Its documented [Data API](https://developers.outdooractive.com/API-Reference/Data-API.html)
requires a project/API key. The [robots-wins decision](../../docs/decisions/scraping-politeness.md)
requires written site permission before using a disallowed path. Rendering
the public map to observe its response shape grants no importing permission.
Outdooractive URLs therefore give an actionable refusal. A user-exported
local GPX can be processed, but that does not complete the Outdooractive
criterion. #568 records the exact permission and completion evidence needed.
