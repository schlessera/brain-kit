# The public export boundary

**Decided 2026-09-28 by the maintainer**
([#343 question 1](https://github.com/schlessera/brain-kit/issues/343)),
implemented in #534. Binds every export of every `@schlessera/brain-*` entry
point, and what a breaking change to one means.

## The decision

Reduce public exports before 1.0, then stabilize the deliberately public
surface. An export is reached from one of two kinds of entry point:

- **Ordinary entry points** (`.`, `./server`, `./client`, `./queries`,
  `./testing` …) carry only the intended, documented API. Everything they
  export is supported: experimental until 1.0 where its own declaration or the
  [integration contract](../integration-contract.md) says so, then stable. The
  supported surface includes **every type reachable through a public
  signature** (parameter, return, property, heritage clause, type argument),
  whether or not the type is exported by name, and the documented behavior
  of the API, not only its type compatibility.
- **Internal entry points** (`./internal`, and `./internal/client` in the UI
  SDK for browser code) carry first-party implementation sharing between
  brain-kit packages. They have **no compatibility promise**, may change in any
  release, and are only valid with the same lockstep version on both sides. A
  third party that imports one is on its own.

A member of a public declaration may be excluded from the supported surface
by an `@internal` JSDoc tag on the member itself, when a package's own modules
need to reach it through a public type (`WsHost.coordinator`, pi's
`sessionFactory` test hook). The exclusion sits on the declaration, not in a
distant disclaimer; it is not available for whole exports.

After 1.0, removing, renaming or retyping an ordinary export or any type its
signatures reach, or changing documented behavior, is a breaking change and
needs a major version. Additions are minors. Before 1.0 the
[contract-versioning rules](contract-versioning.md) apply unchanged: a break
ships in a minor only after a ruling on its issue, with the `breaking` label
and a changeset that names it. Lockstep versioning is unchanged.

## Why export reduction

Three options were on the table:

- **Freeze every current export.** Rejected. Half of the exported names were
  there because one first-party package used them from another, or because a
  test once did. Freezing them would make the project's implementation tables
  (lock keys, web-search provider lists, the classification pass, scoring and
  database helpers of the modules) permanent API merely because they were
  reachable, and every later refactor of them a major.
- **Keep the exports and exclude the unlisted ones in prose.** Rejected. The
  integration contract said "internal implementation details outside these
  listed or delegated promises may change without notice", while the package
  entry points kept exporting them. A
  consumer reading the package could not tell a supported API from an
  incidental one, and the doc and the entry points described different
  boundaries. Q1 requires the entry points themselves to be the boundary.
- **Reduce, then stabilize** (chosen). Removing accidental exposure is cheap
  before external users depend on it, and it makes the remaining obligation
  small and reviewable. The cost is a one-time pre-1.0 break for anyone who
  imported a removed name; the migration below names every one.

## How names were classified

Every export of every entry point was classified against the consumer roles
the documentation supports, not against whether something in the tree
imported it:

1. **Public** — named as something a consumer imports, calls or implements in
   a user-facing doc (the integration contract, `docs/extending/`, the module,
   configuration, HTTP and CLI guides, a package README), or needed by a
   documented role even when not named individually: extension-seam
   implementer (`define*` helpers and the `./testing` conformance kits),
   module author (#537 owns that inventory), backend author (the
   [toolkit inventory](backend-authoring-toolkit.md)), deployment shell, wire
   protocol client, service worker. A type reachable from a public signature
   is public with it.
2. **Internal** — another brain-kit package's source imports it and no
   supported role needs it. It moved to the owning package's internal entry.
3. **Removed** — no other package's source needs it and no supported role
   does. The symbol stays in its source module; it is no longer exported from
   an entry point. Tests import it from source.

Existing rulings were applied as they stand: the wire protocol and its schemas
are a machine contract ([Q5](contract-versioning.md#wire-protocol-classification--2026-09-28)),
the content-index query API is `./queries` ([Q7](index-query-api.md)), the
backend toolkit follows Q2, the SiteAdapter family follows
[its adoption decision](site-adapter-adoption.md), the renderer API follows
[the renderer budgets](renderer-budgets.md), and the environment descriptor
exports stay with the [supported inputs](supported-inputs.md). Where the
evidence was mixed the name stayed public: a later narrowing is an ordinary
pre-1.0 break, while a removal that a supported role needed would be a
regression.

What that left, by package:

- **`@schlessera/brain`.** Configuration authoring, the module-authoring API
  and its contexts (#537), the five seams with their `define*` helpers and
  reachable types, the reranker fan-out helpers the
  [reranker guide](../extending/rerankers.md) documents, `syncSkills`,
  enrichment, `SCHEMA_VERSION`, the search result shapes and the environment
  descriptors. Database, indexing, ingestion, search and archive functions
  that take native handles left the root: first-party callers use `./internal`,
  everyone else the supported `./queries` results. Path-safety, scratch and
  generated-region helpers the modules share moved to `./internal`.
- **Modules.** The module definition, its config schema and config type, the
  environment descriptors, and the shapes the contract documents (jobs'
  `JobAdapter` composition, `ScrapeReport`, `JobSummary`, review statuses,
  travel's documented library). Ledger, scoring, routing, database and review
  internals are no longer exported.
- **`@schlessera/brain-scrape`, `@schlessera/brain-geo`.** The SiteAdapter
  seam, the polite client, the browser session and the documented parsing
  helpers; geo's documented operations. `hostOf`, `Semaphore` and
  `DEFAULT_USER_AGENT` moved to scrape's `./internal`.
- **Backends.** The factories, their options, `backendModule`, profiles and
  the environment descriptors. Model-discovery and pi runtime building blocks
  (auth, tools, permission gate, history, event mapping) are no longer
  exported.
- **`@schlessera/brain-ui-sdk`.** The protocol and schemas in full, the
  backend and speech seams, the toolkit, the transcript store, locks, version
  checks, tool contracts and their schemas, the client registries and
  `BrainUiClient`, and the service-worker handlers. Exec-wrapper, lock-key,
  web-search, mask-path and classification helpers moved to `./internal`;
  ui-react's registry singletons and form helpers to the browser-safe
  `./internal/client`, which imports no Node built-in. Per-kind block schemas,
  tone/kind tables and classification internals are no longer exported.
- **`@schlessera/brain-ui-server`, `@schlessera/brain-ui-react`.** What a
  deployment shell composes: `createApp`, its configuration, observability and
  the handle fields; ui-react's pages, shell, provider, stores' hooks and the
  REST client. Route-level helpers, store internals of the default root, URL
  helpers and Mermaid internals are no longer exported. The app database
  factory and keyterm builder that the packed-package checks run moved to
  ui-server's `./internal`, as did pi's brain-tool building blocks to pi's.
- **`@schlessera/brain-ui-kit`, `@schlessera/brain-render-template`.** Every kit
  component with its props, the tokens and `./links`; the render template's
  documented builders. The link-policy duplicates left the kit's root
  (`./links` carries them); `printThemeCss`, `mapViewBounds`, `documentTitle`
  and `isFullDocument` moved to `./internal`.

Some public names were there because a public declaration reached them rather
than because they were useful on their own: `WsHost` reached the server's
connection and turn types, and ui-react's store hooks reached their state
shapes. Narrowing those declarations was an API redesign rather than an export
cleanup, so #534 left them, and the names it could only classify as uncertain,
for a ruling of their own.

## Narrowing what a public declaration reached

**Decided 2026-10-06 by the maintainer**
([#1053](https://github.com/schlessera/brain-kit/issues/1053)), item by item:
(a) keep public and document the consumer role, (b) keep the entry point but
narrow the declaration that reaches internal shapes, or (c) move the name to
the owning package's `/internal` entry.

- **`WsHost` (b).** The class stays public as the type of `BrainUiApp.wsHost`.
  Its supported members are the resolved configuration, the backend
  `registry` (a shell awaits `registry.getBackends()` at boot) and `close()`.
  Every member that reached the connection, client-set, catalog, turn,
  activity, inbox, draft, label or classification types is tagged `@internal`,
  and so are the `WsHostOptions` fields `createApp` fills with them. The
  catalog was the one required option among them, so `SessionCatalog` and
  `createSessionCatalog` moved to ui-server's `./internal`: a custom session
  catalog stops being supported, and `createApp` is how a host is built. The
  `askUserFormLimits` option the conditional-forms guide named remains, and
  that guide now points at the same field on `ServerConfig`.
- **ui-react's store hooks (b).** `useChatStore`, `useFileStore`,
  `useShareStore`, `useUIStore` and `useVoiceStore` are `ShellStoreHook`s over
  published views (`ChatShellState`, `FileShellState`, `ShareShellState`,
  `UIShellState`, `VoiceShellState`). Each view holds what a deployment shell
  reads and calls: the service-worker reload guard (chat streaming, voice
  capture and review, share intake), the active view and the file deep link.
  The hooks keep their selector form and their default-root `getState` and
  `subscribe` statics; `setState` is no longer typed. `activeChat`,
  `anyStreaming` and `hasPendingShare` take the views. The full state shapes
  stay with the package's own hooks in its `*-store.ts` modules, and
  `BrainUiServices.stores`, which carried all of them, is tagged `@internal`.
  An imperative read against an explicit root therefore has no supported path
  for now. One can be added in a minor once a shell needs it; the reverse
  would take a major.
- **Kept (a).** Core's `repoRelativePathSchema` (a module config schema's path
  setting, stated in the integration contract), Claude's `MEASURED_RUNTIME`
  (the measured runtime pair, stated in the backend guide) and jobs'
  `runScrape` (the direct scrape fallback, stated in the jobs README).
- **Moved (c).** Core's `collectStats`, whose signature takes a native
  `bun:sqlite` handle (the stats contract describes `brain stats`, not the
  export; `BrainStats` and `StatsThresholds` stay as the result shape). The
  SDK's bridge-tool handlers, `wrapCommand`, `execWrapperSpawnOptions`,
  `describeRetry`, `canonicalModelId`, `resolveThinkingLevel`,
  `createToolRendererRegistry`, `pruneStoredShares`, `ShareTargetError`,
  `isShareTargetRequest` and `handleShareTargetRequest`. The kit's `TOKENS`,
  `LIGHT_TOKENS` and `canvas`, with `TokenName`, whose definition is
  `keyof typeof TOKENS` and would otherwise keep the table recorded.
  Render-template's `applyExportLinkPolicy` and
  `protectExportLinkDestinations`. Geo's `MAX_ROUTE_BYTES`, for which geo
  gained an `./internal` entry. None had a documented consumer.

Where a moved name was declared in an entry module, or in a module an entry
re-exports whole (`share-target.ts`, `protocol.ts`, geo's `track.ts`), its
declaration moved to a module of its own (`share-target-handler.ts`,
`protocol-helpers.ts`, `limits.ts`), so the public entry no longer re-exports
it. What still reaches a server connection type is `ActivityStream`, through
its subscription handlers; the ruling did not cover it.

## How it is enforced

- `api-report/<package>.txt` lists every entry point's names, internal ones
  included, so a new internal export is still a reviewed diff. Its signature
  section now records **every public export**, not only the seams, with every
  declaration of this repo that it reaches. A reached declaration owned by
  another package's public surface is recorded in that package's report; a
  re-export says where it is recorded, and a third-party re-export names its
  package. `tests/api-surface.test.ts` fails on any drift and asserts that no
  public name lacks a signature entry.
- An inferred return type or an unannotated constant is printed from the
  checker, and the repo declarations it names are followed, so a change to
  what a function returns is a changed line. Parameters and properties must
  still be written down (`scripts/api-report.ts` refuses them otherwise).
- `scripts/check-dist-types.ts` holds the built declarations to the same
  boundary: for every subpath of every packed package, the emitted module's
  runtime keys must equal the report's values exactly, and every type-only
  name the report lists must resolve, under ordinary consumer resolution with
  no source condition.

## Migration

Imports of the names below stop resolving. Brain-kit's own packages were
migrated in the same change. A consumer outside brain-kit has three paths:

1. If the name is in "moved to an internal entry", it is still available
   there, unsupported and only with the same lockstep version. Prefer not to
   depend on it.
2. If a supported replacement exists, use it: `./queries` for content-index
   reads instead of `openDatabase`, `hybridSearch` and friends; the module's
   CLI or MCP tools instead of its library helpers; `./links` for the kit's
   link policy.
3. Otherwise copy what you need. A removed name was never a supported API;
   open an issue describing the role it served if you believe it should be.

Removed from ordinary entry points:

- `@schlessera/brain`: `ASSET_EXTENSIONS`, `ArchiveOptions`, `ArchiveResult`, `AssembleOptions`, `Asset`, `AuditOptions`, `BrainContext`, `CORE_TYPES`, `Chunk`, `Classification`, `CoreEnv`, `DEFAULT_CANONICAL`, `DEFAULT_DIR_ANCHORS`, `DEFAULT_EXCLUDE`, `DEFAULT_STALENESS`, `Document`, `DocumentRelevance`, `DocumentStatus`, `DocumentType`, `FrontmatterValue`, `IndexOptions`, `IndexStats`, `IngestContext`, `IngestInput`, `IngestOutcome`, `InitContextOptions`, `JevRerankerConfig`, `LoadedConfig`, `OkfCheckIssue`, `OkfCheckReport`, `OkfDegradedLink`, `OkfExportError`, `OkfExportOptions`, `OkfExportReport`, `RERANK_MODES`, `ReadPartOptions`, `RegistryRun`, `RegistrySpec`, `RerankMode`, `RerankSetup`, `RerankerConfig`, `RerankerSelection`, `SCRATCH_DIR`, `SCRATCH_MAX_BYTES`, `SCRATCH_TTL_MS`, `SEARCH_SORTS`, `SchemaOptions`, `ScratchFailure`, `ScratchNotIgnoredError`, `ScratchRedirectedError`, `ScratchRemoval`, `ScratchReport`, `SearchDeps`, `SearchOptions`, `SearchResponse`, `SectionNotFoundError`, `VALID_RELEVANCES`, `VALID_STATUSES`, `ValidationIssue`, `VecSupport`, `VecUnavailableReason`, `WriteRefusedError`, `archiveDocument`, `assembleContext`, `assertScratchWritable`, `audit`, `brainConfigSchema`, `buildTaxonomy`, `checkIndexDrift`, `checkOkfBundle`, `chunkDocument`, `chunkTextForEmbedding`, `classifyContent`, `cleanScratch`, `discoverSkills`, `editFrontmatter`, `ensureScratch`, `estimateTokens`, `exportOkfBundle`, `extractWikiLinks`, `filterSearch`, `formatConfigError`, `getAssetFiles`, `getContext`, `getDefaultRerankerMode`, `getMarkdownFiles`, `getMeta`, `hasVecSupport`, `hybridSearch`, `ignoreScratch`, `indexAll`, `inertGeneratedText`, `ingest`, `initContext`, `installBinLinks`, `isInScratch`, `isIsoDate`, `isWriteRefusal`, `jevReranker`, `lintSkills`, `loadModules`, `loadUserConfig`, `loadVecSupport`, `migrateVecSchema`, `normalizeFrontmatterDates`, `openDatabase`, `pruneScratch`, `readDocumentPart`, `readEnvVar`, `readGeneratedRegion`, `registrySpecSchema`, `relevanceOnArchive`, `replaceGeneratedRegion`, `rerank`, `rerankSetup`, `rerankerKeyEnv`, `resolveAgentRunner`, `resolveCompletionProvider`, `resolveEmbeddingProvider`, `resolveEnv`, `resolveRoot`, `resolveWikiLink`, `resolveWritable`, `rewriteGeneratedRegion`, `runRegistry`, `safeResolve`, `scratchDir`, `scratchIgnored`, `scratchName`, `selectReranker`, `setContext`, `setMeta`, `splitFrontmatterBlock`, `storedVectorWidth`, `stringifyDocument`, `updateDocument`, `validate`, `writeFileSafely`, `writeScratchFile`.
- `@schlessera/brain-module-finance`: `AgingBuckets`, `Allocation`, `ClientLedger`, `ClientReport`, `ComputedInvoice`, `FinanceOptions`, `Invoice`, `InvoiceStatus`, `Payment`, `Portfolio`, `SyncResult`, `buildPortfolio`, `checkSync`, `computeClient`, `loadLedgers`, `money`, `renderReport`, `syncFiles`.
- `@schlessera/brain-module-images`: `DEFAULT_MODEL`, `GeneratedImage`, `IMAGE_QUALITIES`, `ImageInput`, `ImageProviderError`, `ImageQuality`, `ImageRequest`, `ImageResult`, `ModelCapabilities`, `PROVIDERS`, `Provider`, `ProviderId`, `RETIRED_MODELS`, `RoutingDecision`, `RoutingInput`, `availableModels`, `estimateGeminiCost`, `isRetiredModel`, `openAiCostFromUsage`, `providerFor`, `route`.
- `@schlessera/brain-module-jobs`: `RETIRED_SOURCES`, `SOURCES`, `SOURCE_STATUSES`, `ScoreBreakdown`, `ScoreJobInput`, `autoClassify`, `getJobById`, `getReviewQueue`, `getStats`, `ingestJobs`, `loadScoringConfig`, `openDatabase`, `parseScoringConfig`, `projectJobSummary`, `rescoreAllJobs`, `reviewJobs`, `scoreJob`, `scoreMaxes`, `scoreNewJobs`, `searchJobs`, `setReviewStatus`.
- `@schlessera/brain-render-template`: `ACCENTS`, `DEFAULT_TITLE`, `OPENER_CLASSES`, `SWITCH_CLASSES`, `documentTitle`, `isFullDocument`.
- `@schlessera/brain-scrape`: `DEFAULT_USER_AGENT`, `Semaphore`, `absoluteUrl`, `hasJsonLdType`, `hostOf`, `jsonLdTypes`, `parseRetryAfterMs`, `readField`.
- `@schlessera/brain-backend-claude`: `AliasChecks`, `DiscoverOptions`, `DiscoverResult`, `canonicalModelId`, `discoverAnthropicModels`, `modelCachePath`.
- `@schlessera/brain-backend-pi`: `BrainAccess`, `BrainToolDeps`, `CreatePiAuthOptions`, `PI_BACKEND_ID`, `PI_THINKING_LEVELS`, `PermissionGateOptions`, `PiAuth`, `PiAuthProviderStatus`, `PiAuthRuntime`, `PiLoginFlow`, `PiLoginFlowStatus`, `PiSessionFactory`, `PiSessionLike`, `PiThinkingLevel`, `RiskClass`, `SessionToolkit`, `ToolLock`, `TurnContext`, `approvalReason`, `createBrainAccess`, `createBrainTools`, `createPermissionGate`, `createPiAuth`, `createTurnContext`, `getPiHistory`, `hasStoredCredential`, `invalidateExtensionCache`, `listPiSessions`, `mapPiEvent`, `normalizeMessages`, `toolLockFromKeyed`, `toolLockFromWriteLock`.
- `@schlessera/brain-ui-kit`: `ASK_LIST_COLLAPSE_AT`, `HATCH_GLYPH`, `LINK_URL_MAX`, `LinkRefusal`, `LinkRefusalReason`, `LinkVerdict`, `MAILTO_ADDRESSES_MAX`, `MailVerdict`, `PLACE_MAP_NO_GEOMETRY`, `PLACE_MAP_POSITIONS_LINE`, `PRINT_TOKENS`, `classifyLink`, `classifyMailto`, `clusterLetter`, `fillOpen`, `groupAnswers`, `mapViewBounds`, `moveRankItem`, `narrowColumns`, `printThemeCss`, `refusalSentence`, `submitLabel`.
- `@schlessera/brain-ui-react`: `MaskEditor`, `MermaidBlock`, `ShareIntake`, `api`, `apiBaseFor`, `createBrainUiConfig`, `getBackendUrl`, `getBackendUrlFor`, `getWsUrl`, `getWsUrlFor`, `handleServerMessage`, `inlineMermaidDiagrams`, `renderMermaidSvg`, `runStateForFrame`, `sendClientMessage`, `uiConfig`, `useConnectionStore`, `useGraphStore`, `useMaskStore`, `useProviderStore`, `useVpnStatus`.
- `@schlessera/brain-render-puppeteer`: `RendererEnv`, `resolveEnv`, `shouldAllowRequest`.
- `@schlessera/brain-ui-sdk/client`: `ASK_USER_FORM_ANSWER_SCHEMA`, `ASK_USER_FORM_DEFAULT_LIMITS`, `ASK_USER_LIST_LIMITS`, `BARS_BLOCK_SCHEMA`, `BLOCK_CONTACT_KINDS`, `BLOCK_CONTACT_TONES`, `BLOCK_DELTA_TONES`, `BLOCK_KINDS`, `BLOCK_QUOTE_TONES`, `BLOCK_STEP_STATES`, `BLOCK_STEP_VARIANTS`, `BLOCK_TONES`, `BLOCK_VALUE_TONES`, `BRIDGE_TOOL_POSTURE`, `BridgeToolAdapter`, `COMPARISON_BLOCK_SCHEMA`, `CONTACT_BLOCK_SCHEMA`, `FRAME_WIDTHS`, `LINK_BLOCK_SCHEMA`, `MAP_BLOCK_SCHEMA`, `MAP_PLACE_SCHEMA`, `MAX_FRAME_DEGREES`, `MIN_SPAN_KM`, `MapPlace`, `ON_MAP_LABEL_MAX`, `QUOTE_BLOCK_SCHEMA`, `RECEIPT_BLOCK_SCHEMA`, `SCHEDULE_BLOCK_SCHEMA`, `SHIPPED_SHOW_BLOCK_SCHEMA_FORM`, `STATS_BLOCK_SCHEMA`, `STEPS_BLOCK_SCHEMA`, `SUGGESTIONS_BLOCK_SCHEMA`, `SUGGESTIONS_MAX_ITEMS`, `SUGGESTION_MAX_LENGTH`, `SUGGESTION_MIN_LENGTH`, `ShowBlockSchemaForm`, `TABLE_BLOCK_SCHEMA`, `TIMELINE_BLOCK_SCHEMA`, `TRACK_BLOCK_SCHEMA`, `TREND_BLOCK_SCHEMA`, `askUserFormNodeComplete`, `askUserFormPayload`, `askUserFormSpec`, `askUserFormVisibleNodes`, `createBrainUiClient`, `defaultAsrClientRegistry`, `defaultToolRendererRegistry`, `drawnBounds`, `formatDistance`, `frameEnvelope`, `haversineKm`, `numberRuns`, `resetAsrClients`, `resetToolRenderers`, `resolveAskUserFormLimits`, `resolveToolRenderer`, `showBlockInputSchema`, `speechUiHints`.
- `@schlessera/brain-ui-sdk/server`: `ASK_USER_FORM_ANSWER_SCHEMA`, `ASK_USER_FORM_DEFAULT_LIMITS`, `ASK_USER_LIST_LIMITS`, `AskedQuestion`, `BARS_BLOCK_SCHEMA`, `BLOCK_CONTACT_KINDS`, `BLOCK_CONTACT_TONES`, `BLOCK_DELTA_TONES`, `BLOCK_KINDS`, `BLOCK_QUOTE_TONES`, `BLOCK_STEP_STATES`, `BLOCK_STEP_VARIANTS`, `BLOCK_TONES`, `BLOCK_VALUE_TONES`, `BRAIN_LOCK_KEY`, `BRIDGE_TOOL_POSTURE`, `BlockquoteCandidate`, `BridgeToolAdapter`, `CANDIDATE_KINDS`, `CATALOGUE_BLOCK_KINDS`, `CLASSIFIER_MODEL`, `COMPARISON_BLOCK_SCHEMA`, `CONFIDENCE`, `CONTACT_BLOCK_SCHEMA`, `Candidate`, `CandidateKind`, `CandidateSpan`, `ChoiceAnswer`, `ChoiceQuestion`, `ClassificationAnswer`, `ClassificationAnswers`, `ClassificationPlan`, `ClassificationQuestion`, `ClassificationQuestions`, `ClassificationRequest`, `Classified`, `EXEC_KILLER_ENV`, `EXEC_WRAPPER_ENV`, `GIT_LOCK_KEY`, `KeyValueRunCandidate`, `LINK_BLOCK_SCHEMA`, `MAP_BLOCK_SCHEMA`, `MAP_PLACE_SCHEMA`, `MapPlace`, `NoulAnswer`, `NoulQuestion`, `OrderedListCandidate`, `PlannedCandidate`, `QUOTE_BLOCK_SCHEMA`, `QuestionObservation`, `RECEIPT_BLOCK_SCHEMA`, `SCHEDULE_BLOCK_SCHEMA`, `SHIPPED_SHOW_BLOCK_SCHEMA_FORM`, `STATS_BLOCK_SCHEMA`, `STEPS_BLOCK_SCHEMA`, `SUGGESTIONS_BLOCK_SCHEMA`, `SUGGESTIONS_MAX_ITEMS`, `SUGGESTION_MAX_LENGTH`, `SUGGESTION_MIN_LENGTH`, `ShowBlockSchemaForm`, `TABLE_BLOCK_SCHEMA`, `TIMELINE_BLOCK_SCHEMA`, `TRACK_BLOCK_SCHEMA`, `TREND_BLOCK_SCHEMA`, `TableCandidate`, `TimedListCandidate`, `VERSION_PROBE_TIMEOUT_MS`, `WEB_SEARCH_FALLBACK_ON`, `WEB_SEARCH_PROVIDERS`, `WEB_SEARCH_PROVIDER_KEYS`, `WebSearchProviderSpec`, `applyClassification`, `askUserFormNodeComplete`, `askUserFormPayload`, `askUserFormSpec`, `askUserFormVisibleNodes`, `askUserListPayload`, `askUserListSpec`, `askUserRankPayload`, `askUserRankSpec`, `bashLockKey`, `claudeMaskFilename`, `claudeReportedMaskPath`, `detectCandidates`, `hasWebSearchCredential`, `observeClassification`, `parseMarkdown`, `piMaskFilename`, `piReportedMaskPath`, `planClassification`, `questionsFor`, `readWebSearchOverride`, `readWebSearchRouting`, `resetRtkProbe`, `resolveAskUserFormLimits`, `resolveInRepo`, `resolveWebSearchConfigPath`, `rtkAvailable`, `rtkRewriteCommand`, `showBlockInputSchema`, `thresholdOf`, `transformCandidate`, `validateExecWrapper`, `webSearchBrief`, `webSearchProvider`, `wrapUntrustedData`.
- `@schlessera/brain-ui-sdk/tool-contracts`: `ASK_USER_FORM_ANSWER_SCHEMA`, `ASK_USER_FORM_DEFAULT_LIMITS`, `ASK_USER_LIST_LIMITS`, `BARS_BLOCK_SCHEMA`, `BLOCK_CONTACT_KINDS`, `BLOCK_CONTACT_TONES`, `BLOCK_DELTA_TONES`, `BLOCK_KINDS`, `BLOCK_QUOTE_TONES`, `BLOCK_STEP_STATES`, `BLOCK_STEP_VARIANTS`, `BLOCK_TONES`, `BLOCK_VALUE_TONES`, `BRIDGE_TOOL_POSTURE`, `BridgeToolAdapter`, `COMPARISON_BLOCK_SCHEMA`, `CONTACT_BLOCK_SCHEMA`, `LINK_BLOCK_SCHEMA`, `MAP_BLOCK_SCHEMA`, `MAP_PLACE_SCHEMA`, `MapPlace`, `QUOTE_BLOCK_SCHEMA`, `RECEIPT_BLOCK_SCHEMA`, `SCHEDULE_BLOCK_SCHEMA`, `SHIPPED_SHOW_BLOCK_SCHEMA_FORM`, `STATS_BLOCK_SCHEMA`, `STEPS_BLOCK_SCHEMA`, `SUGGESTIONS_BLOCK_SCHEMA`, `SUGGESTIONS_MAX_ITEMS`, `SUGGESTION_MAX_LENGTH`, `SUGGESTION_MIN_LENGTH`, `ShowBlockSchemaForm`, `TABLE_BLOCK_SCHEMA`, `TIMELINE_BLOCK_SCHEMA`, `TRACK_BLOCK_SCHEMA`, `TREND_BLOCK_SCHEMA`, `askUserFormNodeComplete`, `askUserFormPayload`, `askUserFormSpec`, `askUserFormVisibleNodes`, `resolveAskUserFormLimits`, `showBlockInputSchema`.
- `@schlessera/brain-ui-react` (#1053): `ShareIntakeState`; the hooks keep
  their names but are typed against the shell views.
- `@schlessera/brain-ui-server`: `ActivityDigest`, `AppEnv`, `AuthRuntime`, `BackendLogFn`, `CONFIDENCE_BUCKETS`, `CONFIDENCE_BUCKET_WIDTH`, `CONFIDENCE_RETENTION_MS`, `ConfidenceBucket`, `ConfidenceReadOptions`, `ConnectionState`, `CronRunRecord`, `DIGEST_JOB_NAME`, `KeytermSettings`, `ModelDiscoveryState`, `RollupPricing`, `SPAN_OUTCOMES`, `authGuard`, `buildKeyterms`, `confidenceDistribution`, `createActivityStore`, `createActivityStream`, `createBackendRegistry`, `createUiDb`, `createWsHandlers`, `createWsUpgrade`, `generateActivityDigest`, `handleClientMessage`, `ingestSpanSink`, `isWsAuthorized`, `latestActivityDigest`, `parseSyncResult`, `pruneShareStaging`, `recordCronRun`, `resolveAuthMode`, `resolveCookiePrincipal`, `resolveTurnTarget`, `revokeAllSessions`, `seriesKey`, `severityRank`, `shareStagingRoot`, `syncActivityAttrs`, `syncMessage`, `turnIdMatches`, `writeCache`.

Moved to an internal entry (no compatibility promise):

- `@schlessera/brain/internal`: `ArchiveResult`, `BrainContext`, `FrontmatterValue`, `IngestInput`, `IngestOutcome`, `SCRATCH_DIR`, `SEARCH_SORTS`, `SearchOptions`, `SearchResponse`, `ValidationIssue`, `WriteRefusedError`, `assertScratchWritable`, `buildTaxonomy`, `estimateTokens`, `getMarkdownFiles`, `inertGeneratedText`, `initContext`, `isInScratch`, `isIsoDate`, `isWriteRefusal`, `pruneScratch`, `readDocumentPart`, `relevanceOnArchive`, `rerankSetup`, `resolveEmbeddingProvider`, `resolveWritable`, `rewriteGeneratedRegion`, `runRegistry`, `safeResolve`, `scratchName`, `splitFrontmatterBlock`, `updateDocument`, `writeFileSafely`, `writeScratchFile`.
- `@schlessera/brain-render-template/internal`: `documentTitle`, `isFullDocument`.
- `@schlessera/brain-scrape/internal`: `DEFAULT_USER_AGENT`, `Semaphore`, `hostOf`.
- `@schlessera/brain-backend-pi/internal`: `createBrainAccess`, `createBrainTools`, `createTurnContext`.
- `@schlessera/brain-ui-kit/internal`: `mapViewBounds`, `printThemeCss`.
- `@schlessera/brain-ui-sdk/internal`: `BRAIN_LOCK_KEY`, `BRIDGE_TOOL_POSTURE`, `ClassificationAnswers`, `ClassificationPlan`, `ClassificationRequest`, `EXEC_KILLER_ENV`, `EXEC_WRAPPER_ENV`, `GIT_LOCK_KEY`, `QuestionObservation`, `VERSION_PROBE_TIMEOUT_MS`, `WEB_SEARCH_FALLBACK_ON`, `WEB_SEARCH_PROVIDERS`, `WEB_SEARCH_PROVIDER_KEYS`, `applyClassification`, `bashLockKey`, `claudeMaskFilename`, `claudeReportedMaskPath`, `hasWebSearchCredential`, `observeClassification`, `piMaskFilename`, `piReportedMaskPath`, `planClassification`, `readWebSearchOverride`, `readWebSearchRouting`, `resolveWebSearchConfigPath`, `rtkRewriteCommand`, `validateExecWrapper`, `webSearchBrief`, `webSearchProvider`.
- `@schlessera/brain-ui-sdk/internal/client`: `askUserFormPayload`, `askUserFormSpec`, `defaultAsrClientRegistry`, `defaultToolRendererRegistry`, `resolveAskUserFormLimits`, `speechUiHints`.
- `@schlessera/brain-ui-server/internal`: `buildKeyterms`, `createUiDb`; and,
  from #1053, `SessionCatalog`, `createSessionCatalog`.

Moved to an internal entry by #1053:

- `@schlessera/brain/internal`: `CollectStatsOptions`, `collectStats`.
- `@schlessera/brain-geo/internal`: `MAX_ROUTE_BYTES`.
- `@schlessera/brain-render-template/internal`: `applyExportLinkPolicy`, `protectExportLinkDestinations`.
- `@schlessera/brain-ui-kit/internal`: `LIGHT_TOKENS`, `TOKENS`, `TokenName`, `canvas`.
- `@schlessera/brain-ui-sdk/internal`: `ImageMaskHandlerOptions`, `LocationHandlerOptions`, `canonicalModelId`, `describeRetry`, `execWrapperSpawnOptions`, `handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, `resolveThinkingLevel`, `wrapCommand` (from `/server`, and the three helpers from `.`, `/client` and `/protocol` too).
- `@schlessera/brain-ui-sdk/internal/client`: `ShareTargetError`, `canonicalModelId`, `createToolRendererRegistry`, `describeRetry`, `handleShareTargetRequest`, `isShareTargetRequest`, `pruneStoredShares`, `resolveThinkingLevel`.

First-party additions for the video module (#1205):
`@schlessera/brain/internal` shares `getContext`, `resolveCompletionProvider`,
`geminiCompletions` and `GEMINI_FLASH_MODEL`. They do not expand the supported
public API. The video package supports its manifest, schema and config type;
its watch implementation and CLI remain implementation details.
