---
"@schlessera/brain": minor
"@schlessera/brain-geo": minor
"@schlessera/brain-render-template": minor
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

**Breaking (pre-1.0, ruled on #1053):** narrow the public surfaces that were public only because a public declaration reached them, and move the names whose classification was uncertain.

- `@schlessera/brain-ui-server`: `WsHost` keeps its configuration fields, `registry` and `close()`. Its connection, client-set, catalog, turn, activity, inbox, draft, label and classification members are `@internal`, as are the matching `WsHostOptions` fields. `SessionCatalog` and `createSessionCatalog` move to `@schlessera/brain-ui-server/internal`; a custom session catalog is no longer supported, so build the host with `createApp`.
- `@schlessera/brain-ui-react`: `useChatStore`, `useFileStore`, `useShareStore`, `useUIStore` and `useVoiceStore` are typed as `ShellStoreHook<View>` over the new `ChatShellState`, `FileShellState`, `ShareShellState`, `UIShellState` and `VoiceShellState`, which hold the fields a shell reads and calls. The selector form and the `getState()`/`subscribe()` statics remain; `setState` is no longer typed. `activeChat`, `anyStreaming` and `hasPendingShare` take the views. `ShareIntakeState` is no longer exported, the full store state types leave the public surface, and `BrainUiRoot.stores` is `@internal`.
- Moved to `/internal`, with no compatibility promise: `collectStats` and `CollectStatsOptions` (`@schlessera/brain/internal`); `MAX_ROUTE_BYTES` (the new `@schlessera/brain-geo/internal`); `applyExportLinkPolicy` and `protectExportLinkDestinations` (`@schlessera/brain-render-template/internal`); `TOKENS`, `LIGHT_TOKENS`, `canvas` and `TokenName` (`@schlessera/brain-ui-kit/internal`); the SDK's bridge-tool handlers (`handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, with `ImageMaskHandlerOptions` and `LocationHandlerOptions`), `wrapCommand` and `execWrapperSpawnOptions` (`@schlessera/brain-ui-sdk/internal`); `describeRetry`, `canonicalModelId` and `resolveThinkingLevel`, from every SDK entry (`/internal` and `/internal/client`); `createToolRendererRegistry`, `pruneStoredShares`, `ShareTargetError`, `isShareTargetRequest` and `handleShareTargetRequest` (`@schlessera/brain-ui-sdk/internal/client`). `registerShareTarget` and `readShareLaunchParams` stay on `/share-target`.
- Kept and documented: `repoRelativePathSchema` (module config schemas), `MEASURED_RUNTIME` and `runScrape`.

The migration list is in `docs/decisions/public-export-boundary.md`.
