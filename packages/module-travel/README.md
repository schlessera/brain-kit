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

Copies use the source basename with `.jpg`. An occupied name receives `-2`,
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
| `location` | Original EXIF `{lat, lon}` in decimal degrees, or `null`. |

Capture time retains a written fractional second and UTC offset. Without an
offset it stays a local time such as `2026-07-15T12:34:56`; the process timezone
never supplies one. Missing or impossible dates remain `null`. Coordinates
require a finite latitude/longitude pair within their normal ranges; zero is
valid. These values are returned separately, never embedded in the copy or
written to a sidecar.

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
speaking. Before indexing an upgraded speaking-only brain:

1. Install the matching travel package when this release is available.
2. Add `"@schlessera/brain-module-travel": {}` to `modules`, keeping speaking
   enabled if you use its workflows.
3. Run `brain travel migrate --dry-run --json`, then `brain travel migrate
   --json`. Review and commit the changed config.
4. Start a fresh process/session and run `brain module lint travel`,
   `brain validate`, `brain travel validate`, and `brain skills sync`.

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

[Module settings #528](https://github.com/schlessera/brain-kit/issues/528) owns per-module JSON settings and their shared CLI/API writer. Until
that path ships, this migration operates on the existing canonical config.
If `settings/speaking.json` or `settings/travel.json` already exists, it
refuses the migration so their precedence can be reviewed explicitly; it
never overwrites those files.

## CLI and library

- `brain travel validate [--json]`: `{validation: {valid, files, issues}}`,
  with issues `{file, level: "error", message}`. Exit 0 means valid, 1 means
  domain errors. `files` counts successfully parsed domain documents.
- `brain travel migrate [--dry-run] [--json]`: `{migration: {path, changed,
  dry_run}}`. `changed` reports whether the migration has an edit; dry run
  leaves the file untouched. Refusals exit 1 with an actionable stderr message.
- `brain travel photo <files> --to <dir> [--json]`: `{photo: {files, errors}}`;
  see [Photo copies](#photo-copies) for fields, failure behavior and output rules.
- The root export supplies the manifest/config schema, content schemas,
  `parseTravelDocument`, `readTravelCorpus` and `summarizePlaceVisits` with
  their corresponding types. `./module` supplies the manifest for the loader.

The package provides canonical content, existing journey planning and photo
processing. Route fetching/metrics, day-trip/place workflows and generated
registries are the separate follow-ups [#568](https://github.com/schlessera/brain-kit/issues/568) and
[#569](https://github.com/schlessera/brain-kit/issues/569).
