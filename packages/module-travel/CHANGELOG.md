# @schlessera/brain-module-travel

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
