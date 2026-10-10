---
name: trip-log
description: Use when proposing a day trip, recording that one was done (again), attaching its routes and photos, dismissing an idea, or answering "what have we done?" and "where should we go next?" from the trip registry.
---

# Trip Log

Keeps the day-trip record: one `trips/{slug}.md` per repeatable route or place,
with its whole visit history. The trip frontmatter is the record; the
`trips/_index.md` tables are generated from it by `brain travel sync`. The
formats and their rules are in the travel module README ("Canonical formats");
read it before writing a trip you have not written before.

This skill decides *what* to record and asks the user what only they know.
Photo reduction, route import, metrics and registries are CLI jobs: never
compute a distance, resize a photo or edit a generated table by hand.

## Prompts

Ask only what the chosen action needs.

1. **Action**: propose, record a visit, attach a route or photos, dismiss, or
   review ("what have we done?", "what next?")
2. **Which trip**: match against existing `trips/*.md` titles and places first;
   a trip done again is a new visit on the same file, never a new file
3. **For a visit**: date (unknown is allowed — record `null`, never guess),
   who came (default to the configured `travelParty`), which route variant,
   and a one-line verdict in the user's words
4. **For a route**: the source (a komoot link, a GPX file, an official page),
   and whether it was the plan or the recording. For a recording that starts
   or ends at home, ask how many metres to trim from each end
5. **For photos**: the files, and which one should be the cover

## Actions

### Propose

1. Derive the slug from the route or place (`ithaca-headland`, not a date).
   Check `trips/` and `brain search` for an existing trip first.
2. Create `trips/{slug}.md` with core frontmatter plus `type: trip`,
   `trip_status: proposed`, and `places:` when the places exist under
   `places/` (see `/places` to add one). A short body says why it appeals.
3. Attach any known route (below). Run `brain travel sync`.

### Attach a route

1. Import it, naming the output after the route label:
   `brain travel route <url|file> --to trips/routes --name "<label>" --json`
   (add `--trim-start-m N --trim-end-m N` for a private start or end).
   An Outdooractive link is refused by design: ask the user to export the
   GPX from the route page and import that file.
2. Add a `routes:` entry: `label`, `source`, `kind` (`planned`, `recorded` or
   `reference`), `gpx` relative to the trip file (`routes/<file>.gpx`), and
   `distance_km`/`ascent_m` copied from the command's JSON. A link the
   command cannot import is a `reference` entry with only `url`.
3. Exactly one route is `primary: true`. Ask before moving it.

### Record a visit

1. Reduce the photos into the trip's folder:
   `brain travel photo <files> --to trips/photos --name "<trip title>" --date <visit date> --json`,
   leaving out `--date` when the visit date is unknown.
   Store each reported `output` relative to the trip file. The command reports
   `captured_at` and `location` from the originals; offer them as the visit
   date or a place hint, and let the user confirm.
2. For a recording, import it as a `recorded` route (above) and set the
   visit's `track` and `actual` (`distance_km`, `ascent_m`, `duration_s` from
   `recorded_duration_s`); unknown values stay `null`.
3. Append to `visits:` a new entry with a fresh stable `id` (`first`,
   `spring-2027`; never reuse one), `date`, `party`, `route` (an existing
   label), `verdict`, `photos`, and `places` for places only this visit
   touched. Set `trip_status: done`. Set `cover:` if the user chose one.
4. For each place this visit reached that has no `places/` record yet, use
   `/places`.

### Dismiss

Set `trip_status: dismissed` and add a sentence to the body saying why.
Keep its visits and routes: dismissing never deletes history.

### Review and choosing rules

1. Run `brain travel sync`, then read `trips/_index.md` and answer from its
   Done, Proposed and Dismissed tables.
2. When verdicts across visits point to a preference ("flat routes when
   recovering", "nothing over 15 km with the dog"), propose the rule to the
   user in one sentence and quote the verdicts behind it. Write it under
   `## Choosing rules` in `trips/_index.md` only after the user agrees.
   That section is outside the generated region and belongs to the user.
3. To suggest the next trip, filter Proposed by those rules and say which
   rule each suggestion satisfies.

### Always finish with

`brain travel validate`, then `brain travel sync`. A validation error names
the file and field; fix the record, do not edit around it. `sync` refuses
to write while any record is invalid.

## References

### Files to Read
- `trips/_index.md` (registry and choosing rules)
- The trip file being changed, and `places/` for place links
- The travel module `travelParty` config for the default party

### Files to Write/Modify
- Create/modify: `trips/{slug}.md`
- Created by commands: `trips/photos/*.jpg`, `trips/routes/*.gpx`
- Modify: `trips/_index.md` only under `## Choosing rules`, with agreement

### Workflow Position
- **Before**: an idea for an outing, or a returned day out
- **After**: `/places` for new places; `/plan-travel` for a journey with
  overnights rather than a day trip
