# @schlessera/brain-module-travel

## 0.43.1

### Patch Changes

- @schlessera/brain@0.43.1
- @schlessera/brain-scrape@0.43.1
- @schlessera/brain-geo@0.43.1
- @schlessera/brain-common@0.43.1

## 0.43.0

### Patch Changes

- @schlessera/brain@0.43.0
- @schlessera/brain-scrape@0.43.0
- @schlessera/brain-geo@0.43.0
- @schlessera/brain-common@0.43.0

## 0.42.1

### Patch Changes

- @schlessera/brain@0.42.1
- @schlessera/brain-scrape@0.42.1
- @schlessera/brain-geo@0.42.1
- @schlessera/brain-common@0.42.1

## 0.42.0

### Patch Changes

- Updated dependencies [52cbd1d]
- Updated dependencies [8b4fbdc]
- Updated dependencies [3b408f8]
- Updated dependencies [5876df6]
- Updated dependencies [f5433b3]
- Updated dependencies [185803c]
- Updated dependencies [999dbe6]
- Updated dependencies [46056f6]
- Updated dependencies [703a922]
- Updated dependencies [1283ca4]
- Updated dependencies [7a10cdf]
- Updated dependencies [b8862b3]
- Updated dependencies [4914236]
  - @schlessera/brain-common@0.42.0
  - @schlessera/brain@0.42.0
  - @schlessera/brain-scrape@0.42.0
  - @schlessera/brain-geo@0.42.0

## 0.41.0

### Minor Changes

- a4120ed: Add `@schlessera/brain/module`, the supported entry for module authors (`@experimental` until 1.0). It carries the path-containment and atomic-write helpers (`safeResolve`, `resolveWritable`, `writeFileSafely`, `WriteRefusedError`), the scratch helpers, frontmatter splitting and generated regions, `buildTaxonomy`, `getMarkdownFiles`, `runRegistry`, and completion-provider resolution (`resolveCompletionProvider`, `geminiCompletions`, `GEMINI_FLASH_MODEL`). `CommandContext` gains an optional `completions`, the brain's `completions` config block, so a module command honours the configured provider. The first-party modules now use this entry instead of `@schlessera/brain/internal`, so a module published outside this repository can do everything they do. `GEMINI_FLASH_MODEL` is now typed `string` rather than its literal value.
- 2dd5502: Add `brain travel sync [--check]`, which regenerates `trips/_index.md` (Done, Proposed and Dismissed day trips) and `places/_index.md` (countries visited, every place and the places reached each year) from the canonical journey, trip and place records. Only the `travel-trips` and `travel-places` generated regions change; prose around them, including the trips index's choosing rules, keeps its bytes, and an unchanged brain writes nothing. A visit linked from several places counts once, and unknown dates and coordinates stay `unknown`. Any invalid record or malformed region refuses the run and writes neither registry. New `trip-log` and `places` skills propose, record and dismiss trips and record visited places through the photo, route and sync commands; `plan-travel` now records a completed journey's visit.
- 91995dc: Add optional descriptive/date-based output names for travel photo and route
  commands, with `date_source` reporting the date actually applied to a requested
  name. Photos preserve original capture metadata and support explicit forced
  visit dates; legacy names and non-overwriting publication remain intact.

### Patch Changes

- 1caadca: Add `@schlessera/brain-common`, an internal-only package with no compatibility promise. Its `./internal/env` entry holds the environment descriptor core and `./internal/frontmatter` holds the cache-free `parseFrontmatter`. The packages that carried byte-identical copies of these files now depend on it instead. Environment and frontmatter parsing behave exactly as before, and every public export is unchanged. module-finance, module-jobs, module-travel and ui-server no longer depend on `gray-matter` directly.
- 9fae65f: An Outdooractive route URL is now refused with the supported path: export the GPX from the route page while signed in, then import the local file.
- 1c8716a: Accept the global `--human` flag in travel route, validate and migrate commands, preserving their existing human output and rejecting unknown flags.
- 07b5681: Direct saved-settings travel migration refusals to reviewed manual upgrade guidance instead of an unavailable automatic settings migration. Preserve the filename, refusal status and no-changes assurance.
- f2000d0: Update the travel upgrade guidance for the delivered JSON module settings writer and precedence. Document the source-only migration's existing refusals and a reviewed manual upgrade that preserves complete party values, unrelated settings and content. Align speaking's upgrade pointer; command behavior and user formats are unchanged.
- Updated dependencies [8e5c9e8]
- Updated dependencies [b0815ec]
- Updated dependencies [62cf4d6]
- Updated dependencies [a8f884f]
- Updated dependencies [6cb61cb]
- Updated dependencies [20557bf]
- Updated dependencies [b81ff20]
- Updated dependencies [1caadca]
- Updated dependencies [a4120ed]
- Updated dependencies [08663e0]
- Updated dependencies [825cd04]
- Updated dependencies [e12287d]
- Updated dependencies [2edf82b]
- Updated dependencies [2907722]
- Updated dependencies [1a943d8]
- Updated dependencies [1de5e19]
- Updated dependencies [651718a]
- Updated dependencies [d57dc62]
- Updated dependencies [e632b50]
- Updated dependencies [dbea4f5]
- Updated dependencies [ae61e82]
- Updated dependencies [d4eff9f]
- Updated dependencies [a95a924]
- Updated dependencies [8cb13a6]
- Updated dependencies [a26209c]
- Updated dependencies [7719bca]
- Updated dependencies [2a7de32]
- Updated dependencies [83585eb]
- Updated dependencies [9072d22]
- Updated dependencies [b300bb3]
- Updated dependencies [d641a7d]
  - @schlessera/brain@0.41.0
  - @schlessera/brain-geo@0.41.0
  - @schlessera/brain-common@0.41.0
  - @schlessera/brain-scrape@0.41.0

## 0.40.0

### Minor Changes

- c8e81ad: Add module dormancy, context estimates and source-preserving CLI toggles with explicit instruction ownership and legacy migration checks.
- a1d6b08: Add `brain travel route` for local/direct GPX and public Komoot tour/smarttour geometry, with derived metrics, along-track privacy trimming and non-overwriting normalized GPX output. Outdooractive remains unavailable pending written site permission for its robots-disallowed geometry endpoint.
- 502d6d9: Add standalone travel with canonical journey, day-trip and place formats and a lossless configuration migration.

  Pre-1.0 break: speaking stops contributing travel taxonomy and plan-travel. Install and enable the matching travel module, migrate travelParty with `brain travel migrate`, then restart and sync skills; existing document paths, types and links are preserved.

- 5ff0792: Add `brain travel photo` to create reduced, correctly oriented JPEG copies
  without input metadata. Report original capture time and coordinates separately,
  preserve source bytes, and allocate output names without overwriting existing files.

### Patch Changes

- 67c7403: Add the shared geo library with explicit GPX recovery and unit-bearing track summaries, normalized-track recovery and directional proximity measurements while retaining strict travel parsing and measurements.

  Add configured Nominatim geocoding with qualified candidates, explicit service failures, disk cache/source age and shared operator admission across CLI/server processes.

  Add configured prepared-dataset routing and explicit eligible FOSSGIS fallback, with honest source/transfer/cache metadata and nullable provider estimates.

  Add bounded Overpass POI queries near points or along retained track sections, mapped opening-hours unknowns, ordered fallback and persistent admission refusal handling.

  Share the existing SDK coastline/land/road geometry through geo, keeping compatibility exports/result-or-empty behavior while adding canonical configuration, cached layer sources and shared admission.

  Route SDK reverse geocoding through the shared client while retaining its nullable address result. Public Nominatim now requires explicit informed eligibility; the location tool keeps raw coordinates when eligibility is absent. Both first-party backends expose the opt-in setting.

  Add canonical geo configuration to brain config and the UI server adapter, preserving legacy endpoint/privacy switches and keeping disposable response caches separate from permanent geometry caches and global operator admission.

  Add deterministic vector static PNG maps with bundled fonts, preserved track gaps, numbered stops, complete legends and source/attribution evidence. Wide or unavailable backgrounds yield plain maps; unsupported projection, glyphs or image budgets retain complete text without changing source geometry.

  Add brain geo geocode, route, poi, track and map with one-document JSON contracts and qualified human output. Commands share canonical service configuration and cache/admission, retain original track evidence and protect local map writes through brain/scratch containment.

- Updated dependencies [b1b83cd]
- Updated dependencies [e977423]
- Updated dependencies [113fa0a]
- Updated dependencies [6b311b2]
- Updated dependencies [fe5c751]
- Updated dependencies [eac3e7a]
- Updated dependencies [5df68f6]
- Updated dependencies [c926d42]
- Updated dependencies [f19da8b]
- Updated dependencies [22ed27c]
- Updated dependencies [9c830e4]
- Updated dependencies [36ad7da]
- Updated dependencies [523ffa8]
- Updated dependencies [c8e81ad]
- Updated dependencies [a39b7bc]
- Updated dependencies [4503591]
- Updated dependencies [fb992c8]
- Updated dependencies [2898ef1]
- Updated dependencies [619ee2b]
- Updated dependencies [2480efe]
- Updated dependencies [14bacbb]
- Updated dependencies [a4cc575]
- Updated dependencies [d981938]
- Updated dependencies [ac34a83]
- Updated dependencies [56a9005]
- Updated dependencies [67c7403]
- Updated dependencies [3811290]
- Updated dependencies [878e6cf]
- Updated dependencies [a5e1ecf]
- Updated dependencies [e977423]
- Updated dependencies [3f0870d]
- Updated dependencies [502d6d9]
- Updated dependencies [fa6a62c]
- Updated dependencies [17146c4]
  - @schlessera/brain@0.40.0
  - @schlessera/brain-scrape@0.40.0
  - @schlessera/brain-geo@0.40.0
