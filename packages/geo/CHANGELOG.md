# @schlessera/brain-geo

## 0.42.1

## 0.42.0

## 0.41.0

### Minor Changes

- b0815ec: **Breaking (pre-1.0, ruled on #1053):** narrow the public surfaces that were public only because a public declaration reached them, and move the names whose classification was uncertain.

  - `@schlessera/brain-ui-server`: `WsHost` keeps its configuration fields, `registry` and `close()`. Its connection, client-set, catalog, turn, activity, inbox, draft, label and classification members are `@internal`, as are the matching `WsHostOptions` fields. `SessionCatalog` and `createSessionCatalog` move to `@schlessera/brain-ui-server/internal`; a custom session catalog is no longer supported, so build the host with `createApp`.
  - `@schlessera/brain-ui-react`: `useChatStore`, `useFileStore`, `useShareStore`, `useUIStore` and `useVoiceStore` are typed as `ShellStoreHook<View>` over the new `ChatShellState`, `FileShellState`, `ShareShellState`, `UIShellState` and `VoiceShellState`, which hold the fields a shell reads and calls. The selector form and the `getState()`/`subscribe()` statics remain; `setState` is no longer typed. `activeChat`, `anyStreaming` and `hasPendingShare` take the views. `ShareIntakeState` is no longer exported, the full store state types leave the public surface, and `BrainUiRoot.stores` is `@internal`.
  - Moved to `/internal`, with no compatibility promise: `collectStats` and `CollectStatsOptions` (`@schlessera/brain/internal`); `MAX_ROUTE_BYTES` (the new `@schlessera/brain-geo/internal`); `applyExportLinkPolicy` and `protectExportLinkDestinations` (`@schlessera/brain-render-template/internal`); `TOKENS`, `LIGHT_TOKENS`, `canvas` and `TokenName` (`@schlessera/brain-ui-kit/internal`); the SDK's bridge-tool handlers (`handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, with `ImageMaskHandlerOptions` and `LocationHandlerOptions`), `wrapCommand` and `execWrapperSpawnOptions` (`@schlessera/brain-ui-sdk/internal`); `describeRetry`, `canonicalModelId` and `resolveThinkingLevel`, from every SDK entry (`/internal` and `/internal/client`); `createToolRendererRegistry`, `pruneStoredShares`, `ShareTargetError`, `isShareTargetRequest` and `handleShareTargetRequest` (`@schlessera/brain-ui-sdk/internal/client`). `registerShareTarget` and `readShareLaunchParams` stay on `/share-target`.
  - Kept and documented: `repoRelativePathSchema` (module config schemas), `MEASURED_RUNTIME` and `runScrape`.

  The migration list is in `docs/decisions/public-export-boundary.md`.

## 0.40.0

### Minor Changes

- 67c7403: Add the shared geo library with explicit GPX recovery and unit-bearing track summaries, normalized-track recovery and directional proximity measurements while retaining strict travel parsing and measurements.

  Add configured Nominatim geocoding with qualified candidates, explicit service failures, disk cache/source age and shared operator admission across CLI/server processes.

  Add configured prepared-dataset routing and explicit eligible FOSSGIS fallback, with honest source/transfer/cache metadata and nullable provider estimates.

  Add bounded Overpass POI queries near points or along retained track sections, mapped opening-hours unknowns, ordered fallback and persistent admission refusal handling.

  Share the existing SDK coastline/land/road geometry through geo, keeping compatibility exports/result-or-empty behavior while adding canonical configuration, cached layer sources and shared admission.

  Route SDK reverse geocoding through the shared client while retaining its nullable address result. Public Nominatim now requires explicit informed eligibility; the location tool keeps raw coordinates when eligibility is absent. Both first-party backends expose the opt-in setting.

  Add canonical geo configuration to brain config and the UI server adapter, preserving legacy endpoint/privacy switches and keeping disposable response caches separate from permanent geometry caches and global operator admission.

  Add deterministic vector static PNG maps with bundled fonts, preserved track gaps, numbered stops, complete legends and source/attribution evidence. Wide or unavailable backgrounds yield plain maps; unsupported projection, glyphs or image budgets retain complete text without changing source geometry.

  Add brain geo geocode, route, poi, track and map with one-document JSON contracts and qualified human output. Commands share canonical service configuration and cache/admission, retain original track evidence and protect local map writes through brain/scratch containment.

- 3f0870d: Attach validated GPX, KML and supported GeoJSON originals in chat, preserving incoming names and MIME separately from detected staged names. Keep server-derived file evidence on queued turns and replay. Draw static track blocks with complete metrics, waypoint evidence, explicit unknown and partial values, separate gaps and original references; resolve assets before PNG/PDF export. Generic share intake remains compatible.
