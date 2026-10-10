# brain-kit Integration Contract

The machine-readable surface and deliberately supported user inputs other
systems and brain owners may depend on. The [supported-input policy](supported-inputs.md)
includes brain configuration, documented environment inputs, per-module JSON
settings and canonical module content, with field references delegated to their
owners. The TypeScript API is what the packages' ordinary entry points export,
including every type their signatures reach; `/internal` entry points are not
part of it ([package entry points](#package-entry-points)). Implementation
details outside these promises may change without notice. Contract changes require a `CONTRACT:` commit prefix and a
same-commit update of this file. How they are versioned:

- **Additive** — a new field, a new optional input, a new tool, a
  `schema_version` bump for a migration that only adds. Ships in a minor.
- **Breaking** — a field removed, renamed or retyped, or a value whose meaning
  changes. Before 1.0 it ships in a minor as well, and additionally needs the
  `breaking` label, a maintainer ruling recorded on its issue before code is
  written, and a changeset that names the break. From 1.0 it needs a major
  version bump of `@schlessera/brain-*`.

The reasoning is in [decisions/contract-versioning.md](decisions/contract-versioning.md).

## Package entry points

**Breaking pre-1.0 export curation (#534, ruled on #343 question 1).** Each
`@schlessera/brain-*` package's ordinary entry points (`.` and its documented
subpaths) export only the supported API. That API includes every type reachable
through a public signature, exported by name or not, and the documented
behavior. A member tagged `@internal` in its own JSDoc is excluded, as a
private member is.

Entry points named `/internal` (`@schlessera/brain/internal`,
`@schlessera/brain-scrape/internal`, `@schlessera/brain-render-template/internal`,
`@schlessera/brain-ui-kit/internal`, `@schlessera/brain-ui-sdk/internal`,
`@schlessera/brain-ui-sdk/internal/client`, `@schlessera/brain-ui-server/internal`,
`@schlessera/brain-geo/internal` and the two backends' `/internal`)
are first-party implementation sharing with no compatibility guarantee. Use
them only with the same lockstep version, if at all.

**Breaking pre-1.0 narrowing (#1053).** The surfaces #534 left public because
a public declaration reached them, or because their classification was
uncertain, follow a maintainer ruling per item:

- **`WsHost`** (`@schlessera/brain-ui-server`) stays public as the type of
  `BrainUiApp.wsHost`, which `createApp` constructs. Its supported members are
  the resolved configuration (`brainPath`, `askUserFormLimits`, `appName`,
  `turnTimeoutMs`, `maxConcurrentSessions`, `observability`), the backend
  `registry` and `close()`. Its connection, client-set, catalog, turn,
  activity, inbox, draft, label and classification members are `@internal`,
  as are `WsHostOptions.catalog`, `classifier`, `activity`, `inbox`,
  `toolPermissions` and `drafts`. `SessionCatalog` and `createSessionCatalog`
  move to `@schlessera/brain-ui-server/internal`: a custom session catalog is
  no longer supported.
- **ui-react's store hooks** (`useChatStore`, `useFileStore`, `useShareStore`,
  `useUIStore`, `useVoiceStore`) stay public for deployment shells, typed as
  `ShellStoreHook<View>`: a selector, plus `getState()` and `subscribe()` on
  the default root, over `ChatShellState`, `FileShellState`, `ShareShellState`,
  `UIShellState` and `VoiceShellState` (the
  [ui-react README](../packages/ui-react/README.md#store-hooks) lists their
  fields). `setState` is no longer typed. `activeChat` and `anyStreaming` take
  `ChatShellState`; `hasPendingShare` takes `ShareShellState`, and
  `ShareIntakeState` is no longer exported. The zustand state shapes
  (`ChatState`, `UIState` …) leave the surface, and so does
  `BrainUiServices.stores` (now `@internal`), which carried them.
- **Kept as documented API:** core's `repoRelativePathSchema`, for module
  config schemas ([canonical consumer configuration](#canonical-consumer-configuration));
  Claude's `MEASURED_RUNTIME`, the measured Claude Code and agent SDK pair
  ([backend guide](extending/agent-backends.md)); jobs' `runScrape`, the
  direct scrape fallback ([jobs README](../packages/module-jobs/README.md#what-a-scrape-reports)).
- **Moved to the owning package's `/internal` entry:** core `collectStats` and
  its `CollectStatsOptions` (`BrainStats` and `StatsThresholds` stay public as
  the result shape); the SDK's bridge-tool handlers (`handleAskUser`,
  `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`,
  `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`,
  `handleShowBlock`, with `ImageMaskHandlerOptions` and
  `LocationHandlerOptions`), `wrapCommand` and `execWrapperSpawnOptions` from
  `/server`; `describeRetry`, `canonicalModelId` and `resolveThinkingLevel`
  from every SDK entry (to `/internal`, and browser-safe to
  `/internal/client`); `createToolRendererRegistry` from `/client`,
  `pruneStoredShares`, `ShareTargetError`, `isShareTargetRequest` and
  `handleShareTargetRequest` from `/share-target` (to `/internal/client`;
  `registerShareTarget` and `readShareLaunchParams` stay); the kit's `TOKENS`,
  `LIGHT_TOKENS`, `canvas` and their `TokenName` key type; render-template's
  `applyExportLinkPolicy` and `protectExportLinkDestinations`; geo's
  `MAX_ROUTE_BYTES`, in the new `@schlessera/brain-geo/internal`.

**Additive: the shared backend toolkit (#1399, ruled on #1345).** What both
shipped backends need to give the host the same behavior and security posture
is public on `@schlessera/brain-ui-sdk/server`, each declaration tagged
`@experimental` until 1.0: the bridge-tool handlers (`handleAskUser`,
`handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`,
`handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`,
`handleShowBlock`, with `ImageMaskHandlerOptions` and
`LocationHandlerOptions`) and `BRIDGE_TOOL_POSTURE`; the exec wrapper
(`wrapCommand`, `validateExecWrapper`, `EXEC_WRAPPER_ENV`, `EXEC_KILLER_ENV`);
the subprocess environment filter (`filterSubprocessEnv`,
`parseSubprocessEnvExtra`, `SubprocessEnvAudience`); the lock keys
(`BRAIN_LOCK_KEY`, `bashLockKey`); `describeRetry`, `resolveThinkingLevel`,
`assertLoadedSdk`, `rtkRewriteCommand`; and the bundled
`DEFAULT_CONFIRM_BASH_PATTERNS`, whose entries may still evolve as a documented
user-visible change. Their behavior is unchanged; they leave
`@schlessera/brain-ui-sdk/internal`. Helpers only one backend, or the host and
one backend, import stay internal (`bashCommand`, `SUBPROCESS_ENV`,
`execWrapperSpawnOptions`, `GIT_LOCK_KEY`, `canonicalModelId`). The
[toolkit record](decisions/backend-authoring-toolkit.md) has the inventory.

**Additive: ui-react share and stats exports (#1382).** For shells that
assemble their own surfaces around ui-react, the `@schlessera/brain-ui-react`
root now exports the share pipeline (`shareMarkdown`, `renderBlockHtml`,
`buildDiagramShareOptions`, `inlineMermaidDiagrams`), `splitFrontmatter` with
`FrontmatterSplit`, and the `/stats` command's `runStats`. The project
website's demo uses exactly these, so it builds from the public entry instead of
from ui-react's source tree.

**Additive: `AppErrorBoundary` (#1377).** `@schlessera/brain-ui-react` exports
`AppErrorBoundary` and `AppErrorBoundaryProps` (`children`, plus a `reload`
hook for tests). A shell wraps its whole tree in it, providers included, so a
render error outside a page shows a reload screen instead of a blank app. The
page-level boundary inside `AppShell` needs nothing from the shell.

**Additive: the module-authoring entry `@schlessera/brain/module` (#1397,
ruled on #537).** The helpers a module needs to touch the brain's files the
way core does, `@experimental` until 1.0: path containment and atomic writes
(`safeResolve`, `resolveWritable`, `writeFileSafely` with
`WriteFileSafelyOptions`, `WriteRefusedError`, whose `code` is `"EEXIST"` when
a name may not be replaced); the scratch area (`SCRATCH_DIR`, `scratchName`,
`writeScratchFile`, `assertScratchWritable`, `isInScratch`, `isWriteRefusal`,
`pruneScratch` with `ScratchReport`, `ScratchRemoval` and `ScratchFailure`);
frontmatter and generated regions (`splitFrontmatterBlock`,
`rewriteGeneratedRegion`, `inertGeneratedText`); the taxonomy, corpus walk and
index registry (`buildTaxonomy`, `getMarkdownFiles`, `runRegistry` with
`RegistryRun` and `RegistryProblem`, and `ValidationIssue`); and completion
providers (`resolveCompletionProvider`, `geminiCompletions` with
`GeminiCompletionConfig`, `GEMINI_FLASH_MODEL`). `CommandContext` gains an
optional `completions`, the brain's `completions` config block as written, so
a module command resolves the configured provider instead of reading core's
process context. First-party modules import this entry and never
`@schlessera/brain/internal`. Index reads stay behind `ctx.queries` and
`@schlessera/brain/queries`. The `/internal` entry keeps the same names for
the first-party packages that still import them.

**`Overlay`, document layers and palette semantics (#1378; pre-1.0 minor).** `@schlessera/brain-ui-kit`
exports `Overlay`, `OverlayProps`, `OverlayVariant`, `OverlayCloseReason`, `z`
and `LAYERS`. The controlled primitive supplies sheet, dialog, fullscreen and
panel variants with dismissal reasons, focus management and inert background.
Its optional `surfaceRef` lets adapters reset destination scroll and focus;
non-modal titled panels expose a script-focusable destination heading. Panels
keep their header X under `closedBy="none"`; that value suppresses Escape,
native close requests and scrim taps. Sheets and dialogs remove their drawn
close control under `none`.
`BottomSheet` optionally draws a dismissal control. CommandPalette no longer
carries dialog semantics (`role="dialog"` and `aria-modal`); wrap it in
`Overlay` to supply modal semantics and focus management. It now renders a
named group; its pixels and callbacks are unchanged.

Before 1.0, the versioning rules above apply. From 1.0, removing, renaming or
retyping an ordinary export or a type its signatures reach, or changing its
documented behavior, requires a major version; additions ship in minors.
`api-report/` records every entry point's names and every public export's
signature with the types it reaches, and the packaging check holds the built
declarations to the same names. The removed and moved names, with migration
paths, are listed in [the boundary decision](decisions/public-export-boundary.md#migration).

Lineage: this is the public successor of the `INTEGRATION.md` that lived in
the private brain's `scripts` directory; shapes are unchanged unless marked.

## Explicit autonomous backend turns (#675)

The optional server-only `StartTurnRequest.autonomous` request is additive. It
contains `{ origin: "autonomous", persistence: "none", allowedTools: string[],
systemPromptAppend: string }` selected by server code. It requires the enforced
no-grant posture and synchronous `BackendBridge.checkpointPermission`. It rejects
resume, invalid mode declarations and unsupported backends before runtime work.
`BackendCapabilities.autonomous?: boolean` advertises this specific turn support;
it does not advertise containment or enable autonomous dispatch.

Ordinary requests retain their persistence and `session_info`/terminal semantics.
Autonomous requests save no SDK session/history and advertise no interactive
session. Their runtime id reaches Activity via the additive
`BackendActivityEvent` variant `autonomous_identity`, and scopes content/result
frames internally. Exactly one terminal result ends an established runtime turn;
pre-identity failures may end on a bare error. Principal revocation aborts work
visibly. No client/model wire payload selects this mode or its authority.

The Activity origin vocabulary adds `"autonomous"` for spans and run rollups.
The SDK schemas accept it, and existing origin filtering selects these runs
without including interactive or cron work. Runtime identity, usage and principal
attribution remain recorded; unknown prices retain their existing unknown meaning.
The synchronous synthetic bridge captures escalation data before no-grant denial
and aborts without parking. Durable Action transitions, reservation admission,
containment and full-system enablement remain separate gated tasks.

## Autonomous admission configuration (additive, #678)

`ServerConfig.inbox.budget?` adds `{ spendUsd: number, turns: number,
emergencySpendUsd: number, emergencyTurns: number, timeZone: string,
unpricedUsdPerToken: number }`. It remains optional for embedded configurations.
`resolveServerConfig()` supplies defaults of 5 USD, 0 operations, zero emergency
capacity, UTC and 0.01 USD per unpriced token. The six `BRAIN_UI_AUTONOMOUS_*`
environment settings and validation are specified in [the budget guide](inbox-budget.md).
Omission or zero turns cannot enable autonomous dispatch.

The cap governs new admissions against charged spend plus active conservative
reservations; observed overruns are retained. It is not a provider-enforced
invoice ceiling. One separately dispatched model-bearing operation counts one
turn. Actual billing evidence, unknown-cost charging, frozen admission days and
crash recovery follow the [async decision](decisions/async-collaboration.md#scheduling-budgets-and-evidence).
The reservation ledger is internal operational storage. Existing HTTP, wire,
SDK turn-request, CLI/MCP and content-index shapes remain unchanged; full-v1
containment and system proof still gate production dispatch.

## Interactive priority and cooperative autonomous yield (additive, #687)

`KeyedLockAcquireOptions` adds optional `priority` (`"interactive"` or
`"autonomous"`), `signal`, `onYield(key)` and `yieldAfterMs`. Ordinary callers
remain interactive; equal-priority waiters remain FIFO. Interactive waiters
precede queued autonomous work. Cancellation removes a waiting acquisition;
it never forcibly releases an executing body. `createKeyedLock()` optionally
accepts clock/timer functions for deterministic verification.

`AutonomousTurnOptions` adds optional synchronous `onYield(key)`,
`yieldAfterMs` and `completedToolCalls` (readonly `{ toolName, input }` execution
receipts). Both first-party backends notify once per turn after continuous
same-key interactive contention, checkpoint before abort, then unwind their
actual writers. Different keys do not yield. Completed receipts only restrict
replay; they confer no capability and never bypass the current authority gate.
`isCompletedAutonomousToolCall()` compares exact JSON calls independently of
object property order. A fresh attempt has no runtime transcript replay.

`ServerConfig.inbox` adds optional `maxAutonomousRuns` and `yieldAfterMs`.
`MAX_AUTONOMOUS_RUNS` defaults to two and requires a positive integer;
`BRAIN_UI_AUTONOMOUS_YIELD_AFTER_MS` defaults to 20000 and requires a positive
integer below the normal 30000 ms interactive denial bound. Interactive WS
capacity remains separately reserved. Pool admission occurs atomically with
budget reservation/claim and counts operations, including batches. Yield
preserves spent turns and observed cost, releases unused conservative reserves
after unwind, and recovers work within its existing attempt limit. Exhaustion
leaves failed work and one durable dead-letter Action. Recovery retains
checkpoint and completion receipts in the operational UI database.

These server-only additions do not enable production dispatch or change client
wire, CLI/MCP, content-index or frontmatter contracts. Cooperative unwind must
finish before the interactive wait bound; a lock is never handed to another
writer while the first body can still write. Semantically different tool inputs
are evaluated as new calls under current authority, not deduplicated effects.

## Operational recovery command (additive, #686)

The Bun-only `brain-ui-inbox` bin accepts `export` or `restore` with required
`--db <file>`, `--brain-root <directory>`, `--file <backup.json>` and optional
`--json`. Paths are explicit; there are no environment defaults.
Export protects database/sidecar/staging destinations through aliases. Restore
accepts a new database/empty staging target, or the unchanged pending target from the identical
interrupted restore. It never merges a populated target or opens `brain.db`.

With `--json`, stdout contains one JSON object and a newline:

| Outcome | Shape and exit |
| --- | --- |
| Export | `{ schema_version: 1, ok: true, command: "export", snapshot: { version: 1, checksum: string, created_at: number, recovery_point_hours: 24 } }`; exit 0. |
| Restore | `{ schema_version: 1, ok: true, command: "restore", recovered: number, resumed: boolean }`; exit 0. `recovered` counts restored claims released into bounded retry/dead-letter recovery. |
| Failure | `{ schema_version: 1, ok: false, error: { code: string } }`; exit 2 for `inbox_usage`, otherwise 1. JSON failure reports no private file paths or exception details. |

Consumers tolerate unknown error codes. Supported codes include
`inbox_snapshot_version`, `inbox_snapshot_checksum`, `inbox_snapshot_schema`,
`inbox_snapshot_relations`, `inbox_snapshot_projection`,
`inbox_snapshot_reservation`, `inbox_snapshot_staging`,
`inbox_snapshot_missing_staging`, `inbox_snapshot_changed`,
`inbox_snapshot_destination`, `inbox_restore_nonempty`, `inbox_restore_clock`,
`inbox_restore_staging_changed`, `inbox_restore_pending`,
`inbox_staging_symlink`, `inbox_staging_directory`, `inbox_staging_file`
and `inbox_operation_failed` for unclassified schema/SQLite/filesystem failures.
Without `--json`, success is human text; failures go to stderr.

The private artifact is strict format `"brain-ui-operational-backup"`, version
`1`: `{ format, version, createdAt, recoveryPointHours: 24, database:
{ data, sha256 }, directories: string[], files: [{ data, sha256, path }],
checksum }`. Times are UTC epoch milliseconds. Byte data is canonical base64;
digests are lowercase SHA-256 hex. Paths are flat files under sorted canonical
UUID staging directories, or their `.UUID.partial` directories. Directories
and files are sorted in bytewise path order.

The outer checksum hashes UTF-8 `JSON.stringify` of validated fields excluding
`checksum`, in the displayed key order; database/file byte objects use
`data, sha256`, with file `path` last. JSON whitespace and input object-key order
do not affect validation. SQLite WAL image header bytes 18/19 are normalized
to rollback mode in the copy for SQLite deserialization; live WAL is unchanged.
The complete image retains all UI state, including principal/authentication
records, Activity accounting, inbox relations and completed-call receipts.
Each staged file is included with its own digest; required references/manifests
must agree. An exact compatible SQLite schema/migration set is required.

Database publication holds a durable pending gate while staging is restored.
App/runtime startup, model claim/acquisition and compensation claims fail closed.
Active budget settlement and old-worker claim recovery commit with the gate
opening in one immediate transaction, preserving observed/conservative cost,
admission day, attempts and stable follow-up identities. Receipts restrict
replay under current authority. This neither enables production dispatch nor
promises to recover effects newer than the backup.

The [recovery guide](inbox-recovery.md) defines the 24-hour objective, atomic
export publication, sensitive-artifact handling and same-artifact crash
resumption. The host must retain a successful complete export at least every
24 hours; content Markdown remains separately backed up in Git.

## Rail acts and All commands (additive, #944)

`@schlessera/brain-ui-kit` exports `RailAct` (`icon`, `label`, optional
`name`, `effect`, `cost`, `why`, `onClick`), and `SideRailProps` gains two
optional props, `acts?: RailAct[]` and `onOpenPalette?: () => void` (D52 §1 in
[the design-kit record](decisions/design-kit.md)). Acts render as a vertical
toolbar named `Acts`, with one roving tab stop. Its accessible names append
the effect, the cost and `unavailable: {why}`. A `why` makes the act
`aria-disabled` and never invokes it. The collapsed rail omits acts that have
an effect, a cost or a `why`. `onOpenPalette` renders a button named
`All commands` with `aria-keyshortcuts="Meta+K"` in place of the passive ⌘K
cap. A rail given neither prop renders as before.

## Working sessions and the shared composer row (additive, #949)

`@schlessera/brain-ui-kit` exports `ComposerRow` (`left?`, `right?`), the row
between the message area and the composer, and `SessionStrip` (`sessions`,
`now`, optional `keyboardOpen` and `formatClock`), the row's left half (D52
§3–4 in [the design-kit record](decisions/design-kit.md)). A `WorkingSession` is
`id`, `label`, `state` (one of `WORKING_STATES`: `needs-you`, `failed`,
`unconfirmed`, `running`, `queued`, `unknown`, `cant-check`, `done`,
`cancelled`) and `onOpen`, with optional `need`, `outcome`, `queueNote`,
`reason`, `startedAt` and `endedAt`. `describeWorkingSession(session, now,
clock?)` returns the `WorkingSessionView` the strip prints: `word`, `detail`,
`tone`, `icon` and the accessible `name`. No age or clock time is printed
from a null or absent timestamp. `ListRowProps` gains four optional props,
`density?: "pill"`, `name`, `tabStop` and `onFocus`. `IconName` gains
`attention`, `stopped`, `unheard`, `working`, `unproven`, `unreachable`,
`finished` and `withdrawn`. A `ListRow` given none of the new props renders
as before.

## Runtime approval composition (additive, #1141)

`@schlessera/brain-ui-kit` extends `ApprovalCardProps` with optional
`onAlwaysAllow?: () => void`, `children?: ReactNode`, `wrapHeader?: boolean`
and `shortcuts?: { allow: string; deny: string }`. `onAlwaysAllow` offers a
remembered-grant action only when supplied; the host determines its eligibility.
`children` carries actual tool input or permission details. `wrapHeader` lets
tool names and full targets wrap in the header. `shortcuts` prints decision
hints while preserving the decision's accessible name; it installs no key
handler. Existing props and callbacks remain compatible. These additions ship
in a minor, with the public declarations recorded in `api-report/`.

## Search result cards (additive, #1138)

`SearchResultCardProps` in `@schlessera/brain-ui-kit` gains optional
`segments?: readonly {text: string; hit: boolean}[]`, `title?: string`,
`type?: string` and `active?: boolean`. Supplied segments replace the
single `before`/`highlight`/`after` snippet and preserve each matched span;
an empty array clears the snippet. Omitted segments retain the existing
single-highlight API. `active` draws the surrounding list's current
keyboard selection. Existing props and their defaults remain compatible.

The Search panel and both backend search-output renderers adopt the card.
They clear absent scores and snippets instead of using presentation defaults.
The existing search tool and HTTP result schemas are unchanged; pi's
formatted output carries no score. Incompatible, ambiguous, clipped and
failed tool output retains a readable original-text fallback. File opening
uses the current root's authenticated file viewer; unsafe paths have no
open action.

## Streaming waiting status (approved pre-1.0 break, #1144)

The maintainer-approved minor removes `StreamingAnswer`'s prototype defaults
for phase, target, elapsed time, answer text and cost. Callers supply those
facts explicitly; omitted facts draw no sample values. Only the phase word
is announced in the polite live region, while elapsed ticks and targets remain
outside it. `StreamingAnswerProps` gains optional `pulse?: boolean`; false
selects a static status dot. Hosts retaining the former sample presentation
must pass its values explicitly. The runtime uses the component for waiting
status while preserving rich thinking/tool/prose rendering and the composer's
single Stop; stream and cancellation schemas are unchanged. The minor changeset
records this approved migration, and `api-report/` records the added prop.

## Exec wrapper in app configuration (additive, #1363)

`ServerConfig` in `@schlessera/brain-ui-server` gains optional
`exec?: ExecWrapperConfig` (`{ wrapper?: string; killer?: string }`), and
`createBrainClient`'s options gain optional `exec`. `resolveServerConfig(env)`
always sets `exec` from that record's `BRAIN_UI_EXEC_WRAPPER` and
`BRAIN_UI_EXEC_KILLER`. Every brain CLI and repository-script spawn of an app
goes through its configuration's wrapper, never the process environment's, so
two apps in one process keep separate wrappers. A configuration without
`exec` keeps the process environment's wrapper, resolved once by
`createApp()`; a client built without `exec` resolves it once at construction.
Neither ever spawns unwrapped because the field is absent. A relative wrapper
path now refuses at `resolveServerConfig()` instead of failing each spawn.

## Logo assets (additive, #1424, #1425)

`@schlessera/brain-ui-kit` exports `BrandMark` (`variant?: "mark" | "lockup"`,
`size?: number`, `label?: string`), which renders the accepted logo (#1423)
inline with the theme's ink and amber tokens. Below 24px the mark uses the
small-size master; without a `label` it is `aria-hidden`, with one it is
`role="img"` with that name. No prop changes the artwork.

The new React-free `@schlessera/brain-ui-kit/brand` entry exports
`BRAND_MASTERS`, the file names of the fourteen master SVGs, and
`BRAND_ASSET_SPECIFIER`. Each listed file resolves as
`@schlessera/brain-ui-kit/brand/<file>` through the `./brand/*` export, which
maps to the published `assets/brand/` directory. A listed file's name and
presence are the promise; its bytes change only with a newly accepted design.

The entry also exports `BRAND_RASTERS`, the files rendered from those masters:
`favicon.ico` (16, 32 and 48px PNG images), `apple-touch-icon.png` (180px,
opaque), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (512px, the
mark inside the central 80% circle) and `social-card.png` (1200x630).
`WEB_APP_MANIFEST_ICONS` is a web app manifest's `icons` array over them
(`src`, `sizes`, `type: "image/png"`, `purpose: "any" | "maskable"`),
`WEB_APP_COLORS` its `theme_color` and `background_color` (`#0c1417`), and
`HTML_ICON_LINKS` the head `<link>`s (`rel`, `href`, optional `type` and
`sizes`). Every `src` and `href` is a bare brand file name.

## Logo in the empty state (additive, #1426)

`EmptyStateProps` in `@schlessera/brain-ui-kit` gains optional
`brand?: boolean`. Set, the empty state shows `BrandMark` on a plain surface
tile in place of its icon medallion; `icon` and the tone's tint are then not
drawn. An empty state without it renders as before.

## Consumers

| Consumer | Surfaces used |
|----------|---------------|
| brain-ui (`packages/ui-server/src/brain/client.ts`, `packages/ui-server/src/core-queries.ts`, `packages/ui-server/src/cron/emit.ts`) | CLI `--json` commands, the [content-index query API](#content-index-query-api) through an optional core peer (voice keyterms and the knowledge graph), file paths |
| Coding-agent sessions (MCP) | MCP server tools, CLI |
| Cron on a hosting container | `brain maintain`, module cron entries (`brain jobs scrape` …) |

## Model reranker activation

**Approved pre-1.0 breaking behavior change (#406):** judgment reranking now
requires `reranker.enabled: true` in canonical `brain.config.ts` or
`brain.config.json`. Omitted or false means off, even with credentials, a
provider, `--rerank jev`, MCP `rerank: "jev"` or `BRAIN_RERANK_MODE=jev`.
The boolean is runtime validated; provider is optional (default `jev`).
The same setting governs CLI search/context/process, MCP search/context,
eval and configured library/backend access. First-party `hybridSearch`
injection (through the unsupported `@schlessera/brain/internal` entry) also
requires `SearchDeps.rerankerEnabled: true`; provider construction through
`resolveReranker` alone does not activate it. `rerankSetup` forwards the flag.

Off uses local lifecycle `heuristic` ordering, or retrieval order for `none`.
An explicit model-mode request warns and falls back; eval refuses disabled
flag/environment requests with exit `2` and no score, including context eval.
Dry-run previews can be constructed while disabled or keyless and send
nothing. Enabled behavior retains missing-key fallback, deadlines,
cancellation, exclusions, provider-result validation and degraded warnings.
No JSON envelopes, MCP names/schemas or frontmatter fields change.

Migration: add `enabled: true` to retain former credential-triggered model
ordering. Toggling it off preserves provider/model/key-variable/exclusion and
bound fields; re-enabling reuses them. New CLI processes reload config;
running MCP/embedding hosts restart or rebuild their context from newly loaded
config (TypeScript imports require process restart). See
[configuration](configuration.md#reranker) and the
[decision](decisions/reranker-activation.md) for the retained provider seam
and measurement limits.

## Travel ownership and canonical content

**Approved pre-1.0 breaking ownership change (#566):**
`@schlessera/brain-module-speaking` contributes `talk` and `conference`;
`@schlessera/brain-module-travel` owns the existing `travel` type and
`plan-travel` skill, and adds `trip` and `place`. The
[maintainer ruling](https://github.com/schlessera/brain-kit/issues/60#issuecomment-5869107262)
requires existing content paths, type values, links and travel-party settings
to survive. Both modules retain the shared `status.md`, `itinerary.md` and
`outline.md` directory anchors; travel alone has no speaking deck exclusions.

Install and enable travel before indexing an upgraded speaking-only brain.
Run `brain travel migrate --dry-run --json`, then apply without `--dry-run`,
restart the process and sync skills. The explicit source migration moves the
complete literal `travelParty` field between the canonical package-keyed
config blocks; JSON and directly exported TS literals are supported.
Existing equal values are deduplicated, conflicting or dynamic values are
refused without writes. Content is never rewritten. Speaking temporarily
accepts deprecated `travelParty` and warns when it is nonempty. Existing
`settings/speaking.json` or `settings/travel.json` also causes refusal: #528
owns future JSON precedence and its shared writer. See the
[upgrade instructions](../packages/module-travel/README.md#upgrade-from-speaking).

Additive travel frontmatter: a `trip` has `trip_status` (`proposed`, `done`,
`dismissed`), optional routes and repeated visits; a done trip has at least
one visit. Visit identity is the owning document's root-relative `.md` path
plus its unique lowercase-slug `id`, independent of date or party. A nonempty
route list has unique labels and exactly one primary; visits name those
labels. `cover`, route GPX and visit tracks/photos resolve relative to their
document within the brain root. Places have `place_kind` (`country`, `city`,
`town`, `spot`), optional parent and coordinates, and references to canonical
visits. Country → city/town → spot ancestry must resolve without cycles.
An existing journey needs no new fields. The full
[field formats](../packages/module-travel/README.md#canonical-formats) apply.

Visit dates and coordinates stay omitted or null when unknown; `(0, 0)` is
valid. Place counts deduplicate canonical document/visit pairs, including
references from both places and journeys/trips. Stored `visit_count`,
`first_visit`, `last_visit` are display caches and never authority. Bounds
are null if any included date is unknown, and counts still include those
visits. Domain validation uses `brain travel validate`; ordinary
`brain validate` retains its common metadata and wiki-link checks. No schema
version, MCP tool, existing core envelope or database authority changes.
The [decision](decisions/travel-module.md) explains the boundary.

## Travel photo copies

**Additive CLI contract (#567):** `brain travel photo <files> --to <dir> --json`
returns `{photo: {files, errors}}`. Each file has `source: string`,
`output: string`, `width: number`, `height: number`, `bytes: number`,
`captured_at: string | null`, `location: {lat: number, lon: number} | null`, and
`date_source: "exif" | "flag" | "none"`.
`source` is the unchanged input argument; `output` is a root-relative path with
forward slashes. Dimensions and byte length describe the completed JPEG.
Each error has `{source: string, message: string}`; messages are prose.
Both arrays preserve their inputs' relative order.

Capture values come from the original EXIF before stripping. `captured_at`
contains a real calendar date/time in ISO form, with written fractional seconds
and offset retained. Without a written offset it remains local ISO text; no
timezone is inferred. Missing/invalid dates are `null`. A location requires a
finite latitude/longitude pair in −90…90 and −180…180; valid zero values survive,
and unknown/invalid pairs are `null`. No sidecar or content record is written.

Sources resolve from the brain root, or from an explicit absolute path. Their
bytes are unchanged. Outputs stay inside the brain; symlinked output directories
and destination entries are refused. Copies apply EXIF orientation to pixels,
preserve aspect ratio, cap the long edge at 1600 without upscaling, flatten
transparency on white and encode sRGB JPEG with mozjpeg quality 80. Input EXIF,
GPS, XMP, ICC, IPTC and comments are removed. Unsupported raster codecs,
vector documents and animated/multi-page images produce input errors.

Names use the source basename with `.jpg`, then `-2.jpg`, `-3.jpg`, etc.
With `--name <descriptor>`, use `<date>-<slug>.jpg`: the validated EXIF
camera calendar date wins over `--date YYYY-MM-DD`, then a valid flag supplies
the date, otherwise use `undated`. Photo-only `--force-date` makes a valid
`--date` win. Original `captured_at` remains unchanged. `date_source` describes
only the date applied to the requested name: `exif`, `flag`, or `none` for
`undated`; without `--name`, it is always `none` and valid date flags do not
rename anything. Never shift the camera date through UTC or the host timezone.

Photo and route descriptor slugs normalize the complete descriptor to NFKD,
remove Unicode combining marks, lowercase, replace runs outside ASCII
`[a-z0-9_-]` with `-`, and trim edge hyphens. This folds accents without full
transliteration or stripping extensions: `Café in Ithaca` → `cafe-in-ithaca`,
`Straße` → `stra-e`, and `Plan.v2` → `plan-v2`; Greek-only and punctuation-only
descriptors are refused if the result is empty. All supplied date flags must
be real `YYYY-MM-DD` calendar dates (years 0001–9999). Invalid dates, empty
slugs and photo `--force-date` without a valid `--date` refuse before creating
outputs, even without `--name`.

Exclusive publication of completed bytes preserves every existing destination,
including a source already in the output directory. Hard-link support is
required. Temporary cleanup failure after publication does not misreport a
completed copy as failed; a hidden sibling can remain.

Exit `0` means all inputs succeeded. Exit `2` means input failures, with the
same envelope containing any successful copies. Exit `1` means usage or
output-directory refusal before processing, with stderr and no success envelope.
`--human` displays paths/dimensions and stderr errors. `--` terminates options.
The [photo guide](../packages/module-travel/README.md#photo-copies) documents runtime
requirements. No schema version, MCP tool or existing envelope changes.

## Travel registries

**Additive CLI contract (#569):** `brain travel sync [--check] --json` returns
`{sync: {check: boolean, files: string[]}}`. It regenerates the
`travel-trips` region of `<trip dir>/_index.md` and the `travel-places` region
of `<place dir>/_index.md`, creating a missing index with core `type: index`
frontmatter. `files` lists the root-relative registries written, or with
`--check` those that would be written; `--check` writes nothing and exits `1`
when any is listed. A current brain writes nothing and reports `[]`.

Bytes outside the regions are preserved, and `updated` changes only in a file
whose region changed. Counts and bounds derive from canonical visits with the
place deduplication rules above; a country's rollup also counts the visits of
places within it, once per document/visit pair. Unknown dates and coordinates
render as `unknown`. Any `brain travel validate` error, malformed region
markers, a symlinked registry, trip and place types sharing a directory, or a
registry changed after it was read (checked before the first write) exits `1`
with stderr and no success envelope, and neither registry is written. Table layout is prose for
people, not a parsed contract. No schema version, MCP tool or existing envelope
changes.

## Asynchronous UI startup

**Approved pre-1.0 breaking API change (#286):**
`createApp(options?: CreateAppOptions): Promise<BrainUiApp>` from
`@schlessera/brain-ui-server` replaces the synchronous factory. Consumers
must `await createApp(...)` before reading the handle or passing its `fetch`
and `websocket` to `Bun.serve`. Startup refusals now reject the promise, so
catch them around the awaited call. There is no synchronous compatibility API.

The experimental `BackendModule.probeRuntime?(context: BackendModuleContext)`
from `@schlessera/brain-ui-sdk/server` now returns
`Promise<BackendRuntimeReport>`. Descriptor authors make their implementation
asynchronous and reject when their required runtime is unavailable. The
server awaits active backend probes, then the brain CLI version probe, before
opening its database or starting application services. Injecting a registry
continues to bypass first-party backend probes without explicit backend
requirements, while retaining the brain CLI check and configuration validation.

Both built-in version probes run only `--version`, with a five-second deadline
and up to 250 ms of cleanup, subject to event-loop scheduling. At the deadline
cancellation sends `SIGKILL` through `killWrapped`, including the configured
group killer while the command is running. Killer-helper execution is bounded
to 200 ms for these probes. Probe settlement never waits indefinitely for exit,
inherited output pipes or the helper; incomplete cleanup is reported as
unconfirmed, not as proof that work stopped. Turn cancellation retains its
existing behavior. Printing a version before timing out does not count as
success. Claude runtime failure refuses startup; an unknown or unreadable
brain CLI version warns and continues by default, and a known incompatible
version refuses. Version report shapes and the default CLI floor are unchanged.

**Additive host requirements (#642):** `CreateAppOptions.versionRequirements`
accepts optional `brainCli` and `backends[backendId].sdk/runtime` full SemVer
minima. They cannot weaken package constraints. Validation and requested
identity checks precede app resource creation; unsupported injected backend
verification refuses startup explicitly. An explicit content-CLI minimum
refuses unknown versions and revalidates the actual executable before client
and streaming-sync invocations. Backend minima travel through the existing
`BackendModuleContext.versionRequirements` to probes and construction. The
shared server SDK helper retains every owner/declaration, upper bounds, OR
grouping and normal per-tuple prerelease opt-in. Compatibility remains separate
from measured status and index schemas; existing wire/report meanings hold. Backend
factories also accept the optional pair and enforce owning SDK requirements
on their actual imported copies (#643). Pi's boot entry adds its primary SDK
identity without a `runtime` or `measured` field: it has no separately spawned
executable. Existing Claude report fields retain their meanings. With a Claude
runtime requirement, start/resume re-probe the SDK-selected executable and
withhold input until the bounded SDK handshake completes. A contradictory
later init version ends the turn through the existing error/result envelopes;
compatibility adds no wire fields and changes no measured verdict.

## HTML renderer budgets

**Additive option (#558):** `linkPolicy?: "visible-destinations"` shares the
concrete template policy. Omitted preserves existing renderer/CLI behavior.
Enabled retains accepted web/mail navigation with validated visible destination
text, makes refused/unavailable targets inert and checks final screen/print
visibility with document scripts disabled. A destination still obscured/clipped,
or beyond the PNG capture bound, rejects rather than emitting an unchecked
artifact. PDF checks also cover the finished annotation's own complete tagged
disclosure, physical page bounds and a 9-point legibility floor; print clipping
or shrinkage rejects. Documents with accepted links also reject if a content
security policy blocks the protective stylesheet. Existing render budgets apply.
No target is fetched by this policy.
The app's `POST /api/render` always enables it server-side for both formats,
including raw/full/bare HTML; request content cannot opt out. Its injected
`AppRenderer` implementations must honor the supplied option's final-visibility
check. The request and response envelopes are unchanged.


The deliberately public `createRenderer` API of
`@schlessera/brain-render-puppeteer` accepts `RendererOptions` and returns a
`Renderer`: `renderPng({ html, width?, linkPolicy? })` and
`renderPdf({ html, width?, linkPolicy? })`
resolve to `Buffer`; `shutdown()` is terminal. Width is clamped to
320–4096 CSS pixels. The package README documents the remaining options.
`RenderOptions`, `ENV_VARS` and `EnvVarSpec` complete the package's public
entry; see [package entry points](#package-entry-points).

**Pre-1.0 breaking behavior change (#72):** `renderTimeoutMs` now bounds page
creation, setup and PNG/PDF production, excluding queue waiting and browser
acquisition. `queueTimeoutMs` bounds waiting for a concurrency slot;
`browserTimeoutMs` bounds acquiring the shared browser, including a cold
launch. Defaults are 30_000, 60_000 and 30_000 ms respectively, so the maximum
request duration is their sum (120_000 ms), subject to event-loop scheduling.
Budgets are positive integers within the JavaScript timer range. Timeout errors
identify queue, browser acquisition or rendering; exact prose is not a machine
schema. Expired queue entries are removed and timed-out calls release capacity.
Shutdown rejects queued/new calls, drains active phases and bounds browser
closure to another 2_000 ms. It therefore completes within
`browserTimeoutMs + renderTimeoutMs + 2_000`, subject to scheduling. Default
network denial, disabled scripting and opt-in sandbox removal retain their
policy. The rationale and measurements are in
[renderer-budgets.md](decisions/renderer-budgets.md).

## CLI conventions

- Bin name: `brain` (stable). Runs under Bun.
- Output mode: JSON when stdout is not a TTY; force with `--json` / `--human`.
- Exit codes: `0` success · `1` usage error · `2` internal failure
  (`maintain` exits `2` if any step failed; `scratch clean|prune` exits `2`
  when a file could not be removed, with the JSON report still printed;
  `eval` exits `2` when a validity gate refuses the run, with nothing on
  stdout, and also on a usage error, so its `1` only ever means a failed
  `--baseline` gate; `3` is runs that are not comparable, the report still
  printed).
- Boolean flags never consume the following argument.
- End-of-options: a bare `--` stops flag parsing, and every later argument is
  positional verbatim. Output-mode and help flags after it are positional too
  (additive in 0.33.0).

### Stable `--json` shapes

| Command | Shape |
|---------|-------|
| `brain search "q" --json` | `{ "results": SearchResult[], "warnings": string[] }` — `warnings` reports degraded modes (no vectors, model mismatch, missing key, a reranker that did not run). `--rerank none\|heuristic\|jev`: `jev` added in 0.39.0, additively; unset, the configured `reranker.provider` (judgment requires `reranker.enabled: true`; otherwise local `heuristic`, or `none` when selected). `--rerank-dry-run` (0.39.0) prints the reranker's outbound request to stderr and sends nothing, even while disabled or keyless. Date filters `--updated-since`, `--updated-before`, `--deadline-from`, `--deadline-to` (`YYYY-MM-DD`, inclusive; a deadline filter drops undated docs), `--sort score\|updated\|deadline` (default `score`; `updated` newest first, `deadline` earliest first with undated docs last) and `--upcoming` (= `--deadline-from <today, UTC> --sort deadline`) added in 0.38.0, additively. Stored dates are compared as their UTC day (sorts keep full timestamp precision). A stored value counts only as an ISO `YYYY-MM-DD`, optionally followed by `T` or a space, `HH:MM`, seconds, a fraction and a `Z` or `±HH:MM` offset. Anything else, `2026-02-30` and `now` included, counts as missing: it matches no bound and sorts last. With a query, a date sort picks the results by date from a candidate pool: the full-text lane's best `max(limit × 20, 500)` documents, plus the documents behind the vector lane's nearest chunks (at most that many documents, from at most 500 chunks). An invalid date or sort is a usage error (exit `1`) |
| `brain audit --json` | `{ "issues": AuditIssue[], "errors", "warnings", "infos", "mustFix", "informational" }` — markdown documents only (assets excluded). The three severity counts are the number of issues at each severity. `mustFix` is `errors + warnings` and `informational` is `infos` (both additive in 0.40.0): severity stays the one classification, and the two totals only name its halves. Every count is of issues, not of markers. **Breaking in 0.40.0:** `todo` and `verify` issues are grouped, one per document and category (see [`AuditIssue`](#auditissue)), and `verify` is `info` instead of `warning`, so a brain with markers reports fewer issues and fewer warnings than before for the same content. With `--fix` the command prints fix suggestions instead, in a shape that is not part of this contract |
| `brain context "q" --max-tokens N` | assembled markdown context (text) |
| `brain read <path> [--section <heading>] [--max-tokens N]` | the document text; the flags behave as `brain_read`'s `section` and `max_tokens`, and an unknown section exits `1` (flags additive in 0.38.0) |
| `brain briefing` | briefing text (mechanical: deadlines, reviews due, silent edits — no LLM) |
| `brain index [--force] [--embeddings] --json` | `{ "total", "added", "updated", "deleted", "unchanged", "chunks", "embeddings", "assets", "graphMs", "graphNodes" }`, all numbers, each counting this run only. See [`brain index` counters](#brain-index-counters). Incremental by default, `--force` = full rebuild, `--incremental` accepted as no-op |
| `brain index --forget-cache <path> --json` | `{ "path", "forgotten" }` — `forgotten` is the number of sidecar lines removed for that document or asset (for an asset, every line for its bytes, whatever the title). Runs no index pass; the next `--embeddings` run regenerates what was forgotten. A path not in the index is a usage error (additive in 0.38.0) |
| `brain index --compact --json` | `{ "compacted", "before": { "live", "allocated" }, "after": { "live", "allocated" } }` — rebuilds `vec_chunks` from its live rows and runs `VACUUM`, reclaiming the slots deleted vectors leave behind; `before`/`after` have the shape of `brain stats` `size.db.vectorSlots`. `compacted` is `false` only when there is no vector table. Makes no provider call and runs no index pass (additive in 0.38.0) |
| `brain maintain --json` | `[{ "step", "result" }]` in run order: `registry`, `index`, `vectors`, `audit`, `stats`, `tags`, `git`, `scratch`. The `stats` step also carries additive `trends` (see "Recorded corpus trend verdicts"), evaluated before recording. The `stats` step (additive in 0.40.0) is `brain stats --record`: `ok — recorded <date> in .stats-history.jsonl (<n> snapshot(s) kept[, <m> older thinned])`, or `ok — replaced …` on a second run the same day. The `registry` step (additive in 0.38.0) is `brain registry`: `ok — <written> of <indexes> table(s) rewritten`, `FAILED — …` when an index's `registry:` block is invalid. `result` is a human-readable string that starts with `FAILED` when the step failed (and the exit code is `2`); the `tags` step never fails, and reports `skipped — …` instead. The `audit` step's result is `<errors> error(s), <warnings> warning(s), <infos> info(s); <mustFix> must-fix, <informational> informational`, the totals `brain audit --json` reports for the same run (the must-fix and informational part additive in 0.40.0; the counts follow the grouped `todo`/`verify` issues from 0.40.0). The `vectors` step (additive in 0.38.0) compacts the vector table the way `brain index --compact` does, only when fewer than half its slots are live and at least one internal chunk would be freed; otherwise it reports `ok — <live> of <allocated> slots live, nothing to reclaim`, and `skipped — …` when the slots cannot be read |
| `brain registry [--check] --json` | `{ "indexes", "written", "stale", "invalid": [{ "path", "error" }] }` (additive in 0.38.0). Regenerates the registry table of every `_index.md` whose frontmatter has a `registry:` block. `indexes` counts them, valid or not. `written` lists the files rewritten. `stale` lists out-of-date indexes left as they are: all of them under `--check`, which writes nothing, and otherwise one whose file changed between being read and being written (it is regenerated on the next run). `invalid` lists indexes that cannot be generated, which are left untouched: a `registry:` block that does not validate, an index or a child that cannot be read, whose frontmatter does not parse, or whose frontmatter opens and never closes (an `_index.md` whose frontmatter does not parse counts when it has a `registry:` line, quoted or not), or malformed region markers. Exit `1` under `--check` when anything is stale or invalid, `2` without it when anything is invalid, else `0` |
| `brain list --json` | `ListedDocument[]` — a bare array, newest `updated` first. Filters: `--type`, `--tag`, `--status`, `--relevance`. `--limit` is a whole number from `1` to `100`, default `20`; the whole argument must be an integer literal. Anything else (`abc`, `10abc`, `1.5`, `0`, `-1`, `101`, or `--limit` with no value) is a usage error (exit `1`, a message on stderr, nothing on stdout) in human and JSON modes, and no query runs. **Breaking in 0.41.0 (#1351):** `--limit` used to be read with `parseInt`, so `10abc` listed 10, `1.5` listed 1, `abc` was passed through as `NaN`, and values above 100 were honoured |
| `brain add "<content>" --json` | `{ "action": "created"\|"appended", "path", "title", "type", "indexed", "indexError"? }` — `path` is repo-relative. `indexed` is `false` when the file was written but the reindex after it failed, and `indexError` (a string) is present only then. `appended` means the content went under a new dated heading in an existing document of the same title and type. `--smart` hands the capture to the coding agent and prints its text instead |
| `brain sync` | `{ run, agent }` in machine mode (`--json`, or stdout not a TTY); its text report in human mode (`--human`, or a terminal). With no verb, `sync` runs `brain sync run`. When an agent runner is configured and the run needs one (a conflict no strategy merges, an `UNKNOWN` leftover, or a `MEDIA`/`LARGE` leftover with a terminal attached), it then runs the `/sync` skill and exits `0`. Without an agent runner the exit code is `run`'s: `0` complete, `1` failed, `3` something left for judgment: a conflict no strategy merges (left in progress, nothing pushed) or a file holding conflict markers (left uncommitted, never pushed). An agent run that fails exits `2`, its error on stderr. **Machine mode** prints exactly one JSON document on stdout, whatever the agent did, and nothing else: no report, no progress, no agent text beside it. `run` is the envelope `brain sync run --json` prints (its `status` and `report` are contract; its other fields drive the `/sync` skill and are not). `agent` is `{ invoked: false, reason: "not-needed" \| "no-runner" }` — `no-runner` when the run needed an agent and none was available — or `{ invoked: true, runner: string, outcome: "success" \| "failed", runtime: { name: string, version: string \| null } \| null, text: string \| null, error?: string }`. `runtime` is what that agent run reported about itself while it ran, never probed and never taken from another run: `null` when it reported nothing (a runner that does not report, or a run that ended first), `version: null` when it named itself without a version. The built-in `claude` runner reports `{ name: "claude-code", version }` from the Claude Code session's `system`/`init` event (`claude_code_version`), the field chat records as `runtime_observed`. A failed agent run still prints the result, with `outcome: "failed"`, `text: null`, `error`, and any runtime it reported before failing. Not invoking an agent says nothing about model cost: the sync judge and enrichment can call a model without one. **Human mode** prints the report, then the agent's final text when it ran, with tool progress on stderr. **Breaking in 0.40.0 (#290):** bare `sync` printed its text report in every output mode, so a caller that read stdout as text passes `--human`, or reads `run.report` and `agent.text`. **Breaking in 0.39.0:** it used to run the agent unconditionally, print only the agent's text, and exit `1` when no agent runner was available. The verb is the first positional argument, so output-mode flags may come before it: `brain sync --json` is still the bare form, and `brain sync --json assess` is `assess --json`. An unknown flag exits `1` (`Unknown flag: --x`). The mechanical verbs (`run`, `assess`, `group`, `commit`, `stash`, `pull`, `resolve`, `conflicts`, `conclude`, `push`, `post-sync`) follow the usual output mode — JSON when stdout is not a TTY or with `--json`, otherwise command-specific human-readable text — and their shapes, which exist for the `/sync` skill to drive, are not part of this contract |
| `brain module list --json` | `{ "enabled": [{ "name", "key", "description", "types", "commands", "tools": string[], "cron": [{ "name", "schedule", "command" }], "state": "active" \| "dormant", "contextTokens": number }], "available": [{ "key", "description", "enabled": false }] }` — Existing fields and envelope are retained. The historical `enabled` array includes every configured module, even dormant ones. `key` is the module's `brain.config` key. `types` and `commands` are its declared type names and CLI words; `tools` stays the declared canonical names. `description` is from package.json, or null. `available` lists declared packages absent from config. `cron` is shape-constrained and empty for dormant modules. `contextTokens` is a nonnegative integer active-context estimate (see Module dormancy below). |
| `brain module enable <name> --json` / `disable <name> --json` | `{ "module": string, "state": "active" \| "dormant", "changed": boolean, "context": { "entered": string[], "left": string[] } }` — Toggle a configured manifest name, preserving domain config and documents. Synchronize managed skills and owned instruction regions. Unchanged repeated commands return changed:false. Errors use the existing nonzero-exit/stderr convention. |
| `brain --version` | text: the core package's SemVer version and a newline, nothing else (`0.37.0`). `-v` is the same. Only as the first argument |
| `brain doctor --json` | `{ "checks": [{ "id", "status": "pass"\|"warn"\|"fail", "detail", "fix"? }] }` (new in brain-kit). Check ids other than `instructions-weight` are not part of this contract, and `detail` is prose. `instructions-weight` (added in 0.38.0, additively) estimates the tokens always loaded into a session (`CLAUDE.md` with its in-brain `@` imports, `AGENTS.md`, model-invocable skill descriptions), and is `warn` above the optional `brain.config` key `instructions.maxTokens` (default `8000`) |
| `brain init --check` | `{ "bun": { "version", "ok" }, "git": { "repo" }, "hooksPath": { "set", "value" }, "config": { "exists", "valid", "initialized", "path", "error"? }, "contentDirs": { "present", "missing" }, "keys": { "GEMINI_API_KEY", "ANTHROPIC_API_KEY" } }` (new in brain-kit). `bun.version` is `null` when not running under Bun. `git.repo` says whether the root is inside a git work tree. `hooksPath.value` is git's `core.hooksPath`, `null` when unset. `config.path` is `null` when there is no config, and `error` is present only when the config failed to load (`valid: false`). `initialized` is true only when the config declares something (profile, taxonomy, modules, embeddings), so a brain holding the template's empty starter config reads as `exists: true, initialized: false` (added in 0.37.0). `contentDirs` splits the core types' directories into those that exist and those that do not. Each `keys` entry is a boolean — whether that variable is set — never the key |
| `brain okf export --json` | `{ "outDir", "filesExported", "assetsCopied", "linksConverted", "linksDegraded", "degradedLinks", "indexFilesGenerated", "topLevelDirectories", "warnings" }` |
| `brain okf check [dir] --json` | `{ "directory", "ok", "filesChecked", "errors", "warnings", "issues": [{ "severity", "path", "message" }] }`; exit 1 when `errors > 0` |
| `brain scratch clean\|prune --json` | `{ "action": "clean"\|"prune", "removed": [{ "path", "bytes", "reason": "age"\|"size"\|"clean" }], "failed": [{ "path", "reason" }], "bytes", "files" }` — `path` is repo-relative; `failed` lists files the OS refused to remove (they are still there, and the exit code is `2`); `bytes` and `files` are what is left in the scratch area afterwards, those included (additive in 0.38.0) |
| `brain graph stats --json` | `{ "computedAt", "root", "nodes", "edges", "brokenLinks", "components", "reachable", "layoutSkipped", "algo", "communities" }` |
| `brain graph compute [--root <path>] --json` | `{ "nodes", "edges", "brokenLinks", "components", "communities", "root", "reachable", "layoutSkipped", "durationMs" }` |
| `brain graph export --mode clusters\|discovery\|local\|maintenance --json` | `{ "nodes", "edges", "truncated" }`, except `maintenance` → `{ "staleDays", "root", "orphans", "unreachable", "brokenLinks", "stale" }` |
| `brain stats --json` | `{ "documents", "byType", "byStatus", "byRelevance", "tags", "links", "brokenLinks", "chunks", "embeddings", "health", "size", "trends" }` — `trends` added in 0.40.0 (see "Recorded corpus trend verdicts"). `health` and `size` added in 0.37.0, additively. **Breaking in 0.37.0:** `embeddings` is retyped from `number` to `number \| null` — `null` when a vector table exists but could not be counted, `0` when there is none. It also changed value: it reports the real vector count on an embedded brain, where before it read `0` on every brain. Every other earlier field keeps its name and type |
| `brain stats --history --json` | `{ "dates", "recordedAt", "versions", "documents", "tags", "links", "brokenLinks", "chunks", "embeddings", "byType", "byStatus", "byRelevance", "health", "size", "trends" }` — `trends` is the core-owned comparison over the full recorded history; `--since` filters the arrays only. The snapshots `.stats-history.jsonl` holds, oldest first, as one array per field (additive in 0.40.0). `--since <YYYY-MM-DD>` keeps the ones on and after that day. See "Stats history" below |
| `brain eval [--set <file>] [--mode fts\|vector\|hybrid\|all] --json` | `{ "schema_version", "meta", "rows", "per_query", "warnings" }` — retrieval scores for a query set against this brain's index (additive in 0.38.0). See [`brain eval --json`](#brain-eval---json). Exit `2`, with nothing on stdout, when a validity gate refuses the run. With `--lint` (additive in 0.38.0): `{ "schema_version", "meta": { "set", "set_sha256", "queries" }, "warnings" }`, where `warnings` lists `paraphrase` queries that share a content word with an expected document's title. It does not score, never opens `brain.db`, exits `0` with or without findings, and exits `2` naming the line on a malformed set |
| `brain tags --json` | `{ "tags", "documents", "variantGroups": [{ "canonical", "members": [{ "tag", "count" }] }], "redundant": [{ "path", "tag", "repeats": "type"\|"directory" }], "aliasHits": [{ "path", "tag", "canonical" }], "outOfVocabulary": [{ "tag", "count" }] \| null }` (additive in 0.38.0). Read-only. `tags` counts distinct tags and `documents` the markdown documents carrying one, both read from frontmatter, not the index. `members` is never empty, most used first, and includes `canonical`. `redundant` is `[]` under `taxonomy.tags.redundant: "off"`. `outOfVocabulary` is `null` when no `taxonomy.tags.vocabulary` is set, most used first otherwise. `path` is repo-relative |
| `brain tags --apply [--dry-run] [--only <old>] [--groups] [--redundant] --json` | `{ "files": [{ "path", "from": string[], "to": string[] }], "skipped": [{ "path", "reason" }], "warnings": string[] }`. `files` lists every document whose tags changed (or would, under `--dry-run`), in path order. `skipped` lists documents left alone: frontmatter that does not parse, a `tags:` entry the rewrite does not edit, a tag on an alias cycle, a file edited while the command ran (`"changed during apply"`), or a rewrite that would not read back as the planned tags. A `reason` starting `failed:` is a read or write error; the run goes on, and the command exits `2` after indexing and accepting the files it did rewrite. An index that cannot be opened stops the run before any file is rewritten: `files` is empty, `warnings` says why, and the exit code is `2`. Only the `tags:` entries change, on the raw text. `updated` is not bumped. The touched files are reindexed, and a file's mtime is accepted only when the index read exactly the bytes the rewrite wrote; `warnings` names each one that was not. Explicit aliases take precedence over variant groups, and a second run reports no `files`. `reason` and `warnings` are prose (additive in 0.38.0) |
| `brain hygiene reconcile [--extra <file.json>] [--fixed <file.json>] [--dry-run] --json` | `{ "opened", "reopened", "resolved", "stillOpen", "snoozed", "changedFiles": string[], "detected": [{ "id", "category", "path", "message" }], "autoFixed", "failedChecks": string[] }`. The counts are this run's transitions: `opened` new issues, `reopened` issues back from resolved or an expired snooze, `resolved` issues no longer detected, `stillOpen` open issues still detected (or kept open while a check could not run), and `snoozed` the entries left snoozed. `changedFiles` lists the files under `context/hygiene/` written (or, with `--dry-run`, that would be); it is empty on a run that changes nothing. `detected` is every issue found this run, with its stable ID `{category}-{shortpath}-{hash4}` (hash4: SHA-1 over `{category}\|{path}\|{evidence}`). `--extra` is a JSON array of `{ "category", "path", "evidence", "message" }`, and `--fixed` a JSON array of `{ "path", "fix" }`, the auto-fixes to record in `last-run.md` (`autoFixed` counts them); a malformed one exits `1` and writes nothing. `failedChecks` names each check that could not run: a module whose hygiene check threw, or a core check that could not read its input (`fact-drift`, `tag-noise`); while any is named, no entry is resolved unless it was detected again. `--dry-run` writes no log file (the index is still refreshed). A log file that cannot be parsed safely (broken frontmatter, a section mixing entries with other text), or that changes while the command runs, exits `2` without writing it (a save in the instant between the last check and the rename can still be lost; there is no lock) (additive in 0.38.0). Additive in 0.41.0 (#1024): detection also runs `brain validate`'s corpus checks (`validation` in `failedChecks` when they cannot run), and candidates with one ID are one finding. Each `detected` item adds `"severity": "error"\|"warning"\|"info"\|null`, `"urgency": string\|null`, `"sources": [{ "source", "name", "severity" }]` (never empty) and `"fingerprint"` (12 hex digits). The envelope adds `"dismissed"` (entries left dismissed), `"invalidated"` (dispositions whose evidence changed this run) and `"invalidations": [{ "id", "disposition": "dismissed"\|"snoozed", "dispositionOn", "changed": string[], "previousId" }]`. `--extra` items may add `"severity"` and `"urgency"` (lowercase letters, digits and `-`). See [Hygiene review data](#hygiene-review-data-additive-1024) |
| `brain hygiene next [--extra <file.json>] --json` | Reconcile + validation join, then one highest-priority eligible canonical finding: `{ "finding": object\|null, "counts": { "eligibleRemaining", "fixed", "dismissed", "snoozed", "nextSnoozeDueAt", "informationalNotShown" } }`. Exit `0` includes an empty backlog. Invalid configuration exits `1` with `{ "blocker": { "kind": "configuration", "message", "path", "line", "column" } }` before indexing or hygiene writes. Other unavailable checks exit `1` with `{ "blocker": { "kind": "checks", "failedChecks": string[] } }`. See [Hygiene selection](#hygiene-selection-additive-1026) (additive in 0.41.0) |
| `brain hygiene list [--state open\|snoozed\|dismissed\|resolved] --json` | `{ "entries": [{ "id", "state": "open"\|"snoozed"\|"dismissed"\|"resolved", "path", "issue", "firstSeen", "lastSeen", "until", "dueAt", "resolvedBy", "resolvedOn", "sources", "severity", "fingerprint", "disposition", "invalidation" }] }`, the log as the files hold it; a field the entry does not carry is `null` (additive in 0.38.0). Additive in 0.41.0 (#1024): the `dismissed` state, `dueAt` (the instant a snooze is due, ISO), `sources` (`[]` for an entry written before sources were recorded), `severity`, `fingerprint` (as last detected), `disposition` `{ "kind": "dismissed"\|"snoozed", "on", "reason", "fingerprint" }` and `invalidation` `{ "on", "disposition", "dispositionOn", "changed": string[], "previousId" }`. `until` keeps its meaning: the snooze's day, `YYYY-MM-DD` |
| `brain hygiene dismiss <id> --expect-fingerprint <fp> [--reason <text>] [--extra <file.json>] --json` | `{ "status": "dismissed", "id", "fingerprint", "until": null, "reason", "changedFiles" }`. Reconciles, then moves the finding to `context/hygiene/dismissed.md` with the date and the fingerprint it applies to; it stays out of review until its evidence fingerprint changes. Refused with exit `1` and nothing written when the finding is not detected now or its fingerprint is not `<fp>`: `{ "status": "refused", "reason": "not-detected"\|"stale-fingerprint", "id", "expectedFingerprint", "currentFingerprint" }`. A finding reported through `reconcile --extra` is detected only when the same `--extra` file is given. A malformed argument exits `1` as a usage error (additive in 0.41.0) |
| `brain hygiene snooze <id> --until <date\|date-time> --expect-fingerprint <fp> [--reason <text>] [--extra <file.json>] --json` | As `dismiss`, with `"status": "snoozed"` and `"until"` as given, into `context/hygiene/snoozed.md`. `--until` is an ISO date (due at the start of that UTC day) or a date-time with `Z` or an offset (due at that instant), and must be in the future. The finding returns when due, or before then as soon as its fingerprint changes (additive in 0.41.0) |
| `brain travel validate --json` | `{ "validation": { "valid": boolean, "files": number, "issues": [{ "file", "level": "error", "message" }] } }` — read-only canonical format, reference and asset checks. `files` counts successfully parsed travel/trip/place documents. Exit `0` when valid, `1` on domain errors. File paths are root-relative; messages are prose |
| `brain travel migrate [--dry-run] --json` | `{ "migration": { "path", "changed": boolean, "dry_run": boolean } }` — `path` is `brain.config.ts` or `brain.config.json`; `changed` reports the proposed edit even during dry run. Reapplication reports false without a write. Refusals exit `1` with actionable stderr and no success envelope |
| `brain travel photo <files> --to <dir> [--name <descriptor>] [--date YYYY-MM-DD] [--force-date] --json` | `{ "photo": { "files": [{ "source", "output", "width", "height", "bytes", "captured_at": string \| null, "location": { "lat", "lon" } \| null, "date_source": "exif" \| "flag" \| "none" }], "errors": [{ "source", "message" }] } }` — [photo and naming contract](#travel-photo-copies); exit `0` for complete success, `2` for input failures, `1` for usage/output-directory refusal without an envelope |
| `brain travel route <url\|file> --to <dir> [--name <label>] [--date YYYY-MM-DD] [--trim-start-m N] [--trim-end-m N] --json` | `{ "route": { "source_kind": "local_gpx" \| "gpx_url" \| "komoot_tour" \| "komoot_smarttour", "gpx": string, "date_source": "flag" \| "none", "distance_km": number, "ascent_m": number \| null, "altitude_min_m": number \| null, "altitude_max_m": number \| null, "shape": "loop" \| "one_way" \| "unknown", "recorded_duration_s": number \| null, "points": number, "segments": number, "trim": { "start_m": number, "end_m": number }, "warnings": string[] } }` — With `--name`, the stem is `[<date>-]<slug(label)>`; dates come only from a valid flag, never GPX timestamps. `date_source` is `flag` only when that date is applied to a requested name, otherwise `none`. Without `--name`, legacy names stay unchanged. Naming validation follows the [photo rules](#travel-photo-copies). `gpx` is the new root-relative asset path. All metrics describe serialized retained geometry. Nonnegative cuts use metres, with a 1 mm minimum for a nonzero cut. Missing elevations/timestamps stay `null`; segment gaps are excluded. Exit `0` after creating a new file, `1` with stderr and no success envelope on refusal. Existing outputs and sources are preserved. Outdooractive URLs currently refuse pending written site permission (#568). [Metric and trimming semantics](../packages/module-travel/README.md#route-import) are part of this contract; warnings are prose |
| `brain travel sync [--check] --json` | `{ "sync": { "check": boolean, "files": string[] } }` — regenerates the trip and place registry regions; `files` are the root-relative registries written (or stale, with `--check`). Exit `0` when written or current, `1` for `--check` with stale registries, and `1` with stderr and no envelope when a canonical record is invalid or a region is malformed; nothing is written then. [Registry contract](#travel-registries) |
| `brain jobs scrape --json` | `{ "report": ScrapeReport }` — a module command, listed here because a hosting container runs it on a schedule (see Consumers). `sources[].status` added in 0.37.0 |

The nullable tag declaration correction (#702) is an approved pre-1.0
breaking minor: `SearchResult.tags` is `string | null`, and
`RerankCandidate.tags` is optional `string | null` (other sources may omit it).
TypeScript clients and external rerankers must handle null before using
string methods; for text display, use `result.tags ?? ""` locally. Runtime
CLI/MCP/HTTP values, injected reranker inputs and built-in Jev requests retain
their existing behavior. See [provider migration](extending/rerankers.md#nullable-tags-migration).

`SearchResult` fields: `path`, `title`, `type`, `snippet`, `score`,
`tags` (comma-separated string or `null` when no tags),
`status`, `relevance`, `updated` (`YYYY-MM-DD`), `summary` (string or
`null`), `deadline` (`YYYY-MM-DD` or `null`; additive in 0.38.0),
`generatedFrom` (the document's `generated_from`, string or `null`; additive in
0.38.0), `supersededBy` (present only on a document another one
`supersedes`: that document's path; additive in 0.38.0), plus ranking
metadata. With `brain search --chunks` (additive in 0.38.0), each result also
carries `chunks`: its indexed chunks that match the query as the full-text
lane reads it (the same tokenizer, `search.language` and stopwords), best
first, as `{ "path", "chunk_index", "heading", "content", "score" }`. `heading`
is the section the chunk comes from (`(intro)` before the first, `Section
(cont.)` and `Section › Sub` for the pieces of a long one); `score` is the
chunk's BM25 relevance (heading weighted 2, content 1), higher is better. A
result with no such chunk, every result of a filter-only search or of a query
with no word in it, and every result on an index from before schema 12 have an
empty list. If chunk matching fails, the results stand with empty lists and
`warnings` says so, as for a failed search lane. Without `--chunks` there is
no `chunks` key. Treat unknown fields as
additive; never rely on field order.

`ListedDocument` fields: `path`, `title`, `type`, `relevance`, `status` and
`updated` (strings); `summary` (string or `null`); `deadline` (`YYYY-MM-DD`,
or `null` when the frontmatter sets none; additive in 0.38.0); `tags` (the document's tags
joined with `", "`, or `null` when it has none — a string, not an array);
`score` (always `0`, since a filter has nothing to rank) and `snippet` (always
`""`).

#### `AuditIssue`

`AuditIssue` fields: `path`, a repo-relative document path or a
parenthesised sentinel for an issue that belongs to no one file — `"(corpus)"`
for the corpus-wide `tag-noise` check, `"(module)"` for a failing module check
— so a consumer must not open a `path` that starts with `(`; `severity`, one of `"error"`,
`"warning"`, `"info"`; `category`, a string naming the check; `message`; and
`suggestion`, a string present only when the check has one. Three optional
fields are additive in 0.40.0, each present only on the categories named:
`count` (a number) and `examples` (strings) on `todo` and `verify`, and
`target` (a string, the wiki-link target as written) on `broken-link`. Core
categories are `staleness`, `propagation`, `index-lag`, `stale-draft`,
`tag-noise`, `todo`, `verify`, `type-mismatch`, `orphan`, added in 0.38.0
additively, `budget`, `review-overdue`, `past-date`, `fact-drift`,
`repeated-text`, `index-stale` and `duplicate-title`, and added in 0.40.0
additively, `broken-link`.

`todo` and `verify` are one issue per document and category, both `info`
(**breaking in 0.40.0**: they were one issue per marker, and `verify` was a
`warning`; the maintainer ruling is on
[#394](https://github.com/schlessera/brain-kit/issues/394), the reasoning in
[decisions/audit-markers.md](decisions/audit-markers.md)). A marker is a
`[TODO: …]` or `[VERIFY: …]` span in the body, as before. `count` is the
number of markers of that kind in the document, and `examples` the first
three of them, in source order, each as written. A document with both kinds
has two issues. `message` is `<n> TODO marker(s): <examples>` (with `, the
first 3` after the count when there are more than three), and the same for
`VERIFY`. A document whose frontmatter declares `verification: unverified` has
exactly one `verify` issue, markers or not: its `message` starts `Declared
verification: unverified`, followed by `; ` and the marker summary when it also
has inline markers, and its `count` is the number of inline markers, `0` when
it has none. A document that does not declare it is judged by its markers
alone; the absence of the declaration never means verified. Migration: a
consumer that counted `todo` or `verify` issues to count markers should sum
`count` instead, and one that treated a `verify` issue as must-fix should read
it as informational.

`broken-link` is a wiki-link in a document's body that resolves to nothing,
one `warning` per source document and target, with the target in `target`
and a `message` worded exactly as `brain validate` words the same link
(`Unresolved wiki-link: [[x]]`, or `Ambiguous wiki-link: …` when the name
matches several documents and none is a same-directory sibling). Resolution
is the indexer's own, the one `brain validate` uses: path suffixes,
basenames, same-directory disambiguation, directory anchors, `[[target#heading]]`
and `[[target|label]]`, then `aliases`. So a link `brain validate` accepts is
never a `broken-link`, and on a current index the issues are the rows
`brain stats` counts as `brokenLinks`.

`duplicate-title` is a non-archived
markdown document whose exact title another non-archived one shares, one
`info` issue on each, with the others' paths in `message`.
`fact-drift` is a document that restates a keyed fact (`taxonomy.facts`) with a value other than
the one in its source's `facts:` frontmatter, one issue per document per fact,
`warning`, with `message: "<key>: found <x>, canonical <y>"`; the source is
never reported, nor a document that lists the key in `facts_ignore`. `repeated-text` is a
top-level paragraph of at least 200 characters (whitespace collapsed; code, a
list, a quote or a heading is not a paragraph) that at least 5 documents
carry, one `info` issue per paragraph with `path: "(corpus)"`, the document
count, the first three paths and the paragraph's first 80 characters in
`message`. `index-stale` is an `_index.md` with a `registry:` block whose
generated table no longer matches its children (or whose block is invalid),
`warning`; such an index is never reported as `index-lag`. `budget` is a canonical document
over its `taxonomy.canonicalPolicy.<key>.maxTokens`. `review-overdue` is a
passed `next_review` (strictly before today; a review due today is not
overdue), or a lapsed `canonicalPolicy.<key>.reviewDays` cadence, never on an
archived document, and one issue per document.
`past-date` is a line in a canonical document with a policy that names an
earlier `YYYY-MM-DD` day, with the line number in `message`. All three are
`warning`. `taxonomy.canonicalPolicy` is an optional `brain.config` key,
defaulting to `{ currentFocus: { maxTokens: 1000 } }`. Modules add their own, and a failing
module check reports as `module-hygiene` with `path: "(module)"`, so treat the
set as open.

#### `brain eval --json`

Added in 0.38.0. The query-set format and how to read the numbers are in
[evaluating-search.md](evaluating-search.md).

The values below illustrate the envelope. Actual fixture ranks are recorded
in `packages/core/fixtures/corpus/evals/expected-ranks.json`.

```jsonc
{
  "schema_version": 1,           // bumped when a field below changes meaning
  "meta": {
    "version": "0.38.0",         // the installed @schlessera/brain
    "source": null,              // the core package's directory when it runs
                                 // from a checkout; null when installed
    "set": "evals/retrieval.jsonl", // brain-relative when inside the root
    "set_sha256": "1dcc…",       // of the set file's bytes
    "queries": 27,
    "documents": 25,             // rows in the index, assets included
    "embedding_model": null,     // the provider id when a vector lane ran
    "modes": ["fts"],            // --mode all → ["fts", "vector", "hybrid"]
    "rerank": "heuristic",
    "reranker": null,            // the judgment reranker's id with its pinned
                                 // model ("jev:jev-1.13.0") when rerank is jev
                                 // (additive in 0.39.0)
    "k": [1, 3, 10],
    "pool": 20,                  // results fetched per query: max(20, k)
    "now": "2026-07-12T09:00:00.000Z" // the instant recency and selectors were
                                 // measured from: the set header's now, else
                                 // --now, else the wall clock
  },
  "rows": [
    // Per mode: one overall row over the answerable queries (class null),
    // then one row per class in the set's first-seen order.
    { "mode": "fts", "class": null, "n": 26,
      "hit_at": { "1": 0.73, "3": 0.88, "10": 0.96 },  // keyed by each k
      "mrr_at_10": 0.81,
      "oracle": 0.96,            // share with an expected path in the pool
      "top1_score_median": 3.84,
      "current_first": 0.5 },    // share of the row's queries with `stale` paths
                                 // that rank the current one first; null when
                                 // none has any (additive in 0.38.0)
    // A no-answer class is never scored: hit_at, mrr_at_10, oracle and
    // current_first are null.
    { "mode": "fts", "class": "no-answer", "n": 1,
      "hit_at": null, "mrr_at_10": null, "oracle": null, "top1_score_median": 1.37,
      "current_first": null }
  ],
  "per_query": [
    { "mode": "fts", "id": "calypso-guide", "class": "alias", "q": "the Calypso guide",
      "expected": ["studies/star-bearings.md"],
      "rank": 2,                 // of the first expected path in the pool; null when absent
      "hit_at": { "1": false, "3": true, "10": true },  // null for no-answer
      "rr": 0.5,                 // 1/rank, 0 below rank 10; null for no-answer
      "top1_score": 4.02,        // null when the search returned nothing
      "top": ["studies/navigation/overview.md", "studies/star-bearings.md"],  // up to max(k) paths
      "current_first": null }    // with `stale`: the first expected path ranks above
                                 // every stale one, or no stale path is in the top
                                 // max(k); null without `stale` (additive in 0.38.0)
  ],
  "warnings": []                 // findings that do not refuse the run
}
```

Every `row` carries the same eight keys and every `per_query` entry the same
eleven; a consumer must treat an unknown additional key as additive. `hit_at`
keys are the `--k` values as strings. A query set of only `no-answer` queries
has no overall row.

The command refuses, exiting `2` with the reason on stderr and nothing on
stdout or in `--out`, when the set is missing or empty, an expected or `stale`
path is outside the brain (symlinks followed), not a file, or not in the index,
a selector selects no document, the index is older than the markdown on disk or
an indexed file cannot be read to tell, or a requested lane degraded (any
`warnings` from the search, such as `--mode vector` with no embedding
provider). Usage errors exit `2` as well under `brain eval` (every other
command keeps `1`), so `1` only ever means a failed `--baseline` gate: a
malformed set line (named by number), a value option given no value, a `--k`
cutoff above 1000, an `--now` that is not an ISO date, and an `--out` outside
the brain, which is refused before any search runs. `--set` and `--out` resolve against the brain root.

The query-set format (additive in 0.38.0): the optional first-line header
takes `now` (an ISO date or timestamp), and no other key. A query gives either
`expected` or `expect.select`, a selector `{ type?, field, after? | before?,
order, take }` over frontmatter dates, whose resolved paths are printed as that
query's `expected` in `per_query`; it considers only documents the indexer
indexes (with `title` and `type`) and real calendar dates, and a `now` or bound
naming a day that does not exist is refused. An optional `stale` list of paths feeds
`current_first`. When the header sets `now` and `--now` differs, the header
wins and `warnings` says the flag was ignored.

`warnings` names each indexed document that contains the set's queries, as
`contamination: <path> contains the text of <n> of the set's queries (<ids>)`,
when it contains one query of four or more words or three queries of any
length, not counting queries that list that document among their expected
answers; a query matches as whole words, ignoring case and collapsing
whitespace, in the same bytes the freshness check read. With `--strict`, such
a document refuses the run (exit `2`) instead (additive in 0.38.0).

With `--context [--budgets 1000,4000,8000]` the envelope gains a `context`
block (additive in 0.38.0); every other key is unchanged. Each query runs
through the assembler `brain context` uses, at each budget, with the run's
`now`:

```jsonc
"context": {
  "budgets": [1000, 4000, 8000],
  "rows": [                       // one per budget
    { "budget": 1000,
      "n": 26,                    // answerable queries, the denominator below
      "answer_present": 0.81,     // null when n is 0
      "budget_used": { "median": 0.97, "p10": 0.9, "p90": 0.99 } }  // nearest rank over all
                                  // queries; an even sample's median is the lower middle value
  ],
  "per_query": [                  // one per query and budget
    { "budget": 1000, "id": "calypso-guide", "class": "alias",
      "answer_present": true,     // null for a no-answer query
      "budget_used": 0.97,        // the assembler's estimateTokens(output) / budget
      "sections": { "identity": 1, "focus": 1, "results": 5, "related": 3 } }  // related: documents listed
  ]
}
```

`answer_present` is true when an expected path is one the assembler reports it
included as a search hit, or as the source of the identity or current-focus
section. The assembler reports its own sections, so text inside a document (a
quoted heading, a fenced example) never counts. A document in the `### Related`
list does not count either: only its summary line is there. A query's optional `answer` string makes it look for that text
instead, ignoring case and whitespace; a `no-answer` query may not carry one.
`--budgets` without `--context` is a usage error. Search warnings from the
assembler (a keyless brain has no vector lane) are reported once each in
`warnings`, prefixed `context: `, and never refuse the run.

`--baseline <file>` compares the run, query by query, against a stored one (a
`--json` envelope written with `--out`), and adds a `baseline` block (additive
in 0.38.0):

```jsonc
"baseline": {
  "file": "evals/baseline.json",   // null under --redact
  "version": "0.38.0",             // the version the baseline was recorded with
  "comparable": true,
  "not_comparable": [],            // why not, when comparable is false
  "only_in_baseline": [],          // query IDs one run lacks (--allow-set-change)
  "only_in_run": [],
  "modes": [
    { "mode": "fts",
      "hit_at": { "1": { "lost": ["knee"], "gained": [], "unchanged": 25, "sign_test_p": 1 } },  // per k
      "per_class": [ { "class": "exact", "hit_at": { "1": { "lost": ["knee"], "gained": [], "unchanged": 4 } } } ] }
  ],
  "gate": { "max_net_loss": 2, "must_pass": [], "failed": false, "reasons": [] }
}
```

`lost` and `gained` list query IDs that hit at k in one run and not the other;
a no-answer query is never compared. `sign_test_p` is the exact two-sided sign
test over the discordant queries, reported for information only. The gate
fails (exit `1`) when lost minus gained on hit@1 reaches `--max-net-loss`
(default 2) in any mode, or when a query in a `--must-pass` class (comma
separated) is lost. The runs are not comparable (exit `3`) when their schema,
modes, embedding model or k differ, or, without `--allow-set-change`, their
set hash or query IDs do; with it, only the queries both runs have are
compared. A missing or unreadable baseline is refused (exit `2`) before any
search runs, `--k` must include 1, and the gate flags need `--baseline`.

`--redact` removes `q`, `expected` and `top` from each `per_query` entry,
nulls `meta.set`, `meta.source` and `baseline.file`, and replaces `warnings`
(which name documents) with a count, in the output (`--json` and the human
report alike) and in `--out`. With `--lint` it nulls `meta.set` and replaces
`warnings` (which quote titles and query words) with a count. On stderr, a refusal keeps its reason, which
carries counts and query IDs, and replaces its details (which name documents)
with a count, and a malformed set or baseline is named by file and line
without the parser's words. An error that repeats a path given on the command
line (`--set`, `--baseline`, `--out`) still names it. A redacted run still
works as a baseline. A baseline is refused (exit `2`) unless every query
appears once in every mode it names, keeps its class across modes, and has a
hit or miss at every k, with `hit_at` null exactly for the `no-answer` class.

#### `brain index` counters

Each counter describes this run, not the index as a whole, and they do not
partition one another:

- `total` — markdown files the scan found. It includes files the run then
  skipped as unreadable or missing `title`/`type` (each skip is a `SKIP:`
  warning on stderr), so `added + updated + unchanged` can be less than it.
- `added` / `updated` — markdown documents written this run that were not /
  were already in the index. Under `--force` every parsed file is one or the
  other.
- `unchanged` — markdown documents left alone because their content hash
  matched. Always `0` under `--force`.
- `deleted` — index rows the deletion sweep removed because their file is
  gone, markdown and assets alike. It is not part of `total`: deleting the
  last document reads `total: 0, deleted: 1`. Under `--force` every markdown
  row is wiped before the sweep runs, so a markdown file removed since the
  last run is not counted (`deleted: 0`); only removed assets are.
- `chunks` — chunks written this run: those of the added and updated
  documents, plus one per asset indexed.
- `embeddings` — vectors written this run, text chunks and assets together.
- `assets` — images and PDFs (re)indexed this run. Assets are only indexed
  on an `--embeddings` run, so it is `0` otherwise. Since 0.38.0 an asset git
  ignores is never indexed, so it is not counted here, and one that becomes
  ignored is removed and counted in `deleted`, like a deleted file. Ignored
  markdown is still indexed. `brain stats` `size.corpus` leaves ignored assets
  out by the same rule.
- `graphMs` / `graphNodes` — the graph rebuild's wall time and node count.
  Both are `0` when this run did not rebuild the graph: either nothing it
  depends on changed and the previous tables were reused, or the rebuild
  failed, which also prints `Graph precompute failed: …` on stderr and keeps
  the previous tables. The JSON alone does not tell those two apart.

`brain stats --json` grew two nested blocks in 0.37.0. Nothing was removed or
renamed, so a consumer reading only the flat counts other than `embeddings`
needs no change.

One flat count changed in 0.37.0, and it is the one breaking change in this
shape: `embeddings`, which was a `number` and is now `number | null`.

It changed value first. Before 0.37.0 the command counted `vec_chunks` on a
read-only connection that had never loaded sqlite-vec, so the query raised
`no such module: vec0` and a bare `catch` reported `embeddings: 0` — on a fully
embedded brain as much as on a keyless one. It now loads the extension before
counting, so on any host where sqlite-vec loads, `embeddings` is the real number
of stored vectors. A consumer that treated `0` as "this brain does not embed"
was reading a measurement failure, and will now see the true count; one that
charted the figure over time will see a step at this version, not a
re-embedding run.

It also changed type. When the brain has a `vec_chunks` table and sqlite-vec
will not load on this host, the count cannot be taken, and `embeddings` is
`null` rather than a `0` that reads exactly like a brain holding no vectors. A
brain with no `vec_chunks` at all still reports `0`: there is nothing to count,
and that is known. A consumer doing arithmetic on the field must handle `null`
(the maintainer ruling is on
[#169](https://github.com/schlessera/brain-kit/issues/169)). When the cause is
the extension, `brain stats` also prints `sqlite-vec not available: <cause>` on
stderr, never on stdout.

```jsonc
{
  // health: what needs attention. A figure that cannot be known is null,
  // never 0 — an unmeasurable ratio must not read as a failing one.
  "health": {
    "brokenLinkRate": 0.054,       // brokenLinks / links; null when there are no links
    "embeddingCoverage": null,     // eligible chunks with vectors / eligible chunks; null when this brain neither
                                   // embeds nor holds vectors, has no eligible chunks, or vectors cannot be read
    "stale": 2,                    // past the per-type staleDays — the `brain audit` definition
    "orphans": 1,                  // no link either way, honouring orphanExempt — likewise
    "untagged": 1,                 // non-archived markdown documents with no tags
    "thresholds": { "coverageFloor": 0.9, "brokenLinkCeiling": 0.05 }
  },
  // size: what the brain weighs. brain.db is disposable; its size is a
  // rebuild-cost figure, not a claim that it holds authoritative state.
  "size": {
    "corpus": { "bytes": 22231, "files": 29 },   // null when a directory under the
                                                 // root could not be read
    "db": {
      "bytes": 453208,
      "tables": { "documents": 25, "links": 37 },
      // Live vectors against the slots sqlite-vec has allocated for them.
      // Deleted vectors leave slots it never reuses; `brain index --compact`
      // (and `brain maintain`, when fewer than half are live) reclaims them.
      // Each is nullable on its own. `live` is null when the vector table
      // exists and sqlite-vec will not load, so it cannot be counted.
      // `allocated` is null then too, and also when the extension loads but
      // its chunk table is not in the shape this version knows — so `live`
      // can be a number while `allocated` is null. Both are 0 when there is
      // no vector table. Additive in 0.38.0.
      "vectorSlots": { "live": 3030, "allocated": 7168 }
    },
    "freeBytes": 643825672192     // null when the platform call fails
  }
}
```

`stale` and `orphans` are the same counts `brain audit` reports in its
`staleness` and `orphan` categories, from the same per-type `staleDays` /
`orphanExempt`. `brain stats` does not carry a threshold of its own; the only
configuration it adds is the `stats` block on `brain.config.*`
(`coverageFloor`, `brokenLinkCeiling`, both ratios in 0..1), which supplies the
`health.thresholds` echoed above and defaults to the values shown when absent.

### Embedding eligibility and coverage semantics

`taxonomy.types.<type>.embed` is an optional boolean. With no effective value,
it defaults to `true`. `false` keeps the document/chunk keyword indexes,
links, audit and ordinary counts, but excludes that type from chunk-context
and vector generation. It also removes existing vectors on the next index
pass, even without `--embeddings` or a content change. Enabling the type again
makes missing vectors eligible for the next embeddings pass. The policy
applies to markdown and image/PDF vectors, including cache and carried-vector
reuse; asset description enrichment remains independent.

`health.embeddingCoverage` is **eligible chunks with vectors / eligible
chunks**, using the current resolved taxonomy for both sides. Stored vectors
for opted-out types cannot inflate the numerator. `chunks` and `embeddings`
remain total inventory counts; they must not be divided to reconstruct this
health ratio. Zero eligible chunks returns `null` and carries no coverage-floor
verdict. An unavailable/unreadable vector store is still unknown (`null`), as
is a brain that neither embeds nor holds vectors. The field remains
`number | null`; no competing coverage ratio is added.

**Migration note:** this is an approved pre-1.0 semantic break
([maintainer ruling](https://github.com/schlessera/brain-kit/issues/429#issuecomment-5906802435)).
Previously coverage used all stored vectors / all chunks. Consumers must use
the supplied health field and handle its null cases. A coverage increase after
opting out a type reflects the new denominator, rather than new embeddings.
Older committed stats-history snapshots retain their recorded semantics; an
index rebuild does not rewrite them. See the
[eligibility decision](decisions/embedding-eligibility.md).

### Recorded corpus trend verdicts (additive in 0.40.0)

`brain stats --json` and `--history --json` include `trends`, and the `stats`
entry of `brain maintain --json` carries the same object. Briefing retains
plain text and includes only warning explanations. The measurement itself
is current; the CLI enriches it with history. The library function behind it
is first-party only (#1053).

`trends` is `{ evaluatedAt: <ISO timestamp>, verdicts: [...] }`, with exactly
one verdict for each `metric`: `embeddingCoverage`, `brokenLinks`, `orphans`.
Each verdict has:

- `state`: `warning`, `measured-no-warning`, `insufficient`, `stale`, or
  `incomparable`. An unusable comparison never becomes a healthy verdict.
- `baseline` and `recent`: `{ start, end, dates, samples, median, countMedian,
  versions }`. Dates are inclusive UTC calendar dates; `dates` lists the
  actual valid daily observations and `samples` their count. Missing or
  invalid values are excluded, not zero. `versions` lists known strings used
  (a missing version still causes incomparability). `countMedian` is only
  populated for the paired broken-link counts, otherwise null. Coverage and
  broken-link `median` values are ratios, not percentages.
- `latestAt`: the latest used recording timestamp, or null. Future dates and
  recordings, and timestamps inconsistent with their stated UTC day, are
  excluded. Duplicate days use the existing history reader's semantics.
- `change`: recent minus baseline median; `countChange`: the paired
  broken-link count delta; `relativeChange`: the orphan delta / baseline,
  null at a zero baseline. Inapplicable fields and changes for unusable
  comparisons are null. Partial window medians remain available as evidence.
- `rule`: `{ minimumSamples: 3, maximumAgeHours: 48, minimumChange,
  minimumCountChange, minimumRelativeChange, currentThreshold }`, naming the
  effective fixed rule and configured floor/ceiling. Inapplicable fields are
  null. `message` is the core-owned explanation, reused verbatim by consumers.

Recent is today minus 6 days through today; baseline is today minus 13
through minus 7. Each needs at least 3 valid days. Medians use the ordinary
mean of the middle two values for even samples. Freshness is inclusive at
48 hours. State precedence is insufficient samples, incompatible provenance,
stale observations, then measured classification. A `--since` filter does
not change the evaluation windows or sample membership.

Coverage warns for a fall >= 0.05 and recent strictly below `coverageFloor`.
Broken links warn for rate rise >= 0.01, count rise >= 3 and recent rate
strictly above `brokenLinkCeiling`; rate and count use the same valid paired
rows, with a positive link denominator and a recorded rate matching count /
links. Orphans warn for absolute rise >= 5 and relative rise >= 0.20; from
zero only the absolute gate applies. Decisions use unrounded values; numeric
evidence and the explanation preserve enough precision to separate boundaries.
These are initial uncalibrated policy thresholds, not inferred causes.

Version compatibility is conservative and explicit. Reviewed 0.37.0/0.38.0
coverage uses total chunks; 0.40.0 uses eligible chunks. They cannot be mixed.
Development histories labelled 0.39.0 can contain either definition, so their
coverage is incomparable. Broken-link/orphan definitions are compatible
across those four exact versions. Other, missing or prerelease versions are
unsupported until reviewed. See the [trend decision](decisions/stats-trends.md)
for provenance evidence and rejected alternatives. Old snapshots and
recording/retention rules are unchanged.

A current-value finding takes precedence for its metric; the PWA adds trend
evidence to that existing notice instead of a second warning. Complete
comparisons remain in receipts. An incomparable metric chart is replaced by
its explanation rather than connecting incompatible definitions.
Missing/stale/incomparable history produces
no alert or healthy claim there or in briefing. Malformed JSONL still follows
the reader's existing explicit-error behavior; it is never silently repaired.

### Stats history (additive in 0.40.0)

`brain stats --record`, and the `stats` step of `brain maintain`, keep the
day's figures as one line of `.stats-history.jsonl` at the brain root. The
file is committed with the brain: `brain.db` is disposable, so the history
cannot live there, and `brain index --force` never touches it. Nothing indexes,
validates or audits it, and `size.corpus` does not count it.

- One snapshot per UTC day. A second recording the same day replaces that
  day's line. Every recording rewrites the file sorted by date, one line per
  day, and the file is `merge=union` in `.gitattributes`, so a merge of two
  clones' histories never conflicts; two lines for one day resolve to the
  later `at`.
- Retention: every day for the last 90 days, then the latest snapshot of each
  ISO week.
- A line that is not a JSON object with a `YYYY-MM-DD` `date` (a conflict
  marker left by a merge, say) fails both the recording and `--history`, and
  the file is left untouched to be fixed by hand.
- Recording does not change current figures in `brain stats --json`; trend
  evidence uses history available before the write. A later command can see
  the newly recorded day. The recording note goes to stderr.

A line holds `date`, `at` (ISO timestamp), `version` (the brain-kit version
that recorded it), the flat counts and breakdowns of `brain stats --json`,
`health` without `thresholds`, and `size` flattened to totals: `corpusBytes`,
`corpusFiles`, `dbBytes`, `dbRows` (the sum of `size.db.tables`),
`vectorsLive`, `vectorsAllocated`, `freeBytes`. The line format is not the
contract; `--history --json` is:

```jsonc
{
  "dates": ["2026-09-28", "2026-09-29"],       // index i of every array is one snapshot
  "recordedAt": ["2026-09-28T03:00:00.000Z", "2026-09-29T03:00:00.000Z"],
  "versions": ["0.40.0", "0.40.0"],
  "documents": [24, 25], "tags": [43, 43], "links": [37, 37],
  "brokenLinks": [2, 2], "chunks": [24, 25], "embeddings": [0, 0],
  // Every key any snapshot had. A key missing from a snapshot that has the
  // breakdown is 0 there; a snapshot without the breakdown reads null.
  "byType": { "note": [2, 3], "project": [6, 6] },
  "byStatus": { "active": [22, 23] },
  "byRelevance": { "primary": [15, 16] },
  "health": {
    "brokenLinkRate": [0.054, 0.054], "embeddingCoverage": [null, null],
    "stale": [11, 11], "orphans": [1, 1], "untagged": [1, 1]
  },
  "size": {
    "corpusBytes": [22101, 22647], "corpusFiles": [28, 29], "dbBytes": [344064, 344064],
    "dbRows": [340, 352], "vectorsLive": [0, 0], "vectorsAllocated": [0, 0],
    "freeBytes": [30714716160, 30714716160]
  }
}
```

A field a snapshot does not carry, because the version that recorded it did
not have it, reads `null` in that snapshot's slot, never `0`; so does a figure
`brain stats` reported as `null`. No history is empty arrays, not an error.

`brain jobs scrape --json` prints `{ report }` and nothing else. Its per-source
rows gained a `status` in 0.37.0, additively — every earlier field keeps its
name and type — because the count alone could not say what a zero meant. A
board that had nothing to offer and a board whose parser had stopped working
both reported `jobs_found: 0` with an empty `errors`, and that is what
[#37](https://github.com/schlessera/brain-kit/issues/37) closes.

```jsonc
{
  "report": {
    "sources": [
      {
        "source": "weworkremotely",
        // One of exactly four values. A consumer branches on this, not on the
        // count, and must tolerate an unknown fifth rather than assuming.
        //
        //   "ok"          rows came out. Pages that drifted are still listed
        //                 in `errors`, so `ok` does not mean "no errors".
        //   "empty"       EVERY page the board attempted came back readable,
        //                 and they said, in the board's own terms, that it
        //                 holds no postings — an API's own envelope with an
        //                 empty record list, a feed with a channel and no item
        //                 markup. One page that failed or was not recognised
        //                 denies the board this. The only zero-row state
        //                 allowed to carry an empty `errors`.
        //   "unparseable" a page arrived, did not say it was empty, and
        //                 yielded nothing: selector drift, a challenge page,
        //                 or markup from another site.
        //   "not_run"     nothing readable arrived at all — never invoked, or
        //                 every page failed before a body could be parsed
        //                 (robots.txt refusal, HTTP 410, no Chrome).
        "status": "unparseable",
        "jobs_found": 0,
        "jobs_new": 0,
        "jobs_updated": 0,
        // Detail-page enrichment (#36), added in 0.37.0 alongside `status`.
        // Counts of ROWS, never a claim about whether the board was read, so
        // none of them moves `status`. A non-zero `enrichment_failed` or
        // `enrichment_truncated` also has a line in `errors`;
        // `jobs_enriched` does not, since it is not a finding.
        //   jobs_enriched         rows with no description that got one from
        //                         their own detail page this run
        //   enrichment_failed     detail pages fetched that failed or carried
        //                         no description; those rows are still stored
        //   enrichment_truncated  rows left undescribed because the run's cap
        //                         on detail pages was reached
        "jobs_enriched": 0,
        "enrichment_failed": 0,
        "enrichment_truncated": 0,
        "errors": ["We Work Remotely https://weworkremotely.com/remote-jobs.rss: parsed 0 jobs from a page that does not say it is empty — selector drift, a challenge page, or markup that is not this board's"],
        "duration_ms": 4213
      }
    ],
    "dedup": { "checked": 0, "duplicates_found": 0 },
    "scored": 0,
    "total_new": 0,
    "total_errors": ["..."]   // every source's errors, concatenated
  }
}
```

The three enrichment counts are additive in the same way `status` was: nothing
earlier was renamed or retyped. A row the listing already described, or one an
earlier run stored with a description, is not fetched and appears in none of
them. A `--dry-run` fetches no detail pages, so they are all 0 there. A row
whose adapter never returned carries 0 in all three.

Every selected board gets a row, including one whose adapter never returned: it
appears with `status: "not_run"` rather than dropping out of `sources`, because
a missing row reads as a board that was never asked for.

The jobs database records the same judgement in `scrape_runs.status`: `ok` and
`empty` are `completed`, `unparseable` and `not_run` are `failed`. A board that
could not be read therefore stops advancing its cursor even when it threw
nothing.

## Browser scraping navigation policy

`@schlessera/brain-scrape`'s `BrowserSession.load` checks robots.txt and applies
per-host pacing before dispatching each HTTP(S) main-frame navigation: the
initial URL, every redirect target and subsequent navigation during the load.
`BrowserSessionOptions.userAgent` is both the sent identity and the robots
matching token, defaulting to the package's identifying User-Agent.
Scripts, images, child frames and page-generated API requests are outside
these checks and pacing. The existing rule against intentional circumvention
still applies; this is not a browser network sandbox.

`PageRequest.allowDisallowed` is an explicit per-call option, default false,
for an owned host or written site permission. It authorizes only the
requested URL's original origin, never a cross-origin redirect, and never
persists into another call. Ordinary pacing and usable Crawl-delay still
apply. HTTP's `respectRobots`/`SCRAPE_RESPECT_ROBOTS` opt-out does not disable
browser enforcement. No session-wide browser override is provided.

Sessions own a robots cache and limiter by default; optional `robots` and
`rateLimiter` inputs share the run's objects. `ScrapeClient` exposes readonly
`robots`, `rateLimiter` and `userAgent` for this purpose. `runAdapters` and
the jobs runner share these objects when constructing the browser. A supplied
preconstructed BrowserSession retains the policy state chosen by its caller.
`RateLimiter.acquire(host, delayMs?, signal?)` and an injected clock's
`sleep(ms, signal?)` accept cancellation without granting a request or
letting another waiter overtake a preceding acquisition.

`pageBudgetMs` bounds the whole page operation after concurrency admission,
including acquisition, policy waits, navigation and extraction. A refusal
or timeout rejects the load, closes its page and releases capacity. Jobs
report a board whose pages are all refused as `not_run` with errors and
persist `failed`, using the existing JSON/status shapes above.

This pre-1.0 tightening replaces unenforced browser navigation and the
implicit Chrome User-Agent. Consumers needing a disallowed navigation must
provide the authorized per-call option; HTTP behavior is preserved. The
[scraping-politeness record](decisions/scraping-politeness.md#browser-enforcement-ruling)
records the approved request boundary and override policy.

## MCP server (stdio, `brain mcp` or `src/mcp-server.ts`)

Tool names and input schemas are stable:

| Tool | Annotations | structuredContent |
|------|-------------|-------------------|
| `brain_search` | readOnly | `{ results, warnings }` — each result is `{ path, title, type, relevance, status, summary, updated, deadline, tags, score, snippet, supersededBy? }`; every field after `type` may be `null`. `status`, `summary`, `updated` and `deadline` are additive in 0.38.0. `supersededBy`, the path of the document that `supersedes` this one, is present only when one does (additive in 0.38.0) |
| `brain_context` | readOnly | `{ context, warnings }` |
| `brain_read` | readOnly | none — the first `content` block is the file text, verbatim; with `section`, that section; over `max_tokens`, the frontmatter and an outline of headings with estimated token counts. `max_tokens` is the threshold that switches to the outline, not a cap on the output: a large frontmatter or very many headings give an outline larger than it |
| `brain_list` | readOnly | `{ documents, warnings }` |
| `brain_graph` | readOnly | `{ edges: [{ source, target, resolved }], nodes: [{ path, title, type, summary, updated }], warnings }`. `nodes` holds one entry, sorted by `path`, for every document an edge touches: each `source`, and each `target` whose `resolved` is `true`. An unresolved target is raw link text and never a node. `summary` and `updated` may be `null`. `nodes` is additive in 0.38.0 |
| `brain_add` / `brain_update` / `brain_archive` | non-destructive, idempotent (update/archive) | result object |

`brain_search`, `brain_list` and `brain_graph` repeat their structuredContent
as the first `content` block, and the write tools return their result object
there. Both are compact JSON, with no indentation or line breaks (since
0.38.0). `brain_context`'s first block is the context text itself.

The server sends `instructions` at `initialize` (additive in 0.38.0). They
are descriptive, not frozen: the wording may change in any release, so a
client may show them to an agent but must not parse them. Today they say the
brain is the source of truth for facts about its owner, named from
`profile.name` when the config sets it and otherwise "the person it belongs
to". The name goes in as quoted data: whitespace, control and format
characters collapse to single spaces and it is capped at 80 characters, so a
config value cannot add lines of its own. They point to `brain_search`,
`brain_context`, `brain_read` and `brain_graph` for reading, and `brain_add`
and `brain_update` for writing, and say that `brain.db` is never edited
(`serverInstructions`, `packages/core/src/mcp-server.ts:77-89`). Tool descriptions are descriptive in the
same way. The read tools' descriptions state their defaults and the server
caps: `brain_search` `limit` at 50 and `brain_graph` `depth` at 5, and
`brain_list`'s accepted `limit` range of 1 to 100.

The input schemas, as `tools/list` reports them, are pinned in
[`packages/core/tests/mcp-input-schemas.json`](../packages/core/tests/mcp-input-schemas.json)
with descriptions left out; `mcp-contract.test.ts` fails when a tool's schema
drifts from it. `?` marks an optional input; a default is given where the tool
applies one:

| Tool | Inputs |
|------|--------|
| `brain_search` | `query`, `type?`, `tag?`, `relevance?`, `mode?` (`fts`\|`vector`\|`hybrid`, default `hybrid`), `rerank?` (`none`\|`heuristic`\|`jev`; omitted → the configured provider when `reranker.enabled` is true and available, otherwise local heuristic. An explicit `jev` cannot enable judgment while off; it warns and falls back. 0.39.0 added `jev` and dropped the schema default of `heuristic`), `include_archived?` (default `false`), `assets_only?` (default `false`), `limit?` (default `10`), `updated_since?`, `updated_before?`, `deadline_from?`, `deadline_to?` (`YYYY-MM-DD`, inclusive), `sort?` (`score`\|`updated`\|`deadline`, default `score`), `upcoming?` (default `false`) — the six date inputs added in 0.38.0, additively; an invalid date is a tool error |
| `brain_context` | `query`, `max_tokens?` (default `4000`), `include_identity?` (default `true`), `include_current_focus?` (default `true`) |
| `brain_read` | `path`, `section?` (a heading's visible text, compared under Unicode canonical caseless matching (full case folding); the body is parsed as GFM, and only top-level ATX and setext headings count, never one inside code, HTML, a table, a list or a blockquote; the section runs to the next heading of the same or higher level; of two equal headings the first is returned; an unknown one is an error naming the document's headings), `max_tokens?` (positive safe integer; the threshold for the outline, not an output cap; no default, so the whole file comes back unless it is given). Both additive in 0.38.0 |
| `brain_list` | `type?`, `tag?`, `status?`, `relevance?`, `limit?` (integer `1`–`100`, default `20`; the schema says `"type": "integer", "minimum": 1, "maximum": 100`. A fraction, `0`, a negative or a value over `100` is rejected as invalid input, a tool result with `isError: true` and no `structuredContent`, the convention every schema violation follows. **Breaking in 0.41.0 (#1351):** the schema was a plain `number` and the server clamped the value into 1–100, so `0` listed 1 and `500` listed 100) |
| `brain_graph` | `path`, `depth?` (default `1`), `direction?` (`outgoing`\|`incoming`\|`both`, default `both`) |
| `brain_add` | `content`, `type?`, `title?`, `tags?` (comma-separated) |
| `brain_update` | `path`, `summary?`, `status?` (`active`\|`archived`\|`draft`), `relevance?` (`primary`\|`secondary`\|`historical`), `tags?` (comma-separated, replaces), `deadline?`, `next_review?` (ISO 8601; `""` removes), `append_content?`. Setting `status: "archived"` applies `brain_archive`'s relevance rule to the effective relevance (the `relevance` passed in the same call, else the document's): a `primary` or missing one becomes `historical` and `"relevance"` is listed in `changes`; an explicit `secondary` or `historical` stays (additive in 0.38.0) |
| `brain_archive` | `path`, `dry_run?` (default `false`) |

Read tools append an index-staleness warning when markdown files are newer
than their `indexed_at`.

### Hosted authoritative application tools

Hosted turns route authoritative Markdown through the server-owned application
boundary. Standalone terminal `brain mcp` names and schemas above are unchanged.
Claude registers the tools below under `mcp__brain-ui__`; pi uses the unprefixed
names. Hosted Claude disallows project `mcp__brain__brain_add`,
`mcp__brain__brain_update` and `mcp__brain__brain_archive`, plus built-in raw
writers; its server tools apply the validated effects instead.

| Tool | Exact input (unknown keys refuse) |
| --- | --- |
| `brain_read_base` | `{ path: string }`; returns `{ content: string, expectedBaseHash: string }` |
| `brain_add` | `{ content: string, type?: string, title?: string, tags?: string[], target?: string, expectedBaseHash?: string \| null }`; deterministic server capture plans and validates its current base when absent |
| `brain_update` | `{ path: string, expectedBaseHash: string \| null, summary?: string, status?: "active" \| "archived" \| "draft", relevance?: "primary" \| "secondary" \| "historical", tags?: string[], deadline?: string, next_review?: string, append_content?: string }` |
| `brain_archive` | `{ path: string, expectedBaseHash: string \| null, dry_run?: boolean }` |
| `write_file` | `{ path: string, expectedBaseHash: string \| null, content: string }` |
| `edit_file` | `{ path: string, expectedBaseHash: string \| null, old_string: string, new_string: string }`; nonempty old string must occur exactly once |
| `apply_staged_changes` | `{ files: [{ path: string, expectedBaseHash: string \| null, content: string }] }`; 1–32 unique named files, no command field |

Hashes are lowercase SHA-256 of complete UTF-8 bytes; `null` means exclusive
creation. Pi may omit a tool's base hash only when a preceding read in the same
turn supplied it; a write with no read is create-only. The server application
request is `{ principalId, turnId, input: { operation, ...toolInput } }`;
identity is bound by the trusted host, never taken from tool arguments. Operations
are `add`, `update`, `archive`, `write`, `edit` and `staged` only. No command replay,
filesystem handle, policy-derived authority or standing grant is accepted.

The request and combined proposed Markdown each have a 1,048,576-byte UTF-8 bound.
Only ordinary UTF-8 `.md` files are supported. Paths are exact root-relative names,
up to 1,024 characters: no traversal, hidden path components, backslashes or
control characters. Policy paths and ancestors (including case/Unicode variants),
symlinks, multiple-link files and changed directory topology refuse. Existing
content must match the exact stated base, including after approval/lock admission.
Unsupported hosts refuse; descriptor-anchored I/O currently requires Linux procfs.

Every call rechecks current principal/turn authority and operation membership.
Archive and an update setting `status: "archived"` retain their explicit permission;
ordinary permitted writes/edits add no confirmation. Voice retains capture and
append/update, excludes archive/raw/staged writes, and cannot grant. Unattended
rosters supply no new authoritative grant. Direct backend calls without an
application bridge retain their existing enforced roster, permission checkpoints
and writer-yield behavior. Hosted routing begins when the host binds that bridge.
Cancellation before commit changes no
Markdown; the synchronous commit burst completes before cancellation can interleave.
All effects actually reaching Markdown are recorded, including a partial I/O
failure. Disposable-index failure after commit does not report the write as absent.
The in-process lock does not coordinate external terminal writers.

Application results are `{ ok: boolean, message: string, changes:
[{ path: string, contentHash: string | null }], code?: string,
indexed?: boolean, outcome?: object }`. A null result hash denotes a removed
source. `changes` names only committed effects. A refused result is visible to
the agent and recorded as a server-authored `brain_application` activity event;
policy denial, alias denial, topology change, stale base, revoked authority,
membership, permission, invalid request, unsupported kind/host, payload and
cancellation errors never silently merge or replay. Error codes are additive;
consumers tolerate unknown codes. Claude wraps the result in MCP text with
`isError: !ok`; pi returns successful results as text/details and throws refused
results through its existing tool-error path.

CLI commands encountering `EROFS` exit 2. On Linux, known write forms also
refuse a read-only brain mount before entering handlers which collect per-file
errors; dry-run forms and read-only commands remain available. Machine mode emits
`{ schema_version: 1, ok: false, error: { code: "read_only_brain", message: string,
tool: string } }`. The message states that the brain is read-only here and names
`brain_add`, `brain_archive`, or `apply_staged_changes` for the corresponding
hosted effect, including the Claude spelling. Nothing is staged or replayed;
read-only commands continue to work. Writable index connections retain SQLite WAL
sidecars after clean close, so a read-only mount can read the checkpointed index
without recreating sidecars. Human mode prints the same message to stderr.

### Chat-UI in-process tools (`mcp__brain-ui__*`)

The chat-UI backends register an in-process MCP server under the `brain-ui`
key; its tool names are equally stable. `ask_user`, `ask_user_form` (additive in 0.40.0), `ask_user_rank` (additive in 0.40.0), `ask_user_list` (additive
in 0.40.0), `get_current_location` and `request_image_mask` bridge to the
connected browser. `query_activity`
(read-only) reads the host's activity record — scopes `running` | `recent` |
`run` | `rollups` | `inbox`; results are wrapped in a data-only delimiter
(nonce-suffixed per call) because they can contain free text from past runs.
`show_block` (side-effect free, always registered) renders one of the kit's
answer blocks inline in the answer, or the follow-ups the model offers under
it (`suggestions`); it validates its argument and echoes it, and rejects a `link` block whose
address the link policy refuses, and a `tracker` block with any event whose address it refuses.
The eight bridge tools are declared once as **tool contracts** in
`@schlessera/brain-ui-sdk/tool-contracts` (also re-exported from `/server` and
`/client`); their names and Claude-side input schemas are stable.

**Schema representation (#563):** `show_block` now writes its unchanged
`tone`, `valueTone` and `icon` inputs once as shared definitions, and omits
field descriptions already stated by the tool description. The Claude MCP
listing uses draft-7 `definitions` and local `$ref`; Pi uses draft-2020-12
`$defs` and local `$ref`. Consumers resolve these references according to the
advertised schema dialect. Tool names, accepted fields, validation, handler
results and rendered blocks remain unchanged; this representation update ships
in a minor without a `schema_version` change. The choice and measured limits
are recorded in [the design-kit decision](decisions/design-kit.md).

### Tool component contracts

A contract is `{ name, description, input, brief }`, plus `payload` when the
tool's result is meant to be rendered as a component rather than read as text:

| Contract | Payload in `output` | Rendered as |
|---|---|---|
| `ask_user` | `{ questions, answers, annotations? }` | the picker's answered state |
| `ask_user_form` (0.40.0) | `{ answers, visibleNodes }` — typed answers by visible node id; the request is not echoed | one conditional form and its visible-path answered record |
| `ask_user_rank` (0.40.0) | `{ order, unchanged }` — every requested id exactly once; the request is not echoed | final numbered order rebuilt from input and result |
| `ask_user_list` (0.40.0) | `{ answers, skipped, notes? }` — the request is not echoed | the list card's answered record, rebuilt from the call's input plus this |
| `get_current_location` | `{ latitude, longitude, accuracyMeters, place?, address?, addressComponents?, note?, retrievedAt }` | a map card: the fix as a pin, the shoreline from `GET /api/geo/coastline` when the server has it |
| `request_image_mask` | `{ maskPath, imagePath, bytes, note }` | a mask result |
| `query_activity` | **none** | prose in a nonce-delimited data block |
| `show_block` | `{ block }`, the validated input echoed | the block, inline at the call's position in the answer; `suggestions` alone is drawn under the answer instead |

#### `ask_user_form` (additive in 0.40.0)

- **Input:** `{ prompt, nodes }`, a flat list in display order. Every node has
  a unique `id` (1–64 characters), `kind`, `prompt` (1–300), optional `header`
  (up to 12) and `required` (omitted means `true`). `single` and `multi` add
  `options[2..]{label (1–40), description? (≤120), preview? (≤4000)}`.
  `scale` adds the list tool's `scale`, `items` and optional `notes`;
  `rank` adds the rank tool's `items` and optional `cutoff`; `text` needs no
  additional fields. Scale and rank retain their existing per-node item caps
  (30 and 15); scale retains its 2–8 options. Duplicate node/item ids or
  option labels, and invalid cutoffs, are refused before displaying a card.
- **Conditions:** optional `showIf: { node, anyOf }` names an earlier
  `single`/`multi` node and one or more labels offered by it. A multi parent
  matches any selected label. An unknown/later parent, non-choice parent or
  unoffered label is refused. A hidden ancestor hides all descendants;
  automatic Other input never reveals a branch, even when its text matches
  an offered label.
- **Limits:** `AskUserFormLimits` exposes exactly `maxDepth`, `maxNodes` and
  `maxOptions`, defaulting to 3 (root is depth 1), 12 and 8. Hosts may pass
  `WsHostOptions.askUserFormLimits`; the server accepts
  `BRAIN_UI_ASK_USER_FORM_MAX_DEPTH`, `BRAIN_UI_ASK_USER_FORM_MAX_NODES` and
  `BRAIN_UI_ASK_USER_FORM_MAX_OPTIONS`. Set values must be positive safe
  integers (`maxOptions` at least 2); invalid values refuse startup. Both
  backend handlers validate using the host's limits, and the host validates
  before emitting. Raising `maxOptions` raises the choice cap; the scale's
  native 8-option cap remains. There is no independent aggregate-items cap.
- **Result:** `{ answers, visibleNodes }`. `answers` contains only answered
  visible nodes, with these values: single `{ value, other? }` (`other: true`
  marks custom input); multi `{ values, other? }` (`other` is custom text);
  scale `{ answers, skipped, notes? }`; rank `{ order, unchanged }`; text is
  a trimmed string, at most 280 characters. The handler recomputes visibility,
  drops hidden/unknown answers and normalizes each kind. Required visible
  nodes must be complete; a required scale needs every row. An untouched rank
  returns the input order with `unchanged: true`. Rank answers must be a
  complete permutation, and `unchanged` is derived. `visibleNodes` follows
  input order, including unanswered optional nodes, distinguishing skipped
  from hidden. A supplied client `visibleNodes` is never trusted.
- **Frames:** `server_hello.capabilities.askUserForm` advertises support.
  Session/turn-scoped `ask_user_form_request` carries
  `{ requestId, prompt, nodes }`; `ask_user_form_response` carries
  `{ requestId, answers, turnId? }`. The SDK echoes the request's turn id.
  `ask_user_cancel` dismisses it; all four ask kinds share the cancellation id
  space. Pending forms survive a temporary disconnect and are re-delivered,
  and reject when the turn is cancelled. Unknown additive frame/node/answer
  fields survive wire parsing; validation and normalization still apply.
- **Backends:** optional `BackendBridge.askUserForm(requestId, spec)` returns
  `AskUserFormResult { answers }`; `askUserFormLimits` carries the host limits.
  Claude registers `mcp__brain-ui__ask_user_form` with `alwaysLoad`; pi registers
  `ask_user_form`. Both use the shared schema/handler, and withhold the card
  from turns declaring `noGrantSurface`. All existing ask tools remain.
- **Rendering/replay:** one outer card contains shared scale and rank rows,
  unindented branch slots and one Submit. Hidden answers are held locally for
  Undo/reselection, excluded from progress, submission and summary. Drafts are
  not persisted. Input plus result rebuilds the visible answered path after
  reload. Composer text remains an ordinary message. A dismissed exchange may
  reopen locally and send its visible answers as a new composer message.

#### `ask_user_rank` (additive in 0.40.0)

- **Input:** `{ prompt, items, cutoff? }`. There are 2–15 items in the
  suggested starting order. Each has a unique `id` (1–64 characters), a
  `label` (1–200), optional `detail` (up to 200) and `link` (up to 2,000).
  `prompt` is 1–300 characters. `cutoff` is an integer from 1 through the item
  count: only that prefix matters, but the response includes every item.
  Duplicate ids and a cutoff beyond the item count are refused before the
  host receives a request.
- **Result:** `{ order: string[], unchanged: boolean }`. `order` is a complete
  permutation of the requested ids; missing, repeated, extra or unknown ids
  are refused. The handler derives `unchanged` from equality with the input
  sequence, rather than trusting the client's boolean. The request is not
  echoed in the result.
- **Frames:** hosts advertise `capabilities.askUserRank` in `server_hello`.
  Session/turn-scoped `ask_user_rank_request` carries `{ requestId,
  prompt, items, cutoff? }`. `ask_user_rank_response` carries `{ requestId,
  order, unchanged, turnId? }`, with the same turn echo rules as other
  interactive responses. `ask_user_cancel` dismisses it too; request ids share
  the ask exchange namespace. Pending requests survive a temporary disconnect
  and are delivered again on reconnect, and reject when their turn is cancelled.
- **Backends:** optional `BackendBridge.askUserRank(requestId, spec)` returns
  `AskUserRankResult { order, unchanged }`. Claude registers
  `mcp__brain-ui__ask_user_rank`; pi registers `ask_user_rank`. Both use the
  shared schema/handler. A turn with no grant surface does not open a rank card.
- **Rendering/replay:** one kit `AskUserRankCard` supports handle drag,
  tap-to-pick/tap-to-place and keyboard moves. Below-cutoff rows retain contrast.
  The result plus the original tool input rebuild the answered numbered list.
  Composer text stays an ordinary message; there is no inferred typed ranking.
  Dismissed exchanges can reopen locally and send their new order as a normal
  composer message, without answering the old server request.

#### `ask_user_list` (additive in 0.40.0)

One scale applied to a list of items, answered in one card (#583).

- **Input:** `prompt` (1-300), `scale[2..8]{label (1-40), description? (≤120)}`,
  `items[1..30]{id (1-64), label (1-200), detail? (≤200), link? (≤2048)}`,
  `allowSkip?` (default `true`), `notes?` (default `false`). Item ids and
  scale labels must each be unique; a duplicate is refused before any card is
  drawn. A `link` is shown only after the client's own `classifyLink` accepts
  it, with the host that parse yields; the model never supplies a host.
- **Result:** `answers` maps item id to the chosen option's label, `skipped`
  lists every other id in item order (the two always partition the list), and
  `notes`, present only when the input set `notes: true` and a note was
  written, maps item id to a note of at most 280 characters. A skipped item is
  absent from `answers`, never `""`, and may still carry a note. An answer
  naming an unknown id or an option not on the scale is dropped and the item
  counted as skipped.
- **Frames:** the host sends `ask_user_list_request` `{ requestId, prompt,
  scale, items, allowSkip, notes }` (defaults applied, session- and
  turn-scoped); the client answers with `ask_user_list_response` `{ requestId,
  answers, notes?, turnId? }`, or dismisses with the existing `ask_user_cancel`
  — request ids share one space across all ask kinds. A pending list survives
  a disconnect and is re-sent on reconnect, as an `ask_user` card is.
  `server_hello` advertises `capabilities.askUserList`.
- **Backends:** the bridge method is `BackendBridge.askUserList?` (`AskUserListResult
  { answers, notes? }`); a backend registers the tool when the host supplies it,
  and withholds it from a turn declaring `noGrantSurface`, as it does the mask
  editor, because the card needs someone to read it. It is not in the voice
  posture.
- **Composer:** a message typed while a list is pending is an ordinary
  message; it is not bound to the list.

`show_block`'s `block` is a discriminated union on `kind`. Each variant
mirrors the props of the kit component that draws it; tone values are the
kit's `Tone` / `ValueTone` / `DeltaTone` sets, and every value is a
pre-formatted string because the blocks do no arithmetic:

| `kind` | Shape | Drawn by |
|---|---|---|
| `comparison` | `columns[2..4]{label, note?, tone?, recommended?}`, `rows[]{label, cells[](string \| {v, tone?})}`, `corner?`, `footnote?` | `ComparisonTable` |
| `stats` | `tiles[1..8]{label, value, meta?, icon?, tone?}` | `StatTiles` |
| `trend` | `label?`, `value?`, `delta?`, `deltaTone?`, `values[2..]`, `ticks?[]`, `tone?` | `TrendChart` |
| `table` | `columns[1..6]{label, align?}`, `rows[]{cells[]{v, tone?, mono?, bold?}}` | `DataTable` |
| `bars` | `rows[1..12]{label, pct 0-100, value, tone?}` | `BarList` |
| `receipt` | `title?`, `titleIcon?`, `titleTone?`, `rows[]{k, v, tone?}`, `diff?`, `footnote?` | `Receipt` |
| `steps` | `steps[]{title, detail?, meta?, code?, state?}`, `variant?` | `StepList` |
| `timeline` | `items[]{time, title, detail?, meta?, tone?, pulse?}` | `TimelineList` |
| `schedule` | `groups[]{day, meta?, items[]{time, title, detail?, tag?, tone?}}` | `ScheduleList` |
| `quote` | `quote`, `source?`, `locator?`, `note?`, `tone?`, `icon?` | `QuoteCard` |
| `contact` | `label`, `role?`, `contactKind?`, `badge?`, `tone?`, `facts?[]{k, v, tone?}`, `initials?` | `ContactCard` |
| `files` | `items[1..20]{path (1-1024), reason? (≤240)}` | `RelatedFiles` |
| `map` | `title?` (≤60), `places[1..30]{label (1-80), lat? (-90..90), lon? (-180..180), meta? (≤40), source? (≤80), accuracyM? (>0, ≤100000)}`; `lat` and `lon` come together or not at all (additive in 0.39.0) | `PlaceMap`, planned by `planPlaces` |
| `graph` | `title?` (≤60), `nodes[2..20]{label (1-80), path? (≤1024), tone?, focus?}`, `edges[0..40]` index pairs `[a,b]`, `legend?[0..7]{label (1-40), tone?}`, `meta?` (≤40) | `GraphView`, deterministic client layout |
| `link` (0.39.0) | `url` (1-2048), `title?` (1-100), `description?` (≤240) | `LinkPreviewCard` (link mode) |
| `tracker` (0.41.0) | `events[1..20]{url (1-2048), action, qualifier? (1-60, trimmed, one line), title (1-200, trimmed, one line)}`, `action` one of `opened`, `closed`, `reopened`, `merged`, `labeled`, `commented`, `reviewed`; an event takes no other key | `TrackerPillList` |
| `suggestions` (0.39.0) | `label?` (1-24), `items[1..2]{label (4-80, trimmed, one line), icon?}` | the app's closing row, from `SuggestionChips`' data minus `tone` |

A `files` block (#1139) lists supporting local notes in payload order.
Paths and plain-text reasons are supplied by the agent; a reason is its claim,
and the block carries no retrieval scores or evidence that a file was read.
The live transcript and replay draw the list with the heading `Supporting
files`, clearing the kit's sample metadata. A permitted path opens the existing
authenticated file viewer in the current root only when the reader activates
that row. Absolute paths, URLs, schemes, backslashes, control characters,
query/fragment suffixes, empty path segments and `.`/`..` segments remain
readable without an open control. Missing files use the viewer's existing
unavailable-file error and never redirect to an alternative destination.
Static exports preserve every path and reason without interactive controls
or file requests. Malformed payloads retain the readable generic tool view.
The post-answer classifier does not infer this variant or supporting reasons.

A `graph` block (#1140) presents the agent's supplied nodes and relationships.
The host validates and echoes; it does not query the index or verify claims.
Edge indices must name distinct supplied nodes. Duplicate pairs, including
reversed pairs, are dropped; the first focused node wins. Unknown fields,
including coordinates and handlers, are discarded. Only supplied edges are
drawn: the kit's implicit focus spokes are disabled. Pure client layout
preserves indices and reserves room for wrapped labels. A textual node and
edge list is the accessible equivalent. Permitted brain file paths use the
existing file-link policy and current root's viewer; traversal and refused
paths stay plain text. No requests run while drawing the graph. Replay uses
the same block; static exports retain its full topology without file controls.
Optional title, legend and metadata never inherit kit sample defaults. Graphs
are not inferred by the answer classifier.

A `link` block's address passes `classifyLink` (`@schlessera/brain-ui-kit/links`)
twice. The handler rejects the call when it refuses the address, naming the
reason: `too-long`, `hidden-characters` (control, zero-width or bidi
characters, or leading and trailing space), `relative`, `unparseable`,
`scheme` (anything but `http:` and `https:`), `credentials` (any
`user:password@`), or `mixed-script` (a hostname label that fails UTS #39
Highly Restrictive). An echoed `link` payload is therefore one the policy
accepted when it was echoed. The payload parse on the client stays
structural, so a refused address that reaches a client anyway still parses,
and the card draws it as a withheld link with no anchor rather than falling
back to the generic view. The host is not a field: the card derives the host
it shows and the `href` it opens from one parse of `url`. Nothing is fetched
to draw the card, and it navigates only when the reader activates its Open
anchor (`target="_blank"`, `rel="noopener noreferrer nofollow"`, no referrer).

A `tracker` block (#1001) lists changes the agent reports it made to issues
and pull requests, one line each, in payload order. An event's repository,
number and item type are not fields: the kit derives them from a
GitHub-shaped `url` (`https://github.com/<owner>/<name>/issues/<n>` or
`.../pull/<n>`, optionally followed by a subpath, query or fragment), and any
other address shows only its title, its action and the host derived from the
`url`. An event carrying any key besides its four (`repository`, `number`,
`type`, `host`, …) is rejected naming the key, on the model's call and in the
client's payload parse alike. Each `url` passes `classifyLink` as a `link`
block's does: the handler rejects the call naming the event's 1-based
position and the reason (`refused tracker event 2: credentials`), and a
refused address that reaches a client anyway draws a withheld line with no
anchor. Every other line is an anchor to the parsed `href` (new tab, no
opener, no referrer); consecutive events with the same host and repository
share one header naming them; more than six events show five and a `Show
all N changes` control in the chat, while a shared image or PDF draws every
event with its title in full; and the list always ends with `Changes as reported
by the brain · tracker not checked`. Nothing is fetched to draw it. The
`qualifier` is the close reason, the label name or the review verdict, and
with the action it picks the line's tone (`merged`, `closed completed` and
`reviewed approved` teal, `opened` amber, `reopened` and `reviewed changes
requested` gold, everything else neutral); the action is always printed as
a word.

Layout knobs the kit components take (`labelWidth`, `barWidth`, `height`,
`timeWidth`, …) are not part of the contract: the surface decides them.

`map` is the one variant that is not handed to its component as it stands.
The model names places; how they are drawn is the surface's, and nothing in
the payload can set a span, zoom, box, height, tone, geometry or number.
`planPlaces` (`@schlessera/brain-ui-sdk/client`) turns the places into the
drawing, as a pure function a consumer may rely on:

- **Every place is a row, numbered 1..N in payload order**, in every mode.
  A place without `lat`/`lon`, at exactly `0, 0`, or past ±85° latitude is a
  row with a reason (`no position`, `0, 0 is usually a missing value`,
  `beyond the map's ±85°`) and no pin; a missing coordinate is never
  estimated. More than 30 places is a schema rejection, never a truncation.
- **The mode comes from the coordinates**: `list` when nothing is pinned or
  the pins' tightest arc crosses ±180°; `map` when one frame's envelope fits
  the geometry route's 5°; `pair` when the pins form exactly two groups
  (single linkage at 5° on both axes) that each fit; `list` otherwise. The
  reason line's distance is a haversine of the given coordinates, to three
  significant figures.
- **Each frame's geometry comes from `GET /api/geo/coastline`**, with the
  frame's `bbox` and `width=495`, the location card's route and cache. An
  empty answer or a failed request draws no frame, only
  `No map for this area · places listed below`; the list is unchanged.
- **Positions are the brain's claim.** Whenever a place is pinned the card
  says `Positions as given by the brain · the map does not check them`, and
  the OpenStreetMap credit appears once, exactly when OSM geometry is drawn.
`icon` fields are the kit's semantic icon keys; a key the kit does not know
is dropped rather than rejected. `show_block` payloads discard unknown fields
from the rendered block rather than keeping them, so otherwise valid stored
or replayed blocks still render. Its payload schema is separate from new-call
validation: new `suggestions` calls reject unknown keys at both the block and
item levels, including an item's unsupported `tone` (#635). Claude and pi
advertise that restriction and reject such calls with validation errors.
This tightens accepted input and ships as a pre-1.0 minor. Stored or replayed
suggestions continue to discard those keys; malformed payloads still fall
back to the generic tool view. Other block kinds keep their existing input
and payload parsing behavior.

`suggestions` (additive in 0.39.0, D50) is the one kind that is not part of
the answer. It is follow-ups the model offers the reader, and a consumer
that draws it holds to these rules:

- **Not at the call's position.** It is drawn after the answer, as the
  turn's closing row, from the turn's **last** call that parses. An earlier
  or rejected call draws nothing, and a share or print of the answer leaves
  it out.
- **Taking one never sends.** A chip puts its `label` in the reader's
  composer, below any draft, to edit or leave. It is never a message, an
  answer to a pending question or an approval.
- **The row is gone once the reader sends anything**, and it is not drawn
  while the turn runs, while an `ask_user` question in the turn is
  unanswered, or when the answer's last text ends in a question. The
  decision reads only the transcript and current state, so a replayed
  session draws what the live one did.
- **An older client** has no variant for it: the payload fails its parse
  and falls back to the generic tool view, as any unparsed payload does.

Rules a consumer may rely on:

- **The payload rides as JSON inside `ServerToolResult.output`**, which is
  already a string, so this needs no `PROTOCOL_REV` bump. Every tool with a
  `payload` schema serialises it there — `query_activity` has no payload
  because its result is untrusted text from past runs, and handing that to a
  component is a separate decision with its own threat model.
- **Payload schemas are additive and parsed loosely.** Unknown keys survive, so
  a newer server may add fields; a consumer that cannot parse a payload falls
  back to the generic tool view rather than failing the message.
- **The name the model sees is adapter-derived**, not a second constant:
  `visibleToolName(name, "claude")` prefixes `mcp__brain-ui__`, `"pi"` uses the
  bare name. `bridgeContractForToolName()` resolves either spelling.
- **`BRAIN_UI_SYSTEM_PROMPT_APPEND`'s tool paragraph is generated** from the
  contract list: every contract carries its own `brief`, so a tool cannot be
  schema'd without being described to the model.
- **The input JSON Schema is `z.toJSONSchema(input, { io: "input" })` with
  `$schema` removed**, identical across both backends for the same tool.

Result fields are additive (treat unknown fields as such). Cost fields are
dual: `costUsd` is the list-price reference, `effectiveCostUsd` the actual
out-of-pocket cost ($0 for subscription-billed runs); `null` means unknown,
never zero — aggregate scopes sum only known values and carry the excluded
count as `unpricedRuns`.

New billing computations use only a valid `brain.billing_mode`
(`subscription` | `api`) recorded on the run's root span. Missing or invalid
billing stays unknown for every origin, including cron: `billingMode`,
`effectiveCostUsd` and `pricingEstimate` are `null`, regardless of server
credentials or runtime identity. Available backend-reported or computed
list-price `costUsd` is retained. Non-null historical costs and billing remain
frozen at their first write; later valid evidence may fill unknown slots only
when it agrees with an already frozen classification. Re-rollups do not
reclassify previously recorded history from today's environment (#293).

## ui-server HTTP routes

The [supported HTTP specification and complete inventory](http-api.md) are part
of this contract. They deliberately select routes for independent clients and
integrations, preserve existing promises and SDK dependencies, and explicitly
exclude internal UI transport from independent raw-HTTP compatibility guarantees.
Support is separate from public accessibility: authenticated APIs can be
supported, while a UI-only probe can be internal. Authentication, inputs,
outputs, errors and specified behavior on supported rows follow the versioning
rules at the top of this document. The [selection decision](decisions/http-api-boundary.md)
records #343 Q6; no route redesign or immediate 1.0 freeze is implied.

The [runtime coverage matrix](http-api-coverage.md) maps supported operations
to real app mounting checks and named behavior tests. Its inventory also
accounts for internal routes, conditional static serving, HEAD dispatch and
configured CORS preflight without promoting internal payloads to guarantees.

The detailed stats promises below remain binding. The specification records remaining gaps; a gap does not revoke a guarantee.
Login, passkey registration/rename and capture refuse malformed/non-object JSON with JSON 400 errors.
Capture validates content/type/title/tags before CLI dispatch; valid object defaults and pre-handler authentication/owner checks remain binding.

### Published React health and sync helpers (breaking health correction)

`@schlessera/brain-ui-react` exports `createBrainApi` and `BrainApi`; the
embedding service `root.api` uses the same helpers. `health()` resolves to
`{ status: string; uptime: number; timestamp: string }`, matching the minimal
public route. The previously declared `version: string` never existed in that
response and is removed under the [maintainer's #693 ruling](https://github.com/schlessera/brain-kit/issues/693#issuecomment-5961143224).
This is an approved pre-1.0 breaking correction shipping in a minor. Migrate
`health().version` reads to authenticated `status()` when software identity is
needed; health never fabricates identity or requests protected status.

`brainSync()` POSTs through its configured base getter/request transport and
consumes complete SSE events. A valid terminal `done` maps `success` and `text`
to the existing `{ success: boolean; message: string }` result; terminal false
resolves as a completed unsuccessful sync. Progress and keepalive comments
are not completion. Missing/malformed terminal data, premature EOF and
transport failure reject as incomplete; non-2xx responses retain
`ApiRequestError`. No automatic POST retry or stream resumption is added.
Disconnect does not establish cancellation: the server continues draining and
reserves the canonical repository until its child exits, as specified in
[the HTTP sync contract](http-api.md#corpus-queries-capture-and-sync).

### Typed status software identity (additive, #598)

`SystemStatus` in `@schlessera/brain-ui-sdk/protocol` declares
`software: { release: string; sourceCommit: string }`, the object authenticated
`GET /api/status` already returns ([HTTP reference](http-api.md)). `release` is
the installed `@schlessera/brain-ui-server` package version and `sourceCommit`
the configured source commit, equal to `version`. `version` stays the source
commit: it is never a release and clients must not parse it as one. The served
response is unchanged; this only types it. The Activity bug report prints
`server: {release}` and `server commit: {sourceCommit}` only when this read
succeeded, and no server line otherwise.

### Internal Queue poke (additive)

The supported `POST /api/internal/inbox/poke` operation uses an independent
boot-minted bearer token and the actual loopback socket, before general API
authentication in every auth mode. Forwarding headers never authorize it.
Its runtime-file configuration, rotation, exact success/error shapes and
bounded stopped-interval recovery are specified in [inbox-runtime.md](inbox-runtime.md).
The generated host consumes this operation; its `/internal` path does not
exclude it from HTTP compatibility. The shipped app wiring performs recovery
and heartbeat work with no production dispatcher. An unavailable or closed
runtime never grants access to ordinary APIs or enables autonomous execution.

### Interactive HTML preview (additive, #1084)

`GET /api/files/html?path=…` is an internal UI transport for the file
viewer's script-running preview and its "Open in new tab" link. Its raw path
is not an independent API. Its isolation is a security property that a
consumer and a reviewer may rely on: it serves `.html`/`.htm` files under the
raw route's path, auth and size rules, with a CSP `sandbox allow-scripts`
directive (an opaque origin), `connect-src 'none'`, `form-action 'none'` and
`frame-ancestors 'self'`. It is the only response sent with
`X-Frame-Options: SAMEORIGIN`; every other response keeps `DENY`. The
[HTTP specification](http-api.md#interactive-html-preview-additive-1084) has
the full header set and the residual risks accepted in #1084. Removing a
sandbox restriction or widening a source list is a reviewed change, and the
real-Chrome test fails on it. `GET /api/files/content?raw=1` and its CSP are
unchanged. The SDK's default service-worker policy never answers an `/api`
navigation from the app shell.

### Account partition key (additive, #1014)

```
GET /api/vpn-check → 200 { vpn: true, accountKey?: string }
```

The authenticated connectivity probe now also names the account the caller
is signed in as, for device-local partitions. `accountKey` is an opaque
22-character base64url digest. It is the same for every sign-in as the same
account on the same host and root, and differs between hosts (each UI
database has its own random seed) and between brain roots. It is a partition
name, not a credential: holding it grants nothing on the host. A client must
not parse it, and must not use `server_hello.principalKey` in its place,
because that one changes at every sign-in.

| Auth mode | Who gets a key | Same key across sign-out and sign-in |
| --- | --- | --- |
| `password`, with a password or a passkey | every owner login, one key | yes: every owner login is the one owner |
| `tailscale` | every admitted client, the owner's key | yes: the mode has no sign-in |
| `proxy` | each upstream user, its own key | yes, per upstream user |
| `none` | every client, the owner's key | yes: the mode has no sign-in |
| any mode, an agent principal | nobody: the field is absent | — |

A refused probe (401, 403) carries no key. A host older than this field
sends none, and the client then keeps nothing in an account partition.

`@schlessera/brain-ui-react` uses the key to keep the composer's work
context (drafts, images, voice review text, selection, focus and transcript
position) in IndexedDB, in a partition it opens only while it holds the same
key. That storage layout is client behaviour, not wire contract. It is a
boundary inside the client, not encryption, and not protection against
someone with access to the device.

### Corpus stats history (`GET /api/brain/stats/history`, additive in 0.40.0)

Passes `brain stats --history --json` through untouched, behind the auth
guard with the other `/api/brain/*` routes; the shape is under "Stats
history" above. A brain CLI older than 0.40.0 rejects the flag, and the route
answers `500` with `{ error }`. A consumer treats that, and a 404 from an
older server, as no history.

### Runtime stats (`GET /api/activity/stats`, additive in 0.37.0)

The runtime half of a stats surface. `GET /api/brain/stats` passes
`brain stats --json` through and stays the corpus channel; this route reports
what the **server's own** database holds — sessions, runs, tokens, cost — and
never reads brain.db. A consumer calls both and merges. It sits behind the
auth guard with the other `/api/activity/*` routes. `?days=N` picks the
window (default 30, clamped to 1–90). The shape is `ActivityRuntimeStats` in
`@schlessera/brain-ui-sdk/protocol`; timestamps are ms epoch:

```
{
  generatedAt,
  lifetime: { scope: "lifetime", sessions, turns, costUsd,
              firstActivityAt | null, lastActivityAt | null, elapsedDays,
              averages: { costUsdPerSession, turnsPerSession,
                          costUsdPerDay, costUsdPerMonth } },
  window:   { scope: "window", days, since, until,
              recordedSince | null, coveredDays,
              detailRetention: { days, cutoffAt, insideWindow },
              detailPrunedRuns,
              runs, failures, costUsd, effectiveCostUsd,
              unpricedRuns, unpricedListCostRuns,
              inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
              averages: { runsPerDay, costUsdPerDay, costUsdPerMonth,
                          effectiveCostUsdPerDay, effectiveCostUsdPerMonth } },
  database: { sizeBytes }
}
```

Rules a consumer may rely on:

- **Every figure is labelled with what it covers.** `lifetime` is read from
  the never-pruned session catalog; `window` from the run rollups, over
  exactly `[since, until]` — a closed interval whose upper end is enforced, so
  a run dated after `until` (a clock corrected backwards leaves such rows) is
  not summed. The two do not agree and are not meant to: the catalog predates
  the activity record, and the two count different things.
- **The window says how much of itself it can vouch for.** Rollup rows
  outlive detail pruning, so the sums are complete back to `recordedSince`
  (the oldest run in the record at or before `until`) — and no further;
  `coveredDays` is the span the per-day averages divide by.
  `detailRetention.cutoffAt` is where drill-in detail stops, `insideWindow`
  says whether that boundary falls inside the window, and `detailPrunedRuns`
  counts the runs in it that are already rollup-only. Say "detail older than
  N days is pruned"; do not present a window as a total.
- **Unknown never reads as $0, on EITHER cost axis.** Each cost sum is a sum
  of known values, and each carries **its own** excluded count, because the
  two columns are independently nullable: `costUsd` (list price) excludes
  `unpricedListCostRuns`, `effectiveCostUsd` excludes `unpricedRuns`. A
  subscription-billed run with no backend-reported cost is in the first
  counter and not the second — its effective cost is a known $0 while its
  list price is unknown. Render both the same way: "≥ $X · N unpriced" when
  the counter is nonzero, and wholly unknown when it equals `runs` — never as
  the `0` that a sum of no known values carries.
- **An average is `null` rather than a fabricated rate.** Every average is
  `null` when its denominator is zero, `costUsdPerDay`/`PerMonth` are `null`
  whenever `unpricedListCostRuns > 0`, and `effectiveCostUsdPerDay`/`PerMonth`
  whenever `unpricedRuns > 0` — a rate over a partial sum would hide the hole
  the sum shows. `lifetime.elapsedDays` is `0`, and its per-day and per-month
  figures `null`, when the catalog is empty *or* its oldest session is dated
  after `generatedAt`; the lifetime totals still include such a session, since
  it happened.
- **The route does no rounding or formatting**, while
  `GET /api/activity/rollups` rounds each completed day/job/session sum on
  both cost axes to 4 decimal places, only at the response boundary; stored
  costs retain their original precision. Over the same window the two therefore
  report `0.299997` and `0.3` for one quantity. Round at render time, identically for both, rather than treating
  either as pre-formatted. This channel stays raw on purpose: rounding a sum
  to 4 dp turns a real sub-$0.0001 cost into a `0` that reads as free.
- **`lifetime.costUsd` is a floor, and cannot be better than one.** The
  session catalog folds an unreported cost into `0` at write time, so no
  unpriced counter is recoverable at read time; `window` is the channel that
  separates unknown from zero. `lifetime.turns` has the same shape.
- `database.sizeBytes` is the logical size of the server database (pages ×
  page size, the WAL sidecar aside). It is a rebuild-cost figure for a
  disposable store, not a claim that the file holds authoritative state.

## Content-index query API

The concrete synchronous `@schlessera/brain/queries` entry supports
`readGraphMeta`, `readGraphClusters`, `readGraphNeighborhood`,
`readGraphDiscovery`, `readGraphMaintenance`, `readLinkWalk`,
`readVoiceVocabulary`, `listIndexDocuments` and `findIndexDocuments`.
Its [complete API specification](content-index-queries.md) is part of this
contract: signatures/reachable exports, validation/defaults/caps/order,
detached result and safe error envelopes, feature compatibility, read-only
per-operation snapshot lifetime and replacement behavior. Ordinary conditional
exports ship TypeScript source, JavaScript and declarations from the same build.
Supported result/behavior additions ship in a minor; changes follow this file's
versioning policy. The [SQL-boundary ruling](decisions/index-query-api.md) keeps
the direct-SQL guarantees below binding during the separate consumer migrations.
No SQL/handle/provider interface is exposed by the query entry.

The pi backend's `brain_list` and `brain_graph` use these results in process,
without loading executable config or providers for those two reads. Their
existing pi text/details envelopes, listing default `20`/cap `100`, graph
default `1`/cap `4`, direction, ordering and truncation remain unchanged.
An absent indexed graph path still returns empty `edges` and `nodes`.
Index compatibility, WAL snapshot consistency and per-call replacement checks
belong to core. Missing indexes retain the `brain index` instruction; incompatible
or corrupt indexes request `brain index --force`; busy indexes request a retry;
unavailable indexes and invalid inputs produce generic errors. Pi throws these
sanitized errors through its existing tool executor error path, never SQLite
diagnostics. Query input validation follows the linked API specification.

`@schlessera/brain/internal` is an explicitly unsupported first-party entry,
with no compatibility guarantee; use the same lockstep package version. Its
`archiveDocument`, `assembleContext`, `hybridSearch`, `indexAll`, `ingest`,
`loadVecSupport` and `openDatabase` exports serve pi's remaining search/context
and write implementation. They may accept native handles and are not supported
query APIs. This scoped classification added the internal entry and migrated
pi's imports; the [export curation](#package-entry-points) removed these
helpers from the ordinary `@schlessera/brain` entry, and moved the other
helpers pi and the modules share (path safety, scratch, generated regions,
taxonomy, context and write helpers) to the same internal entry. Modules now
take theirs from the supported `@schlessera/brain/module` entry
([package entry points](#package-entry-points)).
Existing direct-SQL guarantees remain binding until the explicit retirement.

### UI server optional core peer (breaking host migration, #697)

`@schlessera/brain-ui-server` reads the knowledge graph and the index-derived
voice vocabulary through this entry, never through its own SQL. It declares
`@schlessera/brain` in `peerDependencies` (`*`, the lockstep convention) with
`peerDependenciesMeta` marking it optional, so **a host that wants the graph
view or keyterms must now install `@schlessera/brain` itself**. Install the same
lockstep version as the server; the server accepts `>=0.40.0 <1.0.0`, 0.40.0
being the first release whose `./queries` entry ships all six operations it
calls. The [package ruling](decisions/index-query-api.md#package-access--lazy-optional-core-peer-2026-10-03)
approved this as a pre-1.0 break.

The peer is resolved lazily, once per app. Before use, the server checks that
the resolved `@schlessera/brain/package.json` names that package, that its
version is in range, that the loaded `./queries` entry belongs to the same
installation, and that each feature's operations are functions — the five
`readGraph*` reads for the graph, `readVoiceVocabulary` for keyterms. A `brain`
binary on `PATH`, handwritten SQL and a per-query subprocess are never
substitutes. Published server declarations do not reference core.

When the package check fails, every other server feature is unaffected:

- All five `/api/graph/*` endpoints, `meta` included, answer 503
  `{ "error": "graph_unavailable", "reason": "core_unavailable" }` after their
  existing parameter validation. This is a missing capability, distinct from
  any index state and never an empty graph.
- `GET /api/voice/keyterms` and the session keyterms serve an empty vocabulary,
  `GET /api/voice/overrides` keeps the markdown pronunciation overrides, and the
  degraded result is never written to the keyterm cache; a cache left by an
  earlier installation is not served while core is unusable. Providers without
  keyterm support never resolve core.
- One warning per feature records the failed check (`not_installed`,
  `identity_mismatch`, `version_unsupported`, `operation_missing`,
  `load_failed`), the required range and any observed version — no paths or
  native messages.

With usable core, index states keep their established mappings. Graph `meta`
answers 200 for every index state: core's own description of a pre-graph or
uncomputed index, and `available: false`, `reason: "schema"`, `schemaVersion: 0`
with zero counts for a missing, incompatible or corrupt index. Subgraph modes
answer 503 `graph_unavailable` with `reason: "schema"` for those, or
`"not_computed"`; an absent or malformed center/root path is 404 `not_found`. A
lock wait is 503 `{ "error": "index_busy" }`; any other failure is a sanitized
500 `{ "error": "internal_error" }`. An index that claims the graph layout without
its tables is refused as a whole, so its links-only neighborhood now degrades
with the other modes. Voice keeps the missing-index error, degrades an
incompatible index to overrides without caching, and reports a corrupt, locked
or unreadable index as an error. `writeCache` no longer persists a degraded
result for any caller, including the post-sync rebuild.

`openBrainDb`, `withBrainDb`, `BrainDbUnavailableError` and
`MIN_BRAIN_SCHEMA_VERSION` stay exported for embedders' own readers under the
direct-SQL guarantees below; the server's graph and voice paths no longer use
them.

**Migrating a host:** add `@schlessera/brain` at the server's version to the
host's dependencies (`bun add @schlessera/brain`), reinstall and restart. A
host that serves neither the graph view nor keyterm-capable dictation may skip
it. A warning naming `core.reason` at first graph or keyterm use means the
installation is absent or skewed.

## brain.db (direct SQL reads)

Prefer the CLI/MCP. If reading directly:

- Check `index_metadata` first: `schema_version` (currently **15**),
  `embedding_model`, `embedding_dimensions`, `vec_schema`, and `fts_tokenizer`
  (additive in 0.38.0): the FTS5 tokenizer `documents_fts` was built with,
  `porter unicode61` for `search.language: english` (the default) or
  `unicode61 remove_diacritics 2` for `none`. It can be absent on an index no
  run has touched since it was added; the table's own definition in
  `sqlite_master` is then the answer. A rebuild for another language writes
  the new table, all its rows and `fts_tokenizer` in one transaction. Schema 9 adds only
  an index on `links(target_id)`; no table or column changed from 8, so a
  reader that accepts 8 reads 9 unchanged. Schema 10 (0.38.0) adds only the
  column `documents.chunker_version`: the chunker version a markdown
  document's chunks came from, `NULL` for assets and for rows written before
  it existed. A reader that accepts 9 reads 10 unchanged.
  Schema 11 (0.38.0) adds only the nullable `documents.generated_from`
  column, so a reader that accepts 10 reads 11 unchanged. The migration also
  clears the markdown rows' `content_hash`, so the next index run re-reads
  every file and fills it. Schema 12 (0.38.0) adds only the table
  `supersedes` (source_id, target, target_id): a document's `supersedes`
  targets as written, and the document each resolves to (`NULL` when none),
  rebuilt by every index run like `links`. A reader that accepts 11 reads 12
  unchanged. Its migration clears `content_hash` the same way.
  Schema 13 (0.38.0) adds only the FTS5 table `chunks_fts` (heading,
  content), an external-content index over `chunks` kept in step by the
  triggers `chunks_fts_insert`, `chunks_fts_delete` and `chunks_fts_update`,
  and built from the existing chunk rows when a writable open migrates the
  database. No table or column a reader selects changed, so a reader that
  accepts 12 reads 13 unchanged. A writer that inserts, updates or deletes
  `chunks` rows keeps the index current through those triggers; it must not
  drop them. `chunks_fts` uses the same tokenizer as `documents_fts`, and a
  `search.language` rebuild recreates it from `chunks` in the same
  transaction. Schema 14 (0.38.0) recreates `documents_fts` with a fifth
  column, `aliases` (a document's aliases, one per line), and no longer
  writes them into its `tags` column. No table or column a reader selects
  changed, so a reader that accepts 13 reads 14 unchanged. The migration
  refills the table from `documents` and clears the markdown rows'
  `content_hash`, so the next index run writes each row again with its
  aliases. It also adds `name_keys` (key, document_id): each markdown
  document's title and aliases, case-folded with whitespace collapsed, the
  lookup exact-name search uses. Titles are keyed at migration; the next index
  run adds the aliases. Schema 15 (0.40.0) adds only the nullable
  `documents.verification` column: a markdown document's `verification`
  frontmatter as written when it is a non-empty string, else `NULL`. A reader
  that accepts 14 reads 15 unchanged. Its migration clears the markdown rows'
  `content_hash`, as schema 11's did, so the next index run fills it.
- Semi-stable tables: `documents` (path, title, type, status, relevance,
  content, deadline, next_review, …), `chunks`, `tags`/`document_tags`,
  `links`, and the derived graph tables `graph_metrics` (document_id,
  in_degree, out_degree, component, pagerank, community), `graph_communities`
  (community, size, label, top_terms JSON), `graph_root_distances`
  (document_id, distance, parent_id) and `graph_layouts` (mode, document_id,
  x, y). Columns are only ever ADDED within a schema_version line.
- The `graph_*` tables are **derived cache, rebuilt wholesale when graph inputs
  change** — they may be empty until the first index run on schema 8, and an
  older CLI writing to a v8 database leaves them stale rather than wrong.
  Unchanged index runs may reuse the graph and preserve its provenance and
  layout; `brain graph compute` and `brain index --force` always rebuild it.
  Internal input fingerprints are disposable and are not a consumer API.
  Their provenance lives in `index_metadata`: `graph_computed_at` (ISO),
  `graph_algo` (JSON parameters), `graph_root` (a document path, or
  `virtual:AGENTS.md` for an index-excluded entry file), `graph_root_links`
  (JSON array of document ids seeded by a virtual root), `graph_node_count`,
  and `graph_layout_skipped` (`"1"` when the corpus was over the layout cap).
  `graph_root` and `graph_root_links` are absent together when no root could be
  resolved, and `graph_layout_skipped` is absent unless the cap was hit — read
  every key as optional.
  A virtual root has no `documents` row; consumers synthesize a node with
  `id: 0` for it. Compare `graph_computed_at` against the newest
  `documents.indexed_at` to detect staleness.
- `vec_chunks` is a sqlite-vec virtual table — unreadable without loading the
  extension; do not depend on it externally. Its dimension is the width the
  stored vectors were produced at, recorded in
  `index_metadata.embedding_dimensions` (1536 on a fresh brain). Changing the
  configured provider does not re-declare the table; a re-embedding run does.
- Open read-only. Writers must set `PRAGMA busy_timeout` (core uses 5000ms).
- **Do not write to brain.db from outside** — markdown is the source of truth.

Everything above is enforced by `tests/brain-db-contract.test.ts`, which indexes
the fixture corpus with the real CLI and then reads it back with the shipped
`ui-server` readers. `schema_version` has exactly one source — `SCHEMA_VERSION`,
exported from `@schlessera/brain` — and that test fails when this document, the
`brain doctor` check, or a reader floor disagrees with it.

### Revision negotiation

The client/server wire protocol, published as
`@schlessera/brain-ui-sdk/protocol`, is a **machine compatibility contract now**,
distinct from the experimental extension interfaces. Its frames, validation
policies and documented behavior follow this document's versioning rules:

- Additive changes ship in minors.
- Before 1.0, a break ships in a minor only after a maintainer ruling recorded
  before implementation, with the `breaking` label and a changeset naming it.
- From 1.0, a break requires a major.

Every contract change needs `CONTRACT:` and a same-commit contract update.
This classification does not freeze the experimental seams or schedule 1.0.
See the [wire-protocol decision](decisions/contract-versioning.md#wire-protocol-classification--2026-09-28).

Revision negotiation determines which rules apply to a connection; incrementing
the revision does not waive compatibility guarantees or semantic versioning.
The legacy tolerance and validation policies below remain binding.

`PROTOCOL_REV` is **5**. A client announces what it speaks with a `client_hello`
as its first frame; a host that does not understand the frame ignores it, and a
client that never sends one is treated as rev 2.

That handshake is what makes a field enforceable without a flag day. A host
applies rev-3 rules only to connections that declared rev 3:

- **rev 2** — parallel sessions, host-minted `turnId`, `server_hello`.
- **rev 3** — `client_hello`, and `turnId` echoed on every interactive reply.
  A client declaring 3 MUST echo; a reply without one is refused, because it
  cannot be correlated to the turn that raised the request. Clients that
  declare nothing keep the rev-2 tolerance indefinitely.
- **rev 4** — `message_blocks` and the `blocks` field on history messages
  (additive, see below). Nothing is required of a client; one that does not
  know the frame drops it and renders the markdown it already has.
- **rev 5** — ask-answer receipts and liveness probes (see "Interactive answer
  receipts" below). This is the one rule that does **not** follow the declared
  revision: a host that advertises `askReceipts` refuses every ask answer
  without a `submissionId`, whatever the client declared (pre-1.0 break,
  #910). Nothing else changes for a client that declares an older revision.

A host must never REQUIRE `client_hello`, and must not refuse a client
declaring a revision it does not recognise — it holds it to the newest rules it
knows.

### Server → client frames

Both directions are now schema-validated at the boundary
(`@schlessera/brain-ui-sdk/schemas`). The receiving policies differ on purpose:

- A **server** rejecting a client frame answers with an `error` frame and
  counts the drop. Inbound validation is a trust boundary.
- A **client** rejecting a server frame DROPS it and reports it, never throws.
  The protocol is additive, so a client that hard-failed an unrecognised frame
  would turn every additive server change into a breaking one for older
  clients. Unknown object keys are preserved in both directions, except the new strict
  durable-inbox client commands described below. Existing frames retain their
  validation policy.

A third-party client may rely on that: adding a frame type, or an optional
field to an existing one, is not a breaking change. `BrainUiClient`
(`@schlessera/brain-ui-sdk/client`) implements this policy and is the supported
way to speak the protocol without reimplementing it.

### Durable Queue and Actions (additive)

The SDK defines the durable inbox wire shapes separately from Activity's
notification acknowledgement inbox. A host advertises optional
`server_hello.capabilities.inbox: true` only when durable subscriptions are
implemented. Missing/false means unsupported. Clients explicitly opt in with
`inbox_subscribe { view: "queue" | "actions", threadId? }`; the matching
`inbox_unsubscribe` ends that view/filter subscription. No `client_hello` or
new capability declaration is required for existing chat/Activity flow.
`createApp()` implements this stream on its existing authenticated WebSocket.
A `WsHost` without an attached inbox omits the capability and answers subscribe/
unsubscribe with `INBOX_UNAVAILABLE`; ordinary chat and Activity negotiation
keep their existing behavior.

`inbox_snapshot` contains the view/filter, `threads`, `items`, per-thread
`highWaterSeq`, global `cursor`, and optional `append` for chunk continuation.
The server-frame parser preserves every own scalar `highWaterSeq` entry,
including identifiers named `__proto__` or `constructor`, as data properties
without replacing the map's prototype. Values follow the existing snapshot
validator: Inbox requires nonnegative safe integers; Activity requires finite
numbers. Invalid values fail the frame even under a prototype-named key.
`inbox_delta` contains its view and one `InboxChange`. Changes carry an explicit
`threadId`, global `changeId` and per-thread `seq`; `upsert_thread` carries the
thread, `upsert_item` carries `itemId` and the item, `remove_item` carries
`itemId`, and `remove_thread` needs no joined row. Clients discard deltas
before a snapshot and at/below that thread's high-water mark; reconnect
starts a fresh snapshot. The server captures rows, high waters and cursor in
one read transaction. Every subscription owns that boundary; a later subscriber
cannot advance the shared change scan past deltas owed to an earlier subscriber.
A 100 ms poll while subscribed discovers writes from other database connections.
Each pump scans at most five batches of 200 changes; later ticks continue the
backlog. Overlapping subscriptions on one socket receive each delta once per view.

Snapshots include all live threads and that view's items. A `threadId` filter
restricts threads, items and high waters to a currently existing thread; a
missing/deleted thread yields `INBOX_SCOPE_NOT_FOUND` rather than a global
subscription. Thread updates and tombstones reach both views; item upserts
reach their own view. Item tombstones carry scope without joining a deleted row.
An item's optional `runId` is display correlation, never a client-selected
access filter. Strict subscription schemas refuse injected run/authority fields.

Snapshot chunks and deltas preserve complete records within 512,000 UTF-8
bytes, including their envelope. The first chunk replaces a projection; subsequent
`append: true` chunks merge rows and high-water entries at the same cursor.
The high-water map is itself chunked. All chunks precede that subscription's
deltas. Clients merge high-water entries from every continuation. A single
record exceeding the limit produces `INBOX_FRAME_TOO_LARGE` and closes the
connection with code 1009; the server preflights every snapshot chunk before
sending its first frame. It never clips a field or silently omits a row.
A connection permits 64 distinct view/filter subscriptions; further scopes
receive `INBOX_SUBSCRIPTION_LIMIT`. Repeating a scope sends a fresh snapshot.

Subscriptions bind to the server-owned authorization context, using the
existing single-owner principal model. Delivery and idle polling recheck the
durable principal for revocation/expiry; unusable principals receive no further
operational records and close with 1008. Explicit revocation, socket close,
unsubscribe and application close release subscriptions and authorization
leases. With no subscribers the inbox poller stops. A dropped/throwing transport
ends the connection (1011), allowing recovery through a fresh snapshot;
queued backpressure remains a valid delivery.

Threads carry immutable server-assigned `trustClass` (`trusted`/`untrusted`),
`source` (`share`/`cli`), `status` (`open`/`closed`), the derived `stateMd`
projection (4 KB UTF-8 maximum), stakes (0–3), optional deadline, and creation/
last-seen times. Item metadata carries identity, thread, dedup key, creation/
update/expiry times, version, optional wait time and Activity run ID. All times
are UTC epoch milliseconds. Queue items (`triage`, `execute`,
`cleanup_pending`) carry attempt/lease/block metadata and use only
`scheduled | ready | claimed | done | blocked | failed | superseded | expired | dropped`.
Actions (`approve`, `choose`, `fyi`) carry title/detail and stored options,
and use only `pending | snoozed | resolved | dismissed | expired | dropped`.
FYIs carry no options. The store owns guarded transitions, and the concrete
server engine composes checkpoint/Action/block and final resolution/follow-up
transactions without an inference call.

Each option carries a closed `ResolutionEffect`:

| Kind | Payload | Availability |
| --- | --- | --- |
| `enqueue` | `payload { instruction, operation? { toolName, input, targetPath } }` | v1 |
| `cancel_blocked` | No additional fields | v1 |
| `snooze` | No additional fields; timing is server-derived | v1 |
| `dismiss` | Optional `reason` | v1 |
| `write_policy` | `policy { slug, content }` | Deferred v2 data only |
| `open_session` | `seed { prompt }` | Deferred v2 data only |

`V1ResolutionEffect` and `v1ResolutionEffectSchema` exclude both deferred
kinds. `resolutionEffectSchema` describes all six kinds as data; it is not
an execution validator. `inboxOperationSchema`, `inboxWorkPayloadSchema`,
`inboxOptionSchema` and effect schemas reject unknown fields, including trust,
profile, principal and tool-policy injections. Arbitrary tool input is inert
JSON and also rejects nested authority fields. `targetPath` must be a canonical
brain-relative path. `validateResolutionEffect(value, allowedOperations)`
validates v1 data and binds any requested operation to one exact server-owned
tool/input/target tuple, independent of JSON object key order. The server must
revalidate current principal/thread authority at creation and application;
this helper neither grants permission nor proves filesystem/egress containment.
An instruction without an operation remains inside the restricted envelope.

Clients send `inbox_resolve { itemId, optionId, reason? }` to select a stored
option, or `inbox_snooze { itemId }` to request deterministic snooze. They cannot
submit effects, scheduling overrides or authority. Reasons are optional
`dont_ask_again | wrong_call | need_more_info | no_longer_relevant` feedback,
never standing grants. These four new client frame schemas are strict,
including subscribe/unsubscribe. New server projections preserve unknown keys
recursively for additive display compatibility; applying any displayed effect
requires the strict v1 validator again. The actual client/server parsers cover
all new frame kinds. `createApp()` now handles both decision frames on its
authenticated WebSocket. It checks durable principal usability and raw stored
v1 effects, and revalidates the current server-owned exact-operation envelope.
Absent engine authority is an empty envelope, so operation-bearing approval
fails closed. Refusal uses the existing error envelope with
`INBOX_DECISION_REFUSED`; a host lacking a decision handler returns
`INBOX_UNAVAILABLE`. Committed changes use the existing subscribed deltas.

Final resolution is write-once per Action. Only enqueue creates one follow-up
identified by Action/option; cancel/dismiss supersede blocked work and create
no executable item. Matching replay returns the existing result; a different
option or feedback cannot replace it. Snooze remains nonterminal, creates no
resolution or model call, and preserves Action/blocked-work retention through
resurface. Low stakes use 08:00 next weekday; higher stakes use bounded
one-to-eight-hour backoff. Times remain UTC, using the configured inbox budget
timezone or UTC by default. Dismissal is valid without a reason.

The default cap is 60 pending/snoozed decisions, excluding non-evictable FYIs.
Lowest-priority eviction includes the incoming candidate and atomically
supersedes its blocked work, emits one FYI/suppression and journals staging
compensation. Expiry, bounded retries and compensation are deterministic
maintenance. Filesystem removal occurs after commit and is idempotent across
restart. See [the Action engine](inbox-actions.md) for lifecycle details.
This behavior enables no unattended dispatcher, policy formation or session
creation; the full-v1 containment and system-proof gate remains required.

### Action notices (additive, #683)

Durable waiting decisions reach their recipients under the
[Action notification decision](decisions/action-notifications.md); the
[inbox notifications guide](inbox-notifications.md) describes the runtime.

- **Push payload.** Web push for Actions uses the existing generic payload
  `{ title, body, tag, url }`: `title` is `"N actions waiting"` (`"1 action
  waiting"`), `body` is `"Open Actions to decide."`, `tag` is
  `"brain-actions"` and `url` is `"/#/activity"`, the Actions destination. No
  thread content, option or credential is included. The SDK push handlers
  display it unchanged; a notice grants no authority and resolves nothing.
- **Registration input.** `POST /api/push/subscribe` accepts an optional
  `timeZone` string. The server validates it against its own zone database
  and stores the canonical name for that device; an unusable value is stored
  as missing and never fails the subscription. Omission keeps the device's
  last reported zone.
  `GET /api/push/subscriptions` adds `timeZone: string | null` to each summary.
  The SDK `registerPushHandlers` renewal now sends the worker's zone.
- **Client context.** A client context is the authenticated principal plus
  an optional client identifier (`[A-Za-z0-9_-]{1,64}`) the browser persists,
  because one principal can serve several browsers. It keys the reported
  zone, digest coverage and dismissal; it grants nothing. Omitted, the
  context is principal-wide.
- **Zone refresh.** The internal `POST /api/push/zone`
  `{ timeZone, endpoint?, clientId? }` refreshes that client context's zone
  and, only when the caller owns it, that endpoint's. It answers
  `{ ok: true, timeZone: string | null }`; a malformed `clientId` is a 400.
  The server stamps its own clock; no client time is accepted.
- **In-app digest.** The internal `GET /api/activity/digest?client=<id>`
  response adds `actions?: ActionDigestState` for that client context:
  `{ status: "zone_required" }` without a usable zone, otherwise
  `{ status: "ready", timeZone, latest: ActionDigestSummary | null,
  dismissedAt: number | null }`. `POST /api/activity/digest/dismiss?client=<id>&through=<generatedAt>`
  also records that context's own Actions dismissal, advancing it only
  through the displayed summary so a later one stays visible; the global
  activity dismissal marker is unchanged.
  `ActionDigestSummary` is `{ generatedAt, slotAt, timeZone, waiting, updates }`,
  exported with `ActionDigestEntry` and `ActionDigestState` from
  `@schlessera/brain-ui-sdk/protocol`. `waiting` lists new or reawakened
  below-cutoff decisions (`{ itemId, threadId, title, episodeId }`); `updates`
  lists new FYIs. Generation is not a delivery or read receipt.
- **Persistence.** Migration `031_inbox_notifications.sql` adds the episode,
  window, constituent, attempt, digest and coverage relations and the
  `push_subscriptions.time_zone` columns. They are authoritative operational
  state, included in the operational backup and the store's export.

Existing activity intents, their payloads, suppression, retry and digest
coverage are unchanged.

### Activity stream (rev 3, additive)

Hosts that record agent activity advertise `capabilities.activity` on
`server_hello`. A client opts in per view with `activity_subscribe`
(`index` | `session` | `run`) and receives `activity_snapshot` then
`activity_delta` frames; a server never sends activity frames to a connection
without a matching subscription. Ordering: a snapshot carries per-run
high-water `seq`, every delta carries its `seq`, and the client discards
deltas at or below the snapshot's high-water for that run. Deltas are
append-only increments (a small span row, or exactly one event) — they never
grow with run length. The `result` frame additionally carries an optional
`usage` block (token totals + per-model breakdown; absent cost means unknown,
never zero), and `tool_use_start` an optional `parentToolUseId` marking tool
calls that ran inside a subagent. Activity spans may carry the additive
`principalId` of the actor responsible for them; absence means unattributed.
Each human tool response also appends an `approval_decision` event whose payload
records `principalId`, `decision` (`allow` | `always_allow` | `deny`), and
`requestKind` (`tool` | `command`), preserving every responder when one tool
raises more than one approval. The payload additionally carries `channel`
(`card` | `voice`, additive in 0.37.0) when the `tool_approval` / `tool_denial`
frame named the channel the decision was made on; absent means the client did
not say, and such a decision is stored exactly as before. A `tool_approval`
attributed to `voice` is refused — the request stays pending, nothing is
recorded, and the `tool_approval_request` is sent again to the connection that
replied, so its next answer is correlated — because the voice channel may deny and never grant
([decisions/voice-permission.md](decisions/voice-permission.md)), so a
voice-attributed grant in the record is by construction a bug.
An answered `ask_user`, `ask_user_list` or `ask_user_rank` interaction appends an
`ask_user_response` event carrying the responder's `principalId`.
A run's root span may additionally carry what the backend's runtime reported
about itself (additive in 0.37.0): `brain.runtime.name` / `brain.runtime.version`
(the runtime that actually ran, e.g. `claude-code` / `2.1.278`),
`brain.sdk.name` / `brain.sdk.version`, `brain.runtime.measured` (whether that
pair is the one the backend's behaviour was measured against), `brain.credential`
(the credential fields the runtime selected, in its own names),
`brain.billing_observed` (`subscription` | `api` | `unknown`, derived from that
credential) and `brain.billing_policy` (what the run's profile requires). When
the two disagree the root also carries `brain.billing_policy_violation` (a
sentence) and a `billing_policy_violation` event. A run that failed to
authenticate carries `brain.failure_class` (the runtime's own class, e.g.
`authentication_failed`, or `subscription_required` when the backend refused
the turn before sending it) and an `auth_failure` event. Absent means the
backend did not report it; older clients may ignore all of them.
A scheduled `brain sync` run (a `cron` root span with `jobName` `sync`,
written by the in-process scheduler or the container cron wrapper; additive in
0.40.0, #290) carries `brain.sync.agent`: `not-invoked`, `invoked`, or
`unknown` when the run ended without a readable `brain sync --json` result.
It may also carry `brain.sync.run_status` (the result's `run.status`),
`brain.sync.agent_reason` (`not-needed` | `no-runner`), and for an invoked
agent `brain.sync.agent_runner` and `brain.sync.agent_outcome` (`success` |
`failed`). `brain.runtime.name` / `brain.runtime.version` mean what they mean
on a chat run, and are set only from that sync run's own result: an agent not
invoked, a runtime that did not report, a version it did not give, and an
unreadable result write none. A span still open has none of these yet.
Authenticated `GET /api/status` reports them as `runtime.sync` beside chat's
`runtime.lastObserved`: `latest` is the most recent sync run
(`{ runId, startedAt, endedAt, outcome, agent, runtime }`, `agent` also
`pending` while the run is open, `runtime` null when that run recorded none),
and `lastObserved` is the most recent sync run that recorded a version
(`{ runId, startedAt, endedAt, runtime: { name, version }, latestRun }`,
`latestRun` false when a newer run did not). Either is null when no such run
is in the activity record; the runtime is read from what ran, so it may differ
from chat's.
Run summaries and rollups may additionally carry `principalId`,
`principalLabel`, and `principalKind`. The label and kind are immutable
historical snapshots taken when the rollup is first written, so consumers must
not join them back to the live principal record or expect later label changes
and principal pruning to rewrite history. Older clients may ignore all three
fields.

### Classified blocks (rev 4, additive)

A host may run a classification pass over a finished turn's assistant text
(D42): a deterministic walk finds candidates — a GFM table, an ordered list,
a bullet list whose items open with a time, a blockquote, a run of
key-colon-value lines — and one call to a classifier decides which of the
kit's answer blocks each candidate is, if any. What comes back is one
`message_blocks` frame, sent AFTER the turn's `result` and only when at
least one block was classified:

```
{ type: "message_blocks", sessionId, blocks: MessageBlock[] }
MessageBlock = { partIndex, start, end, block, confidence }
```

`partIndex` is the block's ordinal among the message's `text` parts;
`start`/`end` are character offsets in that part's text, end exclusive; the
client cuts the part at the span and renders `block` there. `block` is the
same union `show_block` carries, so a consumer renders both with one
component. `confidence` is the classifier's, 0–1, already above the host's
threshold. Replayed history carries the same objects on
`SessionHistoryMessage.blocks`, joined by the host from what it persisted,
so a consumer never classifies twice.

Rules a consumer may rely on:

- **The pass is progressive enhancement.** A turn's `result` never waits on
  it; the frame is absent, not late, when the classifier is unconfigured,
  times out (the host's budget is two seconds), errors, or answers below
  threshold. A consumer that renders markdown and ignores the frame is
  correct.
- **Spans are exact for the text the host saw.** A span that does not fit
  the text a consumer holds must be ignored, never rendered blank.
- **Blocks contain only what the text carried.** The classifier chooses a
  shape and a tone; it never invents a footnote, a figure, or a source line.

### Per-message reasoning effort (additive, #543)

`chat_message.thinkingLevel?: ThinkingLevel` overrides effort for that message
only, including a resumed session. Its seven values are `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, and `max`; an invalid value is rejected by
frame validation before routing or backend execution. `StartTurnRequest`
accepts the same optional field. Each turn resolves request override → saved
profile override → configured profile/backend default → backend default.
Effort is re-read on resumes; model/session ownership remains pinned.

Claude's built-in profile uses `claude-opus-5-5` at `medium`. The Claude module
accepts `config.defaultThinkingLevel` beside `defaultModel`; the shipped host
sets it from `BRAIN_UI_CLAUDE_DEFAULT_THINKING_LEVEL` (default `medium`).
Declared profiles can supply `thinkingLevel` and `supportedThinkingLevels`.
Claude passes the resolved supported choice as the Agent SDK's `effort`.
`off` and `minimal` map to `low`; otherwise an unsupported choice resolves to
the nearest lower supported level, or the lowest supported level. Pi uses the
same downward resolution before setting its session effort, without writing
the global default. Unknown effort-less models omit the option.

`ProviderInfo` and `ModelCatalogEntry` optionally carry
`supportedThinkingLevels: ThinkingLevel[]` and the effective default
`thinkingLevel`. Claude now exposes these too, and `PUT /api/models/thinking`
accepts effort-capable Claude profile ids. A saved unsupported override stays
in `thinkingOverride`; `thinkingLevel` reports what it resolves to. Discovery
uses Models API effort capabilities; absent metadata uses conservative known
model capabilities. A proxy/unknown model may declare its supported choices.

Hosts supporting this path advertise `server_hello.capabilities.chatRequestAck`.
An optional `chat_message.requestId` is echoed on `session_info` when that turn
starts, on `status: queued` when parked, and on correlated refusals (`error`).
It is correlation, not durable deduplication. Clients clear a sent draft and
its override only on matching acceptance; a refusal keeps them. Messages with
`requestId` or `thinkingLevel` sent during a run queue as distinct next turns,
so they cannot alter a running turn's effort. Older messages without either
field retain native follow-up behavior. Clients on older hosts omit these
fields and keep their prior send behavior. If acceptance cannot be confirmed
across a disconnect or an uncorrelated frame refusal, the draft and override
remain editable with an explicit unconfirmed-send notice; reconnection never
resends them automatically.

`session_info`, effort-reporting `status` frames, and replayed user
`SessionHistoryMessage` may carry the requested `thinkingLevel` and a
runtime-confirmed `effectiveThinkingLevel`. Absent effective effort means
unconfirmed, not equal: consumers render “requested” until confirmed. Pi reads
its actual session level; Claude observes the main-turn Stop hook's active
effort after managed settings clamp it. Default-effort messages omit this
provenance. The host keeps it beside message source metadata in its UI database
and joins it on replay by exact text and ordinal. Retry retains the original
effort override; an accepted `retry_receipt` may echo `thinkingLevel` for the
new user row. No wire revision or required field changes.

### Message source (additive in 0.39.0)

`chat_message` may carry `source` — `typed` | `voice-dictate` |
`voice-conversation` — saying how the user produced the message. The host
keeps it beside the session and returns it as `source` on the replayed
`role: "user"` `SessionHistoryMessage`, so a dictated message still reads as
dictated after a reload or on another device.

- **Absent means `typed`**, in both directions: a client that does not send
  it is stored as typed, and a consumer that finds no `source` on a history
  message treats it as typed. A consumer that does not know the field
  ignores it.
- **A value the receiver does not know reads as absent.** It never costs the
  frame: a host still runs the message, and a client still renders the
  history.
- **The join is by text.** The host matches a replayed message to what it
  stored by the session, the exact text the backend replays, and the
  message's ordinal among identical texts. A message whose replayed text is
  not what the client sent (a pi `/skill:` or prompt-template command, which
  pi stores expanded) comes back without `source`.

### Local exchanges (additive in 0.40.0)

A command the client answers itself, without a turn (`/stats`), can be kept
as part of the session (#582). The exchange is
`LocalExchange = { id, command, prompt, answer, context }`: `id` is
client-minted (`[A-Za-z0-9_-]`, at most 128), `command` names it (`stats`),
`prompt` is the user's side as the transcript shows it (`Stats`), `answer` is
JSON the command owns and the host never reads (at most 64,000 characters
serialized), and `context` is the same figures as plain text for the agent
(at most `MAX_LOCAL_CONTEXT_CHARS`, 4,000, and never containing
`</local-answer>`).

```
client → { type: "local_exchange", sessionId, exchange: LocalExchange }
server → { type: "local_exchange_result", sessionId, exchangeId, saved, reason? }
chat_message.localExchanges?: LocalExchange[]          // at most 8
SessionHistoryMessage.localAnswer?: { exchangeId, command, answer }
```

- **An existing session** records an exchange with `local_exchange`. The
  host answers the sending connection with `local_exchange_result`;
  `saved: false` means the exchange is not part of the session, and a
  consumer must say so rather than drop it silently.
- **A new conversation** sends its exchanges as `localExchanges` on the
  `chat_message` that starts it. The host records them once `session_info`
  names the session and sends each client a `local_exchange_result`, which
  names the exchange by id, not by the transcript it lands in.
- **The agent sees an exchange once**, with the next prompt the host hands
  the backend in that session: its `context` travels in a
  `<local-answer command="…" id="…">` block after the user's text. From then
  on it is in the backend's transcript like anything else the user said.
- **Replay puts it back where it happened.** The host strips the block from
  the user message that carried it and replays the exchange just before that
  message: a `role: "user"` message whose `content` is `prompt`, then a
  `role: "assistant"` message with empty `content` and `localAnswer`. An
  exchange no prompt has carried yet replays at the end. A consumer that
  does not know `localAnswer` shows an empty answer; a session with no
  exchanges replays exactly as it did before they existed.
- **Recording an id twice keeps the first**, so a client may resend an
  exchange it is unsure was kept.

### Turn failures (additive in 0.40.0)

A turn whose model call failed says so on its terminal frame, in one shape
for every backend (#575). A turn that is retrying a failed call says that
while it runs.

```
TurnFailure = { errorClass, status?, message, authAction?, attempts?, resetsAt? }
TurnRetry   = { attempt, maxAttempts?, delayMs?, errorClass?, status? }

result.failure?: TurnFailure                  // on outcome: "error" only
error.failure?: TurnFailure                   // a bare error that ends a turn with no session
status.retry?: TurnRetry                      // on status: "thinking"
SessionHistoryMessage.failure?: TurnFailure   // on the assistant message the failure ended
```

- **`errorClass`** uses the Claude Agent SDK's class names
  (`authentication_failed`, `rate_limit`, `overloaded`, `invalid_request`,
  `model_not_found`, `server_error`, …), plus `subscription_required` for a
  turn the backend refused before sending it. `worker_host_unsupported` means
  the host refused before runtime initialization because its required worker
  boundary probe failed; the message names the requirement and the verified
  Linux/qualifying WSL2 route. It creates no backend session or transcript.
  It is free-form, so a new value
  is not a breaking change. `unknown` means the backend could not tell, and is
  never a guess. **`status`** is the provider's HTTP status. Absent means
  unknown, not "no status". **`message`** is the runtime's own text.
- **`authAction`** is set only on a Claude subscription's auth failure:
  `relogin`, `check_account` or `check_config`, as
  `subscriptionAuthAction(errorClass)` maps it, with
  `SUBSCRIPTION_AUTH_INSTRUCTIONS` for the wording (exported from
  `@schlessera/brain-ui-sdk/protocol`, and still from `/server`). A profile
  that bills its own API credential never gets one.
- **`attempts`** is a positive integer of observed retries before the terminal
  failure, not a guessed total including an initial call. Claude counts the
  turn's `api_retry` observations; pi keeps the last `auto_retry_start.attempt`
  it reports. No retry observation means the field is absent, including on
  unrecorded legacy history. A later successful turn carries no failure.
- **`resetsAt`** is an observed limit reset in epoch milliseconds (a nonnegative
  safe integer). Claude reads it only from a rejected `rate_limit_event` in
  that turn and converts the runtime's epoch seconds to milliseconds. It never
  derives a reset from retry delays. pi reports no reset time, so omits it.
  Absent means unknown; a reported past reset remains the observed timestamp.
- **One failure is reported once.** It rides the turn's terminal frame, and
  no other frame of the turn carries it. A diagnostic `error` sent before the
  `result` does not carry it. A consumer that shows both the diagnostic and the
  terminal failure must show them as one.
- **A partial answer is kept.** Text streamed before the failure stays the
  turn's text. `usage` and `costUsd` on a failed turn are what the turn spent,
  counted once.
- **`retry`** fields are present only when the runtime reported them.
  `detail` on the same frame says the same thing in words ("Retrying
  (attempt 2 of 10) in 5s after rate_limit, HTTP 429"), for a client that does
  not read `retry`.
- **Replay** carries `failure` on the assistant message the failure ended,
  after any partial answer, with the failure's text removed from `content`.
  The host retains the live terminal failure in its own UI database and joins
  it before inserting local exchanges or classified blocks. The key is the
  session, backend and assistant ordinal in that backend's normalized history,
  observed after the turn settles; it is not a text hash or host turn count.
  An ordered transcript-prefix digest and exact fallback failure text guard
  the position against changed transcripts. Identical failure texts at separate
  positions keep their own class, status, message, `authAction`, observed
  `attempts` and `resetsAt`. Reconnect
  history waits for the in-flight write; metadata survives host restart.
  A turn with no new stored assistant, or a read/write failure, retains the
  backend fallback rather than relabeling an older answer. Sessions without
  host records also retain that fallback. Claude recognizes its runtime's
  `<synthetic>` API-error messages by wording: the fallback can be `unknown`,
  with status/auth action only where the text supplies them. pi replays its
  failed answer's text and omits attempts that pi retried.
- **Tolerance.** A client that does not know these fields behaves exactly as
  before. A client that validates with `@schlessera/brain-ui-sdk/schemas`
  drops an unreadable `failure` or `retry` and keeps the frame, because the
  frame is a turn's terminal. An unreadable `attempts` or `resetsAt` is dropped
  independently while keeping the rest of the failure and its frame.

### Manual retry receipts (additive in 0.40.0)

```
result.retryOfTurnId?: string
SessionHistoryMessage.retryOfTurnId?: string
client → { type: "retry_turn", sessionId, failedTurnId, requestId }
client → { type: "retry_status", sessionId, requestId }
server → { type: "retry_receipt", sessionId, requestId,
           state: "accepted" | "refused" | "unknown", message?,
           text?, attachmentCount?, source? }
```

A handle identifies the latest failed turn whose original request the host
retains. It is absent when that request is unavailable, another input was
accepted, native follow-up injection made it ambiguous, or an unclassified
failure already received one manual retry. Historical cards cannot resend.
The host binds eligibility to the original principal and session. It retains
only one eligible request per session in the UI catalog, including original
image bytes, client options and the effective prompt. The next accepted
input removes those bytes; deleting the catalog session cascades them.

Retry starts a distinct turn in the same session. Prior actions may run
again: this is no rollback or guarantee against repeating tool effects.
Before dispatch the host atomically consumes eligibility and persists a
receipt. Repeating the same request id returns its receipt without executing
again. `accepted` means accepted for dispatch, not successful execution; a
host interruption can occur after recording it and before execution.
`refused` means this request was not dispatched. `unknown` means the host
cannot confirm its delivery, not that it was never sent.

Only the initial acceptance carries `text`, `attachmentCount` and `source`
for the client's new user row; receipts retain no prompt or image bytes.
After a lost acknowledgement, clients query `retry_status` with their stored
request id and reconcile accepted delivery through `session_resume`.
They must not blindly resend an unconfirmed request. Receipt lookup is bound
to the caller and session; another principal receives `unknown`.
Unreadable optional handles are dropped while preserving the failure frame.
Older peers ignore these additions and show the failure without Retry.

### Cross-backend handoff (additive, #61)

A session never changes backend. Continuing it on another backend creates a
new linked session seeded with a reviewed summary and brain-file references
([decision](decisions/session-handoff.md)).

```
HANDOFF_MAX_CHARS = 4000            HANDOFF_MAX_REFERENCES = 8
HANDOFF_DRAFT_MESSAGES = 6          HANDOFF_REFERENCES_HEADING = "References:"
chat_message.handoff?: { handoffId, sourceSessionId, references: string[] }
client → { type: "handoff_prepare", handoffId, sourceSessionId, turns }
client → { type: "handoff_prepare_cancel", handoffId }
client → { type: "handoff_status", handoffId }
server → { type: "handoff_draft", handoffId, state: "ready" | "failed" | "cancelled",
           text?, message?, runId?, costUsd? }
server → { type: "handoff_receipt", handoffId, state: "created" | "pending" | "none",
           sessionId? }
MessageSource adds "handoff"
ChatSession.handoffFrom?: { sessionId, title, backendId?, afterTurns? }
```

- **Creation.** `chat_message.handoff` is honored only on a message without
  `sessionId`, attachments, files or local exchanges, with nonempty `text` of
  at most `HANDOFF_MAX_CHARS` and a `providerId` whose backend differs from
  the source's. `handoffId` matches `[A-Za-z0-9_-]{8,128}`. Before anything
  starts, the host checks that the source session is in its catalog and that
  every reference is an existing browseable brain file (contained, no dot
  segment, no database or lockfile). Any failure is an `error` frame with code
  `HANDOFF_REJECTED`, the request's `requestId` and a readable `message`; no
  session or turn exists. Otherwise the destination starts through ordinary
  routing and permissions as a new session, with `source: "handoff"`. Its
  first user message is exactly `composeHandoffText(text, references)`: the
  text, then a blank line, `References:` and one `- path` line per reference
  (none when there are no references). `parseHandoffText` splits it back.
- **Idempotency.** `handoffId` is a unique key on the destination. A repeated
  key whose destination exists answers `handoff_receipt` `created` with that
  `sessionId`; one whose creation is still in flight answers `pending`.
  Neither starts a session or turn. `handoff_status` answers the same receipt
  without creating anything; `none` means nothing exists for the key, so a
  retry with the same key is safe. A refused or failed creation leaves `none`.
  `session_info` for the destination echoes the request's `draftId` and
  `requestId` as for any new conversation.
- **Preparation.** `handoff_prepare` runs one model summary of the first
  `turns` turns of the source (its replayed history up to, not including, the
  next user message) on the source session's own
  backend and stored profile. The run is nonpersistent and toolless (the
  autonomous turn posture with no allowed tools), creates no session, and
  answers only the requesting connection. Its `handoffId` names the run; the
  matching `handoff_draft` carries it back, and `handoff_prepare_cancel`
  stops it. A running preparation counts against the host's concurrent-session
  cap for every admission, including ordinary chat and retries, until its
  backend run has unwound. `ready` carries the summary, at most `HANDOFF_MAX_CHARS`.
  `failed` (including a backend without autonomous-turn support, a busy host
  or a timeout) and `cancelled` carry none. Closing the connection aborts its
  runs. Activity records it as a run named `handoff preparation` on the source
  session; its cost joins the source's `totalCostUsd` without adding a turn.
  `costUsd` is absent when unknown and never reported as zero for an unknown
  price.
- **Links.** `GET /api/sessions` sets `handoffFrom` on a destination:
  the source id, its title, its backend when known, and `afterTurns`, the
  number of source user messages (turns) when it was handed off (absent when
  unreadable). Both boundaries count turns because a live client and a replay
  may split one reply into different numbers of assistant messages. A source's forward links are the sessions naming it.
- **Nothing transfers.** No native history, pending approval, remembered grant
  or running work moves to the destination, and creating it grants no tool
  permission. The source's history, backend, accounting and usability are
  unchanged.
- **Tolerance.** Older hosts ignore the field and frames: a handoff
  `chat_message` starts an ordinary new chat, and the client receives no
  `handoff_*` frame. Older clients drop the new frames, read `source:
  "handoff"` as absent and show the first message as text.

### Unavailable profiles (additive, #1044)

A backend may report profiles it is configured with but cannot run now
(ruled 2026-10-06 on #1044: a separate optional roster, closed reason enum).

```
PROFILE_UNAVAILABLE_REASONS = ["needs-credentials"]
AgentBackend.listUnavailableProfiles?(): { id, label, reason }[] | Promise<…>
GET /api/providers → { providers, backends, unavailable?: { id, label, reason, backendId }[] }
```

- **Apart from the roster.** `providers` and `listProfiles()` keep meaning
  "runnable now"; routing, the handoff resolver and every existing consumer
  are unchanged. An unavailable id is never a valid `providerId`. The member
  is optional on the existing `AgentBackend` interface, not a new seam; a
  backend without it reports none. Claude reports a profile whose required
  environment key is missing as `needs-credentials`; pi lists every configured
  profile and omits the member.
- **Closed reason.** The host keeps only `id`, `label` and a `reason` in
  `PROFILE_UNAVAILABLE_REASONS`, adds the reporting `backendId`, drops any
  other entry and filters hidden profiles. No backend free text, such as a key
  name, reaches the client, which owns the copy (`needs credentials`) and shows
  a reason it does not know generically. A new reason is an additive change.
  A backend whose report throws reports none; the roster is unaffected.
- **Tolerance.** `unavailable` is absent when empty, so the response is
  unchanged for hosts with nothing to report. Older clients ignore it. The
  handoff sheet lists these profiles on other backends, disabled, with their
  reason ([decision](decisions/session-handoff.md#profiles-that-cannot-run)).

### Tool resolution receipts (additive, #957)

```
server_hello.capabilities.toolResolution: true
client_hello.capabilities.toolResolution?: boolean
server → { type: "tool_resolution", toolUseId, sessionId?, turnId?,
           outcome: "granted" | "denied" | "expired" | "unknown",
           channel?, reason? }
```

Sending `tool_denial` is not confirmation of a denial. A host that advertises
`toolResolution` sends `tool_resolution` only to connections whose
`client_hello` declared the same flag; a client that does not declare it
receives exactly the frames it received before. `turnId` is the turn that
raised the request.

- **granted** / **denied** — a card or reply settled the request. Every
  opted-in connection is told, including the one that answered. `channel` is
  the decision's channel.
- **expired** — the turn ended first (cancel, timeout, session end) and
  resolved the request itself. No `tool_result` is required or implied; a
  client clears the card on this frame. `reason` is the host's reason.
- **unknown** — a reply matched nothing the host holds: the id was never
  pending, its outcome was evicted, or the reply's `turnId` names a different
  turn (a stale echo from before a reconnect). It never applies the reply to
  a replacement request.

A `tool_approval` or `tool_denial` that applies to no pending request is
answered to its sender with the settled outcome when the echoed turn matches,
and `unknown` otherwise. A spoken denial that loses to a card grant is
therefore told `granted`; the grant is never undone or reported as refused.
A voice-attributed grant is still refused and produces no resolution: the
request stays pending and its card is re-sent. The host retains the last 512
settled outcomes. Approval and denial semantics are otherwise unchanged.

### Live conversation (additive, #957)

A separately registered live-conversation provider runs a bidirectional voice
session beside dictation, whose `SpeechProvider`, `AsrClient` and
`/api/voice/session` keep their meaning. The [decision](decisions/live-conversation.md)
and [specification](live-conversation-investigation.md) give the reasoning;
this section is the contract. The host owns semantic commit, admission, the
agent backend, tools, permissions, cancellation and every identity. Provider
text, native call ids and generated speech are evidence, never authority.

**Registration and discovery.** `CreateAppOptions.conversationProvider?:
LiveConversationProvider` (`@schlessera/brain-ui-server`) registers one
provider by value; it is validated at startup and an invalid one throws. Only
then does `server_hello` carry `capabilities.liveConversation: true`. Without
one, every `conversation_*` frame is answered with `error` code
`CONVERSATION_UNAVAILABLE`. No existing frame, route or rev-3 rule changes,
and `PROTOCOL_REV` stays 4.

```
client → { type: "conversation_start", conversationId?, sessionId? }
client → { type: "conversation_audio", conversationId, epoch, utteranceId,
           sequence, rate, pcm }
client → { type: "conversation_endpoint", conversationId, epoch, utteranceId }
client → { type: "conversation_commit", conversationId, epoch, utteranceId,
           requestId, text }
client → { type: "conversation_playback", conversationId, epoch, outputId,
           playback: "played" | "discarded" | "unknown", playedSamples? }
client → { type: "conversation_stop", conversationId }
server → { type: "conversation_opened", conversationId, epoch, sessionId?,
           providerId, capabilities, disclosure, limits,
           resync: { work, outputs } }
server → { type: "conversation_closed", conversationId, epoch, reason, message? }
server → { type: "conversation_event", conversationId, epoch, event }
server → { type: "conversation_work", ...ConversationWorkReceipt }
server → { type: "conversation_output", conversationId, ...ConversationOutputRecord }
server → { type: "conversation_permission", conversationId, epoch, sessionId,
           turnId, toolUseId, toolName, announce }
```

**Capabilities are evidence.** `capabilities` has seven keys —
`nonblockingWork`, `manualEndpoint`, `finalTranscript`,
`remoteOutputCancelAck`, `exactPermissionSpeech`, `echoIsolatedInput`,
`outputWordAlignment` — each `supported`, `unsupported` or `unproven`. Neither
the host nor a client promotes `unproven`. `disclosure` names the voice service
and model and one to sixteen destination statements, shown before capture.

**Identities and epochs.** The host mints `conversationId`. Each
`conversation_start` opens a new `epoch`, starting at 1; resuming an existing
id (same principal) after a disconnect or restart opens the next. The new
epoch's `conversation_opened` is followed, before any event of that epoch, by
one `conversation_work` per retained receipt and one `conversation_output` per
retained output record; `resync` gives both counts. One record per frame keeps
each one whole under the per-frame cap. Nothing is resubmitted, re-executed or
re-announced, and capture restarts explicitly. Frames for an ended epoch are
dropped; a commit for one is refused. One connection holds one conversation;
resuming it from another connection ends the first one's epoch with
`replaced`. An id this principal cannot resume is answered with `error` code
`CONVERSATION_UNKNOWN`. The client mints `utteranceId` and a per-conversation `requestId`.

**Semantic commit is the only admission.** Audio, endpoints, recognized
fragments and provider work requests never run anything. `conversation_commit`
creates host work only for an utterance this epoch received audio for, with
at least one recognized fragment not attributed to the assistant, and not
already committed. The committed `text` is what the agent receives. A
repeated `requestId` replays its receipt and never queues again; once its
receipt is evicted, the id is refused instead. A conversation remembers 4,096
admitted ids and then refuses further commits: start a new conversation. A provider's
advisory work request binds to committed work of the same epoch: one naming
its utterance binds to that utterance's work in any state, and if the result
already went out without a handle the same result is returned again with it;
one naming no utterance binds only to the oldest unbound work still running,
or waits for the next commit. One request holds one handle: a further
request naming an utterance whose work already holds one is dropped. The
handle is only the token the result is returned with. An utterance id an epoch has evicted stays retired: audio for
it closes the epoch with `correlation` rather than starting it over.

**Execution.** Work runs through the ordinary chat path with
`source: "voice-conversation"`, `requestId` and the conversation's chat
session (the first commit creates one when `conversation_start` named none).
One conversation submits one request at a time, so its work never becomes
parallel turns of one session. Host work always runs as its own turn, never a
native follow-up, so its result has its own turn identity; for the same reason
a typed message arriving while a host-work turn runs queues as the next turn
instead of joining it, even on a `followUp` backend. A `cancel` for the
session, and any cancellation of the running request (a cancel without a
session id, host shutdown, a timeout), also cancels the conversation's
committed work that was not yet submitted. A new turn it
starts declares the voice posture: `posture: "voice"` with
`enforceAllowedTools` and `noGrantSurface`. An ordinary turn already running
in the session keeps its own posture. A failed host-work turn offers no
client Retry handle (`retryOfTurnId`), because `retry_turn` could not restore
its posture. Backend `startTurn`, `followUp`, the session queue and the
permission bridge are otherwise unchanged.

`StartTurnRequest.posture?: "voice"` (additive, `@experimental`) asks the
backend to run the turn on its declared voice allowlist instead of its
ordinary one ([voice posture](decisions/voice-permission.md#the-voice-posture)).
`assertTurnPosture` refuses it without both `enforceAllowedTools` and
`noGrantSurface`, or on an autonomous turn. The Claude backend selects
`VOICE_ALLOWED_TOOLS`. The pi backend declares no voice posture and rejects the
turn with `BackendRequestError`, so a conversation on pi fails visibly instead
of running on the ordinary allowlist. A conforming backend must do one or the
other; ignoring the field is forbidden.

**Receipts and provenance.** `ConversationWorkReceipt` carries
`conversationId`, the commit `epoch`, `utteranceId`, `requestId`, `turnId?`,
`sessionId?`, `state`, `delivery`, `recognized` (the utterance's original
fragments joined in sequence order), `submitted` (the committed text) and
`reason?`. `state` is `queued`, `running`, `completed`, `cancelled`, `error`
or `refused`. `delivery` is `pending`, `returned` (the provider accepted the
result) or `discarded`. Recognized, submitted and generated text are separate
facts: `input_fragment` events carry original recognized text, finalization
(`interim` / `final` / `unknown`), certainty (`known` only with a calibrated
`confidence`) and origin (`user` / `assistant` / `unknown`);
`output_transcript` is generated text, not a record of what was heard.
`ConversationOutputRecord` keeps an output's `epoch`, generated text, the
client's `playback` evidence and optional `playedSamples`; output ids are
scoped to their epoch, and playback for an ended epoch is dropped. Completion is the
host terminal receipt plus local playback drained or discarded; provider
generation end is a separate fact.

**No stale result.** The host returns a result to the provider only when the
work `completed` or failed with `error`, its epoch is still live, the
conversation is still attached, and the provider has not withdrawn the
request. Cancellation, a host timeout (state `cancelled`, reason
`Turn timed out`), withdrawal, epoch replacement, stop and disconnect all
leave the host outcome in place with `delivery: "discarded"`. A result
handed to a provider that had not acknowledged it when its epoch ended is
discarded too; a late acknowledgement does not change that. Work queued
behind a session start whose routing fails settles as `error`, and so does a
turn that ends with only an `error` frame and no `result`. `conversation_stop` and an ended epoch cancel committed work
that has not been submitted yet; submitted work keeps running as an ordinary
chat turn.

**Permissions.** `conversation_permission` lists a request pending in the
conversation's session. `announce` is true at most once per
`(sessionId, turnId, toolUseId)` for the conversation's lifetime, across
epochs, and only when `exactPermissionSpeech` is `supported`. Neither
provider text nor a native handle can settle a request; spoken grants remain
refused, and refusals use `tool_denial` with `channel: "voice"` and the
outcomes above.

**Bounds** (`CONVERSATION_LIMITS`, published on `conversation_opened`):

| Limit | Value | Over the limit |
| --- | --- | --- |
| `maxAudioChunkBytes` | 65,536 decoded bytes of PCM16 per chunk | client frame refused (`PARSE_ERROR`); provider chunk closes the epoch, `correlation` |
| `maxUtterances` | 16 per epoch; an ended or committed one is evicted first | epoch closed, `backpressure` |
| `maxFragmentsPerUtterance` | 128 | epoch closed, `backpressure` |
| `maxFragmentChars` | 2,000 per fragment | provider event refused, epoch closed `correlation` |
| `maxUtteranceChars` | 16,000 recognized characters per utterance, fragments joined | epoch closed, `backpressure` |
| `maxGeneratedChars` | 16,000 generated characters per output record | record truncated |
| `maxCommitChars` | 8,000 | frame refused (`PARSE_ERROR`) |
| `maxQueuedWork` | 4 per conversation, running included | commit receipt `refused` |
| receipts | 64 per conversation; a final one is evicted first | commit receipt `refused` while 64 results await the provider |
| `maxPendingNativeRequests` | 8 unbound provider requests | epoch closed, `backpressure` |
| `maxFactChars` | 4,000 per returned result | facts truncated |
| `maxOutputs` | 32 output records; the oldest is evicted | — |
| `maxConversationsPerConnection` | 1 | `error` `CONVERSATION_LIMIT` |

Audio is mono PCM16 at 8–48 kHz. `sequence` starts at 0 in every epoch and
increases by exactly one per chunk. A missing or out-of-order chunk, audio for
an ended utterance, or an endpoint or fragment for an utterance the epoch never
received closes the epoch with `correlation`, so lost audio is never a silent
gap. Audio frames share the connection's ordinary frame metering (the
`BRAIN_UI_WS_RATE` budget), so send chunks of about 100 ms or more. Any frame
metered away on a connection holding a conversation ends its epoch with
`backpressure`, because it may have been audio, an endpoint or a commit. Host teardown closes every provider session. A host retains up to 16 conversations for resumption and 64
receipts per conversation. `conversation_closed.reason` is `stopped`,
`replaced`, `disconnected` (not sent: the socket is gone), `provider_closed`,
`provider_error`, `backpressure`, `correlation` or `refused`. A disconnect
leaves the conversation resumable.

**Provider seam.** `LiveConversationProvider` (`@schlessera/brain-ui-sdk/server`)
has `id`, `capabilities`, `disclosure` and `open(scope, { signal, resync })`,
returning a `LiveConversationSession`: `events` (an async iterable of the
closed `LiveConversationEvent` union), `appendAudio`, `markEndpoint`,
`returnWork(ref, result)` and `close()`. `resync.work` is context, not a
request to resubmit. `ConversationWorkRef` carries the scope, `utteranceId`,
`turnId`, `requestId` and the bound `nativeHandle?`; `ConversationWorkResult`
is `{ outcome: "completed" | "error", facts, delivery: "quiet" | "when-idle" }`.
Every event carries its scope and is validated by `parseLiveConversationEvent`
before the host reads it; an event for another scope is ignored and an
invalid one closes the epoch. `assertLiveConversationProvider` and
`assertLiveConversationSession` are the registration checks. No shipped
adapter, client capture/playback or provider network call is part of this
contract.

### Interactive answer receipts (breaking, #910)

```
server_hello.capabilities.askReceipts: true      // this host requires and sends receipts
server_hello.capabilities.liveness: true         // this host answers ping
server_hello.principalKey?: string               // opaque, stable per principal
client_hello.capabilities.askReceipts: true      // this client reads receipts

client → ask_user_response | ask_user_list_response
       | ask_user_rank_response | ask_user_form_response
         + { submissionId: string, turnId: string, sessionId?: string }
client → { type: "ask_answer_status", requestId, submissionId, sessionId? }
server → { type: "ask_answer_receipt", requestId, submissionId,
           state: "accepted" | "pending" | "closed",
           reason?: "ended" | "cancelled" | "answered_elsewhere"
                  | "not_recognized" | "refused",
           sessionId?, turnId? }
client → { type: "ping", probeId }      server → { type: "pong", probeId }
error.code "ASK_ANSWER_UPDATE_REQUIRED"   // an ask answer without submissionId
```

This section covers the answers to the four ask tools (`ask_user`,
`ask_user_list`, `ask_user_rank`, `ask_user_form`) and nothing else.
Tool approvals, `ask_user_cancel`, location and mask replies keep the
tolerance described under "Revision negotiation".

**Breaking (Compatibility B).** The maintainer ruled on #910 that
receipt-capable peers are required for these four answers. A host that
advertises `askReceipts` does not settle an ask answer that carries no
`submissionId`. It replies to the sender with an `error` frame,
`code: "ASK_ANSWER_UPDATE_REQUIRED"`, carrying the `requestId`. The question
stays pending, so an updated client can still answer it within the turn's
timeout. A client must not submit an ask answer to a host whose
`server_hello` lacks `askReceipts`, or to a host that sends no hello at all.
It shows an update-required state instead and settles nothing. Old-client and
new-host pairs, and new-client and old-host pairs, therefore both fail
visibly rather than silently. Neither one reports an answer as accepted.

**Identity.** `requestId` is the tool call's id on both backends. On the
Claude backend the in-process tool reads it from the MCP request's
`_meta["claudecode/toolUseId"]`, which Claude Code sends on every `tools/call`.
This was measured against the bundled CLI 2.1.283, and
`packages/ui-backend-claude/tests/ask-tool-request-id.test.ts` re-measures it
against the installed CLI. Without that field the tool falls back to a minted
id: live delivery still works, but a card rebuilt from history cannot
correlate with it. A card rebuilt from `session_history` and the live
request therefore share one `requestId`. Clients key ask cards by it within a
session: a re-sent request updates its card and never adds a second one.

**Submission.** `submissionId` (1–128 characters) names one explicitly
submitted answer. The client mints it at Submit and reuses it for every retry
of that same answer. A receipt-carrying answer must name the request's
`turnId`. A missing or different `turnId`, a `sessionId` that is not the
request's, or a frame for another ask kind is refused with
`closed: refused`. The request stays pending.

**Receipts** go to the sending socket only:

- `accepted`: this submission settled the request. Repeating the same
  submission (same principal) returns `accepted` again and settles nothing.
- `pending` (status replies only): the request still waits and does not
  have this submission. `sessionId` and `turnId` name its binding.
- `closed`: the request will not take this answer. `ended` means the turn
  ended, failed, timed out or was cancelled. `cancelled` means the question
  was dismissed. `answered_elsewhere` means another submission settled it.
  `not_recognized` means the host does not know the request, or the receipt
  belongs to another principal. `refused` means the binding does not match.

`ask_answer_status` settles nothing. It is how a client revalidates a
queued or unconfirmed answer before replaying it. The host remembers each
outcome for 24 hours, the client's maximum replay age, and for at most the
1,024 most recent requests. It keeps them in memory only. After a host
restart every request is `not_recognized`, and replay stops. A queued
answer cannot resurrect an ended request or start a turn.

**Re-delivery.** On every socket open the host re-sends each pending
question, as before. After a `session_resume` it also re-sends that
session's pending questions, after the replacing history frame, because the
history replaced the client's live card.

**Liveness (Liveness B).** `ping` is answered at once with a `pong` carrying
the same `probeId`. `BrainUiClient` probes after 15 seconds without a valid
frame while the page is in the foreground. It replaces the socket when no
correlated `pong` arrives within 5 seconds, closing the abandoned one with
code 4000, and ignores any late callbacks from it. A connection attempt that
has not opened, or an open socket that has delivered no frame, after 10
seconds is abandoned the same way and retried with the normal backoff, which
resets only once a connection delivers a valid frame.
`checkLiveness()` probes at once, for a return to the page, a resume or going
online. `setForeground(false)` pauses the periodic probe. These are targets:
a frozen page runs no timers.

**principalKey** is a one-way digest of the principal id, stable per
principal. A client files queued answers under it and never replays an
answer over a connection with a different key. It identifies nothing by
itself.

The client-side queue (16 answers, 16 MiB of UTF-8 serialized records and 24
hours per device and principal, persisted in IndexedDB) is
`@schlessera/brain-ui-react` behaviour, not wire contract. The decision
record is [answer-delivery.md](decisions/answer-delivery.md).

### Session drafts (additive, #979)

A host that stores composer drafts sends `server_hello.capabilities.sessionDrafts:
true` and, beside it, `server_hello.sessionDraftLimits: SessionDraftLimits`
(`maxTextBytes` 65536, `maxDraftBytes` 8388608, `maxDrafts` 100,
`maxTotalBytes` 268435456; exported as `SESSION_DRAFT_LIMITS`). D52 §6 drew
the limits inside `capabilities`; they sit beside it because every shipped
client validates `capabilities` as a string-to-boolean record and would drop
the whole hello over an object value. Without the flag a client keeps drafts
on the device and never claims host saving or cross-device restore.

Drafts live in the UI's operational database, never in `brain.db` or
canonical Markdown, so `brain index --force` cannot touch them. They are one
namespace per host: every principal that authenticates to the host shares
them, each operation re-resolves its principal before committing and
records who made each change, and no role or per-login partition is added.
A different root runs a different host with its own database.

The six routes, their headers, bodies and error codes are specified in the
[HTTP API](http-api.md#session-drafts-additive-979); the SDK publishes the
`SessionDraftLimits`, `DraftRef`, `DraftSummary`, `Draft`, `DraftAttachment`,
`DraftListResponse`, `DraftSaveRequest`, `DraftSaveResponse`,
`DraftAttachmentResponse`, `DraftBindRequest`, `DraftBindResponse`,
`DraftErrorCode` and `DraftErrorResponse` types and the matching
`sessionDraftLimitsSchema`, `draftRefSchema`, `draftSummarySchema`,
`draftListResponseSchema`, `draftAttachmentSchema`, `draftSchema` and
`draftSaveResponseSchema`. The rules they rely on:

- **Revisions** start at 1 and only grow. A save, delete or bind that names
  a revision other than the current one is a 409 `DRAFT_CONFLICT` carrying
  the host's `current` version; the host never merges. A save cannot move a
  draft to another session.
- **Receipts.** A successful save or upload is stored under its
  `Idempotency-Key` (per draft and operation, the 32 most recent). The same
  request under the same key returns the stored response; a different one
  is 409 `DRAFT_KEY_REUSED`. An upload receipt whose image is no longer
  stored is not replayed: the retried upload is stored again under a new id.
- **Tombstones.** Deleting or sending a draft keeps its row at the next
  revision with no text or images. Every later save, upload or bind of that
  id is 410 `DRAFT_DELETED` with `tombstoneRevision`, so nothing stale
  resurrects it; save the content under a new `draftId`. Tombstones are not
  pruned.
- **Bounds.** Text is at most `maxTextBytes` UTF-8 bytes; a draft lists at
  most `MAX_IMAGES_PER_MESSAGE` images of the `ALLOWED_IMAGE_MEDIA_TYPES`,
  each at most `MAX_IMAGE_BYTES`, together at most `MAX_TOTAL_IMAGE_BYTES`,
  and text plus images at most `maxDraftBytes` (413 `DRAFT_TOO_LARGE`). At
  most eight images are stored per draft, listed or not. A new draft beyond
  `maxDrafts`, or growth beyond `maxTotalBytes` of live text plus stored
  images, is 507 `DRAFT_CAPACITY`. Nothing is evicted to make room, and no
  draft expires; an uploaded image no save has listed is removed after an
  hour.
- **Atomicity.** Each mutation is one immediate SQLite transaction; a 200 or
  204 means it committed. A refused or failed request leaves the committed
  draft and its images unchanged.

`chat_message.draftRef?: DraftRef` names the saved revision a message was
sent from. It is ignored by a host without the capability and on a handoff
message (whose text is a reviewed summary, not a composer draft), and a message
carrying it never joins a running turn natively: like `requestId`, it queues
as its own turn. When the host accepts the message (the `session_info` of its
turn, or its `status: queued`), it deletes the draft only if that revision is
still current and the draft belongs to the message's session, or is unbound
for a new conversation. Later edits are a later revision and survive; another
session's draft and images are never touched. A refused message consumes
nothing. For a new conversation with a `requestId`, the host also records
that this draft's request started that session, which is the only proof
`POST /api/drafts/:draftId/bind` accepts. Draft text and images never enter
logs, push payloads or the transcript store.

### Session recovery (additive, #964)

A host that can account for its sessions' work sends
`server_hello.capabilities.sessionRecovery: true`
(`SESSION_RECOVERY_CAPABILITY`). Then `GET /api/sessions/:id/recovery`
answers with a `SessionRecovery` ([HTTP API](http-api.md#session-recovery-additive-964)),
and its replayed history may carry an optional `SessionHistoryMessage.turnId`.
A client uses neither without the flag: an older host has no route, which a
client reads as `host_too_old`. Unrelated chat, approval and ask flows are
unchanged. The design is D52 §6 in
[decisions/design-kit.md](decisions/design-kit.md#6-host-contracts-the-implementations-add).

```ts
SessionRecovery = {
  sessionId: string;
  backendId: string | null;
  revision: number;
  latest: {
    requestId: string | null;
    turnId: string | null;
    state: "queued" | "running" | "terminal" | "unknown";
    outcome: ActivitySpanOutcome | null;
    startedAt: number | null;
    endedAt: number | null;
  };
  pending: Array<{ kind: "approval" | "ask_user" | "ask_user_list" | "ask_user_rank" | "ask_user_form"; requestId: string; turnId: string }>;
}
```

- **Revision.** The host persists, per session, the latest request it
  accepted and a revision that grows by one at each acceptance: a message
  that starts or resumes a session, and a follow-up that joins its queue. A
  follow-up injected natively into the running turn is part of that turn and
  takes none. A refused message takes none. Acceptance order is the only
  ordering: never backend mtime, message count or identifier comparison.
  `revision: 0` means the host has no acceptance on record (imported
  history, or a session older than this record). A revision lower than one
  a client has already seen is a rollback, for the client to treat as
  `unknown`.
- **States.** `queued`: accepted and held by this host process, not yet
  handed to the backend; `turnId` is null. `running`: its turn is executing
  in this process; `turnId` and `startedAt` are set. `terminal`: the Activity
  rollup of the request's turn holds its outcome, in the existing
  `ActivitySpanOutcome` vocabulary, with that run's `startedAt` and
  `endedAt`. A rollup survives detail pruning. `unknown`: the read succeeded
  but nothing proves more — a queue or running turn lost to a restart (the
  host never resurrects either), a request dropped before it ran, a turn
  with no Activity outcome, an Activity run recorded for another session,
  an acceptance the host could not record, or imported history. `outcome`
  is non-null exactly when `state` is `terminal`, and `endedAt` is null
  unless it is. Times are host clock milliseconds; no time is inferred.
- **Pending.** Every approval and ask waiting on a person in the session,
  with its original `requestId` (an approval's `toolUseId`) and the `turnId`
  that raised it, which may be older than `latest.turnId` while a newer
  request is queued. It is not a payload and grants nothing: the payloads
  are re-sent through the existing scoped interaction frames. A
  `session_resume` now re-sends the session's pending approvals, after its
  history and before its pending asks, under their original turn, so a
  replay that ends on the user's message no longer loses the card. Only
  what is still pending is re-sent; a settled approval is never revived.
  The four ask kinds keep the receipts and rules of #910.
- **Turn linkage.** After each turn, the host reads the transcript once. If
  the turn added an assistant answer and the transcript ends on it, the host
  records that answer's position among assistant messages and a digest of
  the transcript up to it. A replay puts `turnId` on the assistant message
  at that position only while the digest still matches, so an edited,
  truncated or rebranched transcript loses the link. Nothing else carries
  one, and nothing is inferred from timestamps or content. A turn that
  answered nothing links nothing.
- **Reads.** A recovery read never selects a session, starts work, replies
  or grants. It re-checks the caller's principal after its asynchronous
  step, and its envelope is one synchronous snapshot. Responses are
  `Cache-Control: no-store`.

| Response | Meaning | SDK `classifySessionRecoveryResponse` |
| --- | --- | --- |
| 200 `SessionRecovery` | the read succeeded | `{ ok: true, recovery }` |
| 401 `{ error: "Authentication required", authRequired: true }` (or another 401/403 from the guard) | no identities disclosed | `unauthorized` |
| 404 `{ error: "SESSION_NOT_FOUND", message }` | neither the catalog, the live coordinator nor any backend knows the session | `session_not_found` |
| any other 404 | the route is absent | `host_too_old` |
| 500 `{ error: "SESSION_RECOVERY_FAILED", message }`, any other status, or an unreadable 200 | the read failed; never a successful `unknown` | `host_unreachable` |

The SDK publishes `SessionRecovery`, `SessionRecoveryLatest`,
`SessionRecoveryPending`, `SessionRecoveryState`,
`SessionRecoveryPendingKind`, `SessionRecoveryUnavailable`,
`SessionRecoveryResult`, `SESSION_RECOVERY_CAPABILITY`, `SESSION_NOT_FOUND`
and `SESSION_RECOVERY_FAILED`, with `sessionRecoverySchema` and
`classifySessionRecoveryResponse` in `schemas`. `brain-ui-react`'s API client
gains `sessionRecovery(sessionId)`, which returns that classification and
never throws. The host stores only identifiers, revisions and times in its
operational database (`session_work`, `turn_boundaries`), never prompt
text, payloads or credentials, and never in `brain.db`.

### Pending follow-ups (additive, #1002)

```
server_hello.capabilities.followUpQueue: true
client_hello.capabilities.followUpQueue?: boolean
server → { type: "session_queue", sessionId,
           followUps: QueuedFollowUpView[],               // whole, in send order
           started?: QueuedFollowUpView & { turnId },
           dropped?: Array<{ id, requestId?, reason }> }
QueuedFollowUpView = { id, requestId?, text, textTruncated?, attachmentCount?,
                       fileCount?, source?, queuedAt }
```

A message sent to a busy session waits in the host's in-memory queue and
enters the transcript only when its own turn starts, so history alone cannot
show it. A host that advertises `followUpQueue` sends `session_queue` only to
connections whose `client_hello` declared the same flag; a client that does
not declare it receives exactly the frames it received before.

- **When.** After that `client_hello`, one frame for every session with a
  non-empty queue. After every `session_resume`, one frame for that session,
  even an empty one, after its history. And to every declaring connection on
  each change: a follow-up queued, started or dropped.
- **`followUps`** is the whole pending list, replacing what the client held.
  "Pending" means not yet handed to the agent: an entry taken off the queue
  stays in it while its turn is still being routed and billed, and leaves the
  moment the turn reaches the backend.
- **`started`** is the entry that just became the session's turn, with that
  turn's `turnId`. It is sent before any frame of that turn, so a client can
  place the message in the transcript where it entered the conversation.
- **`dropped`** names entries that left without running, with the host's
  reason: the turn was cancelled (`Cancelled by user`), the sender was signed
  out, or the session stopped first. A refused message (`SESSION_QUEUE_FULL`)
  was never queued and is not listed; its `error` frame answers it, as before.
- `id` is host-minted and stable while the entry waits; `requestId` is the
  sender's `chat_message` correlation id. Attachment bytes are never repeated,
  only counted. Each `text` carries at most 8,000 serialized bytes of the message;
  a longer one ends with `…[N chars elided]` and carries
  `textTruncated: true`, and its turn's history holds the whole of it. That
  keeps a full queue (50 entries) inside one frame, so the list itself is
  never cut. The budget counts the text's escaped JSON bytes.

The queue stays in memory: a host restart drops it, as it always has. The SDK
client (`BrainUiClient`) declares the flag.

### Pill labels (additive, #1004)

```
PILL_LABEL_MAX_CHARS = 32
QueuedFollowUpView.label?: string
ChatSession.label?: string                         // GET /api/sessions
CreateAppOptions.labeller?: { provider: LabelCompletionProvider; timeoutMs?; billing?: "api" | "subscription" }
LabelCompletionProvider = {
  id,
  complete({ system?, prompt, maxTokens? }): Promise<string>,
  completeWithUsage?({ system?, prompt, maxTokens? }): Promise<{   // additive, #1083
    text: string;
    usage?: { inputTokens; outputTokens; cacheReadTokens?; cacheCreationTokens? };
    model?: string;
  }>
}
LABEL_RUN_NAME = "pill label"                       // Activity run name, #1083
```

A label is a few plain words saying what a pill is about: at most
`PILL_LABEL_MAX_CHARS` characters, no quotes, no trailing punctuation. It
never replaces a session's `title` and never renames anything; a client
without one prints what it printed before (the title, or the start of the
prompt).

- **Off by default.** Without `CreateAppOptions.labeller` the host sends no
  `label` and makes no call. The provider is any value of core's
  `CompletionProvider` shape, chosen by the host and separate from every
  session's chat model. **When it is set, the text of every queued follow-up
  and every turn's request goes to that provider**, which may be a different
  vendor from the session's backend.
- **A queued follow-up** is reported at once without a label. When the label
  arrives, the session's `session_queue` is sent again with no `started` or
  `dropped`; every later report carries it.
- **A session** is labelled from its latest request when a turn starts. The
  label is stored with the session and listed by `GET /api/sessions`, and it
  stays until the next request is labelled. A request already labelled is not
  sent again: a follow-up that becomes the session's turn hands its pill's
  label to the session.
- **Failure** (an error, an unusable answer, no answer within `timeoutMs`,
  10 s by default) leaves the fallback in place and is logged once per item.
  The SDK drops a `label` outside its bounds and keeps the rest of the frame.
- **Cost (additive, #1083).** Every call that reaches the provider is an
  Activity run named `pill label` (`origin: "session"`) on the session whose
  pill it labels: the queued follow-up's session, or the session whose
  request it is. Asks that share one call share its run, which goes to the
  session of the ask that started it. A cached answer and an ask skipped
  while busy reach no provider and record no run. A call that fails is an
  `error` run. The labeller calls `completeWithUsage` when the provider has
  it and `complete()` otherwise; a core `CompletionProvider` has only
  `complete()` and still satisfies the interface. A run is **priced** only
  when the call reported usage (non-negative token counts) and a model, and
  the host set `labeller.billing`: `api` prices the usage from the pricing
  catalog by that model id, `subscription` is $0. Every other run carries no
  billing mode and counts in `unpricedRuns`; it is never shown as $0. That
  includes a `subscription` host whose provider reported nothing, because a
  subscription run with no recorded usage would otherwise read as free. The
  calls are also counted by outcome in the `brain.labeller.calls` metric, and
  asks that kept their fallback without an answer (timed out, or skipped
  while busy) are counted apart, in `brain.labeller.fallbacks`. A label run's
  cost is not added to the session's own `totalCostUsd`, and a failed or
  long-running label run raises no failure or stuck notification. `createApp` records
  these runs itself; a `WsHost` embedder that builds its own labeller passes
  `createLabeller({ options, activity: { store, onWrite? } })`, and without
  `activity` it records none.

## File-layer contracts

- Markdown files: YAML frontmatter per `CONTRACT.md` (shipped in the package);
  `deadline` / `next_review` are ISO dates queried by briefing features.
- Optional `generated_from` (additive in 0.38.0): a non-empty string, either a
  repo-relative path to the document's source or a free-form tool name. It
  marks the document as produced by a tool or an agent pass, not written by
  hand. `brain validate` reports any other value as an error. `brain audit`
  reports a `propagation` issue when it names a markdown document updated
  after this one. The heuristic reranker weights a generated document ×0.85.
- Optional `verification` (additive in 0.40.0): `verification: unverified`
  declares the whole document unverified. `brain audit` then reports exactly
  one `verify` issue (`info`) for it, however many inline `[VERIFY: …]`
  markers it has. It is a declaration, not a state machine: there is no
  `verified` value, and a document without the field is not thereby verified.
  `brain validate` warns on any other value.
- Optional `supersedes` (additive in 0.38.0): on a newer document, the
  document or documents it replaces, as a wiki-link target (`"[[plan]]"` or
  `plan`) or an inline list of them, resolved like a body wiki-link, aliases
  included. Search multiplies a superseded document's score by 0.85 after
  fusion and reranking, in every mode and with `rerank: none`, and marks the
  result with `supersededBy`; the document stays in the results. `brain
  validate` reports as errors a value that is not one complete target or a
  non-empty list of them (an empty, blank or null entry, an unclosed `[[`, an
  empty `[[]]`), an unresolved target, and every document on a cycle (a
  document superseding itself through a chain), naming the others. A
  filter-only search (no query) marks `supersededBy` too, without reordering.
- `brain archive` / `brain_archive` set `status: archived` and bump `updated`.
  Since 0.38.0 they also set `relevance: historical` when relevance is
  `primary` or missing, and leave an explicit `secondary` or `historical`
  alone (additive). `brain validate` warns on `status: archived` with
  `relevance: primary`.
- The configured inbox dir (default `notes/`) with `status: active` =
  unprocessed inbox (capture targets this).
- Committed sidecars `.context-cache.jsonl` / `.asset-cache.jsonl`:
  content-hash-keyed `{k,v}` JSONL, appended from the db after embeddings
  runs — a committed value is never overwritten, a duplicated key resolves to
  its first line in sorted order, and a run with nothing new does not write
  the file. Machine-managed, union-merge on conflict, never hand-edit.
  Templates ship them empty.
- Committed `.stats-history.jsonl` (additive in 0.40.0): one `brain stats`
  snapshot per day, written by `brain maintain` and `brain stats --record`
  (see "Stats history"). Machine-managed; a brain gains it on its first
  recording, so templates need not ship it. `brain sync` commits it with the
  `config` group. It is union-merged like the sidecars: the template's
  `.gitattributes` carries `.stats-history.jsonl merge=union`, and `brain
  doctor --fix` appends the line to a brain without it. After a union merge,
  two lines for one day resolve to the later recording.
- Generated regions (additive in 0.38.0): content a command derives and keeps
  inside a hand-written markdown file sits between
  `<!-- brain:generated:{name} -->` and `<!-- /brain:generated:{name} -->`.
  Everything outside the markers is the author's and is never rewritten, byte
  for byte, trailing whitespace and line endings included; a region is
  rewritten, and the file's `updated:` bumped, only when its content changed. A
  marker counts only on a line of its own and outside code, so one quoted
  inside a line or in a fenced example is text.
  A file with a stray, doubled or out-of-order marker line is not rewritten;
  the command reports it instead, as it does a file whose frontmatter never
  closes. Generated values, the registry's cells and module-finance's alike,
  render a line break as a space, `|` as `\|` and `<!--` as `&lt;!--`
  (`inertGeneratedText`). `brain registry` owns the `registry` region of an
  `_index.md`, and module-finance the `finance` region of its ledgers and dashboard (which
  replaced its older `BEGIN GENERATED` / `END GENERATED` markers; those are
  still read and are rewritten to the region on the next `brain finance sync`).
- An `_index.md` opts in to a generated registry table with a `registry:`
  frontmatter block (additive in 0.38.0): `columns` (frontmatter keys, plus
  `title`, `path` relative to the index, and `link` as a `[[wiki-link]]`),
  optional `where: { key: [values] }`, optional `sort` (a column key, `-` for
  descending) and optional `split`: a key (one table per value), or
  `{ key, tables: { Label: [values] } }` (one table per label, in the listed
  order, left out when empty, then one per value no label took; a label that
  is a whole number, such as `"2"`, is rejected, since it would not keep its
  listed order; additive in 0.38.0). Its children
  are every markdown file under the index's directory, at any depth, other than
  an `_index.md`.
- module-jobs' opportunity `status.md` records the pipeline in frontmatter
  (additive in 0.38.0): `stage` (`researching`, `applied`, `screening`,
  `interviewing`, `offer`, `closed`), `fit` (`strong`, `medium`, `weak`),
  `applied` (a date), `next_step` (a string, whose date is the core `deadline`)
  and `closed_reason` (a string). A closed opportunity also carries
  `relevance: historical`. `brain jobs pipeline` generates the opportunities'
  `_index.md` from these fields; its audit checks report category `jobs-stage`.
- Module data files (e.g. module-jobs' `jobs.db`) are documented by the module
  that owns them.
- The scratch area `.brain/scratch/` (additive in 0.38.0) holds transient
  output and is never canonical: excluded from the index, stats and OKF
  export, and pruned to 7 days and 1 GB. Four writers are held to its rules
  and prune after writing: `brain render` (`--scratch`, stdin without `--out`,
  or `--out` into it), `brain image` (`--scratch` or `--out` into it),
  `brain okf export --out` into it, and the chat UI's `request_image_mask`
  beside a draft there. Each refuses to write until git excludes the
  directory itself (`brain doctor --fix` adds the line; a rule on the files
  alone does not count) and refuses a `.brain` or `.brain/scratch` that is a
  symlink. Other commands that write where a caller points them (`add`,
  `import`, pi's `write_file`, module data files) are canonical-content
  writers and are not held to scratch rules. The periodic pass is `brain
  maintain` (the hosting container runs it daily), `brain scratch prune`, and
  the chat server hourly. A file there may vanish at any time; a consumer that
  wants to keep one moves it out.

## Extension interfaces

These eleven seams are `@experimental` until 1.0: breaking changes are
minor-version events, announced in the CHANGELOG. Each declaration carries its
own `@experimental` tag. Related experimental declarations include:
`BackendBridge`, `BackendCapabilities`, `StartTurnRequest`, `RendererPack`,
`SpeechSession`, `AsrClientOptions`, `AsrClientFactory`, `AsrClientRegistry`, `LiveConversationSession`,
`LiveConversationEvent`, `ConversationScope`, `ConversationWorkRef`, `ConversationWorkResult`, `AdapterResult`, `ScrapeContext`,
`RerankCandidate`, `RerankRequest`, `Ranked`, `AdapterStatus`,
`AdapterRunOptions`, `RunAdaptersOptions`, `AdapterOutcome` and jobs `JobAdapter`.
[#343](https://github.com/schlessera/brain-kit/issues/343) selects deliberate
public signatures, including their reachable types, for 1.0 stability; the
[package entry points](#package-entry-points) section states the boundary.
[extending/README.md](extending/README.md#the-seams) says what each one swaps.

The client/server wire protocol is a machine contract rather than an
experimental extension interface, including when an experimental backend
implements it. Its [revision negotiation](#revision-negotiation) and documented
compatibility guarantees follow the contract-versioning rules above.

| Interface | Imported from |
|-----------|---------------|
| `EmbeddingProvider` | `@schlessera/brain` |
| `CompletionProvider` | `@schlessera/brain` |
| `AgentRunner` | `@schlessera/brain` |
| `SkillEmitter` | `@schlessera/brain` |
| `Reranker` | `@schlessera/brain` |
| `AgentBackend` | `@schlessera/brain-ui-sdk/server` |
| `SpeechProvider` | `@schlessera/brain-ui-sdk/server` |
| `LiveConversationProvider` | `@schlessera/brain-ui-sdk/server` |
| `AsrClient` | `@schlessera/brain-ui-sdk/client` |
| `ToolRenderer` | `@schlessera/brain-ui-sdk/client` |
| `SiteAdapter` | `@schlessera/brain-scrape` |

`tests/seam-list.test.ts` fails when this table, the one in
extending/README.md and the tags in the source disagree.

### Dictation speech integration and conformance

The [speech stability ruling](https://github.com/schlessera/brain-kit/issues/347#issuecomment-5866348379)
selects `SpeechProvider` and `AsrClient`, including their reachable authoring
types, for stability at the actual 1.0 transition. They remain experimental
before that transition. The [decision](decisions/dictation-speech.md) preserves
dictation's current meaning beside the separately registered
[live conversation](#live-conversation-additive-957) interface; no TTS or speech-side tool/permission authority is added.

`CreateAppOptions.speechProvider?: SpeechProvider` in
`@schlessera/brain-ui-server` accepts an implementation by value. It takes
precedence over automatic Deepgram discovery; an explicit
`config.voice.provider` must equal the supplied id. Without a value, existing
built-in rules remain, including opt-in browser speech and failure when no
provider is configured. The mounted protected `POST /api/voice/session` uses
the supplied implementation. It validates a nonempty trimmed lowercase id,
four boolean capabilities and callable `createSession` before invoking it.
The returned `SpeechSession` has a string URL, finite nonnegative expiry,
optional string token and optional string-record params. Empty URL/zero expiry
remain supported for browser/local sessions. Validation, mismatch and provider
failures return the existing 500 `{ error }` envelope without fallback.
The deprecated token route remains Deepgram-specific.

The route builds keyterms only when supported, snapshots provider identity and
capabilities, and publishes `VoiceSessionResponse` with connection material.
The client's matching `AsrClientFactory` receives that whole session through
an `AsrClientRegistry`; UI applications register on their root's `asr` before
mounting. Unknown ids throw rather than select another client. External ids
should be distinct from the UI's installed built-in factories. A provider using
a built-in id must remain compatible with that built-in client's protocol.
`AsrClientOptions`, `AsrEvent`/`AsrPartial`/`AsrFinal`, `VoiceSessionResponse`,
`SpeechCapabilities` and `SpeechSession` remain reachable public authoring
types. The signature inventory includes the client factory and registry.

`runSpeechProviderContract` and `runAsrClientContract` are published from
`@schlessera/brain-ui-sdk/testing` with their probe/harness types and the
existing injected `ContractTestPrimitives`. Keyless probes exercise actual
session transports, capture/recognizer state and connection closure: complete shapes, supported
nonempty keyterms, provider failures, transcript/error callbacks, hard stop,
and a buffered final delivered before graceful drain resolves and capture
closes. These suites are the conformance floor; an adapter must also cover
its protocol-specific authentication, capture and failure behavior. The
[authoring guide](extending/speech.md) supplies complete public server/client
examples and points to executable harnesses and real route/Chrome integration.

### Saved-audio transcription (additive, #1021)

The existing experimental `SpeechProvider` adds optional
`transcribeRecording({ audio: Uint8Array, contentType: string, keyterms: string[],
signal: AbortSignal }): Promise<SavedAudioTranscription>`; its result is
`{ text: string }`. Implementations may omit it. Implementations that supply it
must send unmodified audio server → provider using server-held credentials,
reject failures, and perform no automatic retry. They must not resolve empty
text or send audio directly from the browser. This adds no provider registry
or separate seam. `SpeechTranscriptionError(reason, providerStatus?)` records
an explicit classification; untyped exceptions, lost/unparseable/invalid
responses and local timeouts become terminal `outcome_unknown`. Definitive
HTTP error responses are classified from their status: 401/403 authentication,
429 rate limit, 408/504 provider timeout, other 5xx provider error, and other
4xx media/parameter/validation rejection. A contradictory reason cannot
make a nonretryable HTTP response retryable. Providers without an HTTP status
must supply a truthful definitive reason or use `outcome_unknown`.

`SpeechCapabilities.savedAudio?: boolean` is additive. Absent/false means
unavailable to clients. The server derives it solely from a callable optional
method for discovery, session responses and uploads; a declared flag that
contradicts that method is invalid. `GET /api/voice/capabilities` is protected,
read-only, `no-store`, returns `{ providerId, capabilities }`, and mints no
streaming token or provider request. Selection/validation failures retain 500
`{ error }`. Deepgram is the only built-in saved-audio provider; Web Speech
omits the method and reports false. Deepgram sends the raw container body to
`POST /v1/listen` with `model=nova-3`, `smart_format=true`, `mip_opt_out=true`,
server `Authorization: Token …`, the original media type and no `encoding`.
Keyterms use a conservative aggregate 500 UTF-8-byte budget including
separators, below the provider's 500-token ceiling. No live vendor call is
part of the conformance proof.

`GET`/`PUT`/`DELETE /api/voice/recordings/:recordingId/transcription` are
supported HTTP operations, specified in [the HTTP reference](http-api.md#saved-audio-transcription).
All require a usable account principal. Agents/system principals are refused;
ambient modes use their existing account mapping (proxy users are distinct).
The host derives ownership from its existing account key; it never trusts a
client account id. The calling principal is re-resolved inside the claim
transaction after reading the bounded body. Expired authorization cannot read
a completed result. A recording id is host-wide unique, with an immutable
verified hash and owning account, rather than partitioned by login principal.
Cross-account reads and mutations return 404 without result disclosure or
provider dispatch. Reauthentication as the same account reuses the receipt.

`RecordingTranscription` is `{ recordingId, sha256: string|null,
providerId: string|null, status, attemptId, retryCount, failures,
text?, failure?, disposition? }`. Status is `transcribing | done | failed |
outcome_unknown | consumed`. Each failure is `{ reason, retryable,
providerStatus? }`; `reason` is `provider_error | rate_limit | provider_timeout |
media | parameters | validation | authentication | outcome_unknown`.
`failures` retains each failed attempt's classification plus its `attemptId`.
`retryCount` counts explicit retries (0 initially, maximum 3); it and the
failure history survive consumption. Disposition is `accepted | discarded`.
Only `done` carries transcript text. Hash/provider can be null on a tombstone
that precedes the first upload. Recording UUIDs are canonicalized to lowercase
for every route and receipt, so alternate case spellings share idempotency,
account ownership and tombstones. `GET` returns the receipt or 404.

Only an immediate transaction inserting a claim may dispatch the provider.
A repeated same-hash `done` upload returns the same receipt and text. An
in-progress receipt gives 409 `transcription_in_progress`; a different hash
gives 409 `recording_hash_mismatch`. A failed plain replay gives 409
`transcription_failed`. `PUT ?retry=<failed attemptId>` atomically claims a
new attempt only for a retryable failure: provider 5xx, 429/rate limit or a
definitive provider timeout including Deepgram 504. Each retry is explicitly
user initiated. Media, parameter, validation and authentication failures are
never retried; they give 409 `transcription_not_retryable`. Explicit terminal
classifications remain terminal even if an adapter attaches a conflicting
transient HTTP status; transient classifications cannot override definitive
authentication or validation HTTP evidence. A stale token gives
409 `transcription_retry_stale`; once three retries are used, a current token
gives 409 `transcription_retry_limit`. Simultaneous retries can claim only
one attempt. `outcome_unknown` gives terminal 409
`transcription_outcome_unknown`, never any retry. A server restart makes any
leftover `transcribing` receipt unknown. Completion updates only its still
active attempt, preventing stale replies from overwriting a tombstone.
Provider rejection is a 200 receipt with `failed`, not a lost HTTP response.
Errors use `{ error, message, receipt? }`; stored conflict/terminal responses
include the receipt. Authentication errors retain the existing guard envelope.

Receipts live indefinitely in the UI's operational database, never `brain.db`.
They outlive login rows and have no TTL or count-based pruning. `DELETE` erases
text but retains a `consumed` tombstone; delayed PUTs give 410
`transcription_consumed`. A DELETE before the first claim inserts a hashless
tombstone. The guarantee lasts for the lifetime of that operational database;
resetting it is the boundary. Recording ids are random client UUIDs.

The paired UI uploads only after the confirm row's **Upload and transcribe**
action, and uses a recording-id Web Lock. Reconnect/reload/sign-in never
uploads audio or sends a chat message. Recovery may read GET status; explicit
accept/discard may queue a durable DELETE while offline and replay that deletion
after reconnect. Success is saved to the owning local partition before review
is ready, and audio remains until explicit acceptance/discard. Unassigned
recordings require explicit association before upload. A transport loss during
partial upload retains the original bytes/hash and asks for fresh consent;
an uploaded request with an unconfirmed reply stays awaiting status. Unknown
outcomes and exhausted/nonretryable failures keep audio and offer no Retry.
The root's existing request injection accepts optional `onUploadProgress`
(callback percentage); its default uses XHR for actual byte-upload progress,
with the same account epoch and 401 guards as fetch. Injected transports that
handle this callback must report transferred bytes, never fabricated completion.

`runSpeechProviderContract` adds optional-method probes of unchanged bytes,
media type, supported keyterms, nonempty results and rejection. A provider
implementing the method supplies `recording()` transport observations in its
keyless probe. Existing providers that omit it remain valid.

### SiteAdapter conformance and migration

Under the [2026-09-28 adoption ruling](https://github.com/schlessera/brain-kit/issues/344#issuecomment-5866304745),
all ten jobs boards implement `SiteAdapter<RawJob>` and production jobs
scraping uses the shared `runAdapters` runner. The seam remains experimental
until 1.0; the [decision](decisions/site-adapter-adoption.md) records the
boundary and alternatives.

- `scrape(ctx, options)` returns `AdapterResult<T>` with `items`, required
  `status`, optional opaque `cursor`, and `errors`. `AdapterStatus` is `ok`,
  `empty`, `unparseable` or `not_run`. `ok` permits partial items with errors;
  `empty` requires positive readable-page evidence, never only zero items.
  Readable but unrecognized pages are `unparseable`; no readable result is
  `not_run`. Jobs retains its existing `PageLedger` checks and diagnostic text.
- `AdapterRunOptions` supplies `incremental`, previous `cursor`, `queries`,
  `proxy` and per-site `fetch` overrides. Adapters forward applicable options
  per request; one source's options never mutate the shared HTTP client. Jobs
  preserves explicit board pacing floors; a run may request a longer delay.
- `runAdapters` executes in selection order, supplies the shared HTTP client,
  and supplies browser context only to adapters declaring `needsBrowser`.
  Unavailable required transports, thrown options or adapter failures yield
  `not_run` without aborting later sources. A browser created by the runner is
  closed in `finally`; a caller-supplied session stays caller-owned. Constructed
  browsers share the HTTP client's robots cache, limiter and User-Agent unless
  their explicit browser options override them. Browser navigation retains
  the [existing policy](#browser-scraping-navigation-policy).
- `JobAdapter` in module-jobs extends the generic contract with source, tier,
  detail-host allowlists and detail-fetch metadata. Jobs owns cursor/logging,
  enrichment, scoring and database cleanup. Every selected source still has
  the existing CLI report row and status/error/cursor semantics above.

The approved pre-1.0 API break requires consumers to add `AdapterResult.status`,
use `JobAdapter` instead of removed `ScraperAdapter`, and use generic
`AdapterResult<RawJob>` instead of removed jobs `ScrapeResult`. Call
`scrape(ctx, options)` instead of `bind(ctx).scrape(opts)`, pass `cursor` instead
of `lastCursor`, read `items` instead of `jobs`, and take source identity from
the adapter or runner outcome. `ok([])` reports diagnostic `unparseable`, not
confirmed empty. The CLI `{ report }` envelope does not change.

### AgentBackend conformance baseline

Every conforming `AgentBackend` must honor a requested
`StartTurnRequest.enforceAllowedTools` or `StartTurnRequest.noGrantSurface`, or
reject an unsupported restricted turn with `BackendRequestError` before
runtime acquisition, protocol frames or effects. Silently ignoring either is
nonconforming. Both inputs remain optional; absent or false retains ordinary
turn defaults. This pre-1.0 tightening follows the
[maintainer's ruling](https://github.com/schlessera/brain-kit/issues/341#issuecomment-5866237390)
and [decision record](decisions/backend-conformance.md); it does not freeze all
experimental extension interfaces.

Enforcement requires a permission decision for an off-allowlist tool, including
runtime auto-approval shortcuts. Such requests carry
`outsideEnforcedAllowlist: true`; a denial prevents the tool body from running
and reaches the model as a denial. `noGrantSurface` is valid only with
`enforceAllowedTools: true`; otherwise the turn rejects before execution. In a
valid no-grant turn, both tool grants and command confirmations are denied
promptly without an unanswered bridge request, with a named tool error and
`permission_denied` activity evidence.

`StartTurnRequest.posture: "voice"` (additive, #957) follows the same rule: a
conforming backend runs the turn on its declared voice allowlist or rejects it
with `BackendRequestError` before execution; it never runs it on the ordinary
allowlist. See [Live conversation](#live-conversation-additive-957).

`runBackendContract` in `@schlessera/brain-ui-sdk/testing` checks this baseline
with a required permission probe and observable tool-body effects. Both
first-party backends demonstrate enforcement with keyless scripted runtimes,
rather than passing solely by rejecting every restricted turn.
`runBackendModuleContract` checks a `defineBackendModule` descriptor's nonempty
profile parsing and resolution, confirmation-pattern defaults/disablement,
typed invalid-JSON failures and occupied-id collisions. A backend that passed
the earlier suite may fail these stricter cases; the testing harness's
`permission` member is newly required.

Module manifests are two-phase: `defineModule({ name, configSchema?, setup })`,
where `setup(validatedConfig)` returns the contribution. The contribution is
schema-validated at load — unknown keys are load errors — and module commands
receive `{ root, json, config, taxonomy }`, so a command must NOT re-read
`brain.config` itself. The explicit `brain travel migrate` source-edit job
above is an exception: it never computes effective configuration or
serializes evaluated TypeScript. See [modules.md](modules.md).

## Hygiene review data (additive, #1024)

`brain hygiene reconcile` joins `brain validate`'s corpus checks into hygiene
detection through a published map from each validation rule to a category and
ID evidence. It never reads a validation message. The map, the per-category
evidence fingerprints and the invalidation rules are defined in
[the hygiene review decision](decisions/hygiene-review.md#what-the-implementation-defines).
Two IDs are fixed for review handlers: a broken wiki-link is
`hygieneId("broken-link", path, target)`, whether validation, audit or both
report it, and a missing or invalid required frontmatter field (`title`,
`type`, `created`, `updated`, `tags`) is `hygieneId("required-field", path, field)`.

The markdown under `context/hygiene/` gains disposition semantics. Each open
entry's generated lines add `- **Sources**:` and `- **Fingerprint**:`.
`dismissed.md` holds dismissed entries under `## Dismissed`; `_index.md`'s
counts add `- Dismissed: N`. A disposition made by `dismiss` or `snooze` writes
`dismissed-on:` or `snoozed-on:` (an ISO timestamp), an optional `reason:`, and
`disposition-fingerprint:`, the fingerprint it applies to. When that
fingerprint no longer matches, reconcile reopens the finding with an
`invalidated:` receipt. An entry moved by hand has no recorded fingerprint and
keeps its earlier behaviour. A date-only `until:` keeps its meaning, due on that
day. These files are the only store of a disposition: `brain index --force`
does not touch them.

`brain validate`'s output and exit status do not change: a dismissed or
snoozed error is still reported and still exits `1`.

## Hygiene selection (additive, #1026)

`brain hygiene next --json` refreshes the disposable index and reconciles the
markdown log using the same validation join and disposition invalidation as
`reconcile`. It selects only currently detected, open, non-informational
canonical findings. Unchanged dismissals and future snoozes are excluded;
unchanged snoozes return at their exact due instant. Resolved entries stay out
unless their problem is detected again and reconciliation reopens them.
Informational findings (including TODO/VERIFY) remain in the log and count as
`informationalNotShown`; they do not prevent a review from completing.

The finding retains `id`, `category`, `path`, stable `evidence`, `message`,
`severity`, raw `urgency`, `sources`, `fingerprint`, and `fingerprintFields`.
It adds a plain `title`, `line` (1-based in the actual file, or null), `field`
(for field findings, or null), `excerpt` (one line, at most 60 Unicode code
points around the first literal evidence occurrence, or null when absent or
unreadable), `handler` (`manual` until a repair handler is delivered),
`firstSeen`, and the log's `invalidation` receipt, if present. Reads for excerpts
stay inside the brain root. Missing fields are located by field name rather
than an invented line. Selection performs no content repair.

Ordering is lexicographic: severity rank, urgency rank, oldest `firstSeen`,
then canonical ID in code-unit order. Ranks are ordinals, never weighted scores.
The most severe contributing source determines severity; categories and model
judgments assign no priority.

| Source input | Severity class | Rank |
| --- | --- | --- |
| Validation `level: error`; audit/module/extra `severity: error` | `error` | 0 |
| Validation `level: warning`; audit/module/extra `severity: warning` | `warning` | 1 |
| No source severity (including silent edits/index table lag) | `unknown` | 2 |
| Audit/module/extra `severity: info` | `info` | 3; counted, not selected |

| Explicit source urgency | Rank |
| --- | --- |
| `immediate` | 0 |
| `overdue` | 1 |
| `due` | 2 |
| `upcoming` | 3 |
| Absent, `unknown`, or any unsupported value | 4 (`unknown`) |

Urgency is known only from a candidate's explicit `urgency` input (currently
`--extra` candidates); no deadline, category, message, age or snooze date
is used to infer it. If canonicalization joins multiple source urgency values,
the highest recognized urgency wins; unsupported values contribute `unknown`.
Raw urgency remains available separately on the finding. Missing first-seen
sorts after dated peers; its age is null. Future dates have age zero.

`priorityReason` is `{ severity: "error"|"warning"|"unknown"|"info",
urgency: "immediate"|"overdue"|"due"|"upcoming"|"unknown", ageDays: number|null,
newerWithSameRank: number, tieBreak:
"only-finding"|"severity"|"urgency"|"age"|"identity" }`. Age is whole elapsed
24-hour periods since the first-seen UTC day. `newerWithSameRank` counts eligible
peers with the same severity and urgency ranks and a later first-seen date.
`tieBreak` names the first differing comparison against the runner-up, or
`only-finding` when there is none. Neither field changes priority.

Counts are durable backlog totals after reconciliation, including the selected
finding in `eligibleRemaining`. `fixed` counts resolved log entries (including
`auto-disappeared`); it is not a session counter or proof of a handler's
successful repair. `dismissed` and `snoozed` count entries in those states.
`nextSnoozeDueAt` is the earliest known snooze instant, or null; unknown due
times remain snoozed and do not invent a date. `informationalNotShown` counts
currently detected open informational findings, once per canonical finding.

A configuration blocker has the loader's `message`, the detected config `path`
(or null), and `line`/`column` only when the original error identifies that
configuration file; loader implementation stack locations are excluded. It
never returns an empty-backlog receipt and writes neither the log nor the
index. Only `hygiene next` tolerates an invalid config; `reconcile`, dispositions
and `list` retain their refusal. With no configuration file, `next` retains the
CLI's missing-config write refusal. A check blocker lists unavailable checks;
reconciliation still preserves unseen entries under its existing failure
rules, and selection never claims completion from incomplete detection.

## Module hygiene context (breaking, #699)

A module hygiene check receives `HygieneContext<C>` = `{ queries, root, config }`.
The raw `db` content-index connection is **removed** (pre-1.0 break, ruled in
[#696](https://github.com/schlessera/brain-kit/issues/696#issuecomment-5969048668)).
`queries: ContentIndexQueries` is a frozen object core creates per audit, bound to
the brain root resolved once at creation. Its nine methods are those of the
[content-index query API](#content-index-query-api) with the same options minus
`brainPath`, and the same validation, defaults, caps, ordering and `QueryResult`
envelopes. A `brainPath` supplied anyway (including through a getter), an
argument to `readGraphMeta` or a later change to `ctx.root` cannot redirect a
query. Each call opens and closes its own read snapshot; no handle, SQL,
statement or transaction escapes. `ContentIndexQueries` is a type exported from
`@schlessera/brain` and `@schlessera/brain/queries`; core does not export a
constructor. `root` and parsed `config: C` are unchanged, and checks may still
return synchronously or asynchronously.

A failed query returns `ok: false` with its `QueryCode`; a check should throw on
it, which the audit reports as the existing single `module-hygiene` warning and
`failedChecks` entry rather than a clean result. The jobs `jobs-stage` check does
so with the message `opportunity stages could not read the content index
(<code>): <action>`, and its selection is unchanged: every non-archived,
non-null-status `opportunity` whose path is exactly `status.md` or ends in
`/status.md` with ASCII case folding, in path order and uncapped. Migration: replace
each `ctx.db` SQL read with the query returning the same rows and keep any path
matching in module code ([modules.md](modules.md#hygiene-checks-read-the-index-through-ctxqueries)).
The [direct-SQL guarantees](#braindb-direct-sql-reads) for other readers are unchanged.

## Module dormancy (additive, #527)

Each configured module entry gains optional core-owned `enabled: boolean`.
Omission means active. Core validates the flag and removes it before validating
the module's domain block; dormant domain config is still validated and retained.
`LoadedModule.state` is supplied by the loader as `"active" | "dormant"`;
the optional authoring property preserves constructed legacy contexts, where
omission means active. CLI, scheduler metadata, skill discovery, classifier
hints and module hygiene all read that same loaded state. Dormant types,
directory anchors, exclusions and content rules remain registered.

`ModuleContribution.instructions?: { text: string }` is strictly validated
authoritative context returned by `setup(validatedConfig)`. Text is nonempty
and contains no ownership markers. Modules declaring instructions have a
lowercase name matching `^[a-z][a-z0-9-]{0,30}$`; existing manifests without the
field retain their naming behavior. The optional manifest
`canBeDormant?: boolean` defaults to permitted; `false` makes CLI disable refuse
with `dormancyReason?: string` or a default explanation. A declared reason is
nonempty. Existing module authoring calls and required fields remain unchanged.

Toggles preflight source edits and all instruction owners before writes. Legacy
mixed generated regions require explicit migration, preserving personal prose
outside module-owned spans. No paragraph inference, whole mixed-section deletion
or saved-prose restoration occurs. The source-preserving writer changes only a
literal entry's flag; an ambiguous executable target is refused rather than
serializing its evaluated config. The same-state command can synchronize context
after an explicitly reviewed manual flag edit. Validation/ownership failures
leave config, managed links and instruction bytes unchanged. Filesystem or emitter
failures are reported as failures and require retry; success is not reported for
an incomplete context sync. See [the format and migration guide](modules.md#instruction-migration).

The list estimate is the sum of characters/4 token estimates of the module's
discoverable model-invocable skill descriptions under existing precedence and
its contributed instruction text. It estimates hypothetical active context even
when dormant, without attributing shared contracts, personal prose or full skill
bodies. It counts the authoritative contribution once, rather than summing copies
in different agent entry files. The existing `enabled`/`available` envelope and
declared fields remain; dormant cron metadata is empty. Namespace execution exits
1 with `module <name> is dormant — brain module enable <name>` without importing
or executing the module command. Running sessions keep their loaded state;
MCP startup registration reads that same loaded state and skips dormant
modules before importing tool definitions. Dormancy is context control, not
permission revocation.

## Module settings (additive, #528)

`ModuleManifest.settings?: ModuleSettings<C>` describes a generic editor over
`configSchema`: data-only fields, choices, nested records, ordered lists and
record variants, plus optional module CLI actions, computed notes and a pure
migration planner. Descriptions are validated at module load. The leaf kinds
are `text`, `number`, `toggle`, `choice`, `multichoice`, `tags` and `weights`;
`record`, `list` and `variant` compose them. Unlisted representable schema
fields appear through the generic renderer. Unsupported fields show their
complete JSON value read-only; unchanged JSON subtrees retain their bytes.
Modules do not contribute React implementations. A module using settings has
a lowercase name matching `^[a-z][a-z0-9-]{0,30}$`.

Core reads `settings/<module-name>.json`, a JSON object without the reserved
`enabled` key. Own object keys merge recursively over the domain block in
brain config; arrays, scalars and null replace. The original `configSchema`
then parses the combined input and supplies defaults. Both active and dormant
modules use this path, including ordinary config checks and `brain validate`.
Invalid hand-edited settings fail validation rather than silently falling back.
Config reads expose effective validated module blocks. JSON never replaces
TypeScript logic or rewrites its source. Settings files and their parent may
not alias another path through symlinks; a symlinked brain root remains valid.

`brain module settings <name> --json` returns:

```text
{ module, key, state, canBeDormant, dormancyReason,
  schema, values, inherited, overrides, provenance, inheritedProvenance,
  revision, notes, ui: { fields, actions, migration } }
```

`schema` is generated from the declaration's Zod input schema, with
unrepresentable leaves shown read-only. `values` are effective validated
settings; `overrides` are the unnormalized JSON source object. `inherited`
shows values without that JSON, and provenance distinguishes `default`,
`brain-config`, `saved` and `migrated`. `revision` is an opaque quoted hash of
the loaded config source and settings bytes. Do not derive meaning from it.

`--set dotted.key=value` parses a JSON value when possible, otherwise a
string; numeric path components address existing arrays. `--stdin` accepts
the complete overrides object. Both use the same validated writer as the UI.
`--revision REV` requires a matching revision; CLI omission uses a freshly
read revision. `--preview` with `--set` or `--stdin` validates a draft and
computes module notes without writing. `--action <id>` invokes the declared
command in its owning module's namespace, using saved config and the existing
dormancy guard; it cannot be combined with a settings save.

Successful saves add `changed: boolean` and `commit: string | null` to the
snapshot. A changed save atomically replaces only the module JSON file and
creates exactly one git commit. Structurally unchanged requests preserve all
file bytes and produce no commit. The transaction lock serializes revision
checks, writes and commit. Stale revisions or a busy transaction return 409;
validation returns 422 with `{ error, status, errors: [{ path, message }] }`
and writes nothing. Unavailable modules return 404. A write/commit failure
restores prior files and target index entries, preserving unrelated staged
work. Pre-staged target changes are refused. These errors exit CLI 1.

`--migrate --preview` runs the module's pure planner and returns its source
preview, values, paths and revision. `--migrate --revision REV` applies that
reviewed plan through the same validator and transaction. Changed settings
and content are committed together once; stale input, validation, write or
commit failure changes neither source. Jobs moves known scoring keys from
criteria frontmatter into `settings/jobs.json.scoring`, retaining raw keyword
casing, flat/tiered forms, coercible numbers, odd match values and absent
optionals. Unknown scoring keys and unrelated frontmatter/prose stay in the
document. It proves identical `parseScoringConfig` outputs before writing.
Legacy frontmatter remains a read fallback until explicitly migrated.

`module list --json` adds `settings`, `canBeDormant` and `dormancyReason` to
loaded entries in its existing `enabled` array. A malformed module appears as
an unavailable row with `error`, while valid neighbors remain readable and
editable; actions still refuse globally invalid config. The Modules editor's
HTTP routes are listed as internal transport in [http-api.md](http-api.md).
GET settings supplies ETag; PUT requires If-Match (428 when absent), passes
through field errors and 409 conflicts, and uses the CLI writer. Every route
uses the existing authenticated-principal and origin guards. Migration,
dormancy and actions are separate confirmed requests. Domain saves never
change the core-owned `enabled` flag, migrate instruction ownership, hot
unload a module or cancel running sessions.

## Module tools

`ModuleContribution.tools` declares lazy MCP definitions by local name.
`brain mcp` imports these definitions at startup and serves them after the
eight core tools, in module config order and then declaration order. A loader
may resolve a `ModuleTool` directly or an object with a `default` tool export.
Other CLI commands do not import the definitions.

A module dormant at startup contributes no tools: its definitions are not
imported and its tools are absent from `tools/list`. The filter uses
`LoadedModule.state`; omission in constructed legacy contexts means active.
`brain module list --json` still includes dormant modules and their declared
canonical tool names. Marking a module dormant on disk leaves the running
process's registered tools callable; the next process omits them. In-flight
calls are not cancelled and completed effects are not rolled back. Dormancy
controls context and is not permission revocation.

Core composes each name as `<module>_<local>`, at most 64 characters. Modules
with nonempty `tools` must match `^[a-z][a-z0-9-]{0,30}$`; `brain` is reserved.
Local names must match `^[a-z][a-z0-9_]{0,31}$`. Invalid names or non-function
loaders fail module loading. An invalid config retains the existing degraded
MCP behavior: only core tools load, with a config warning and writes disabled.
Registration also checks composed names against all earlier registered names
before registering any tool from that module.

`brain module list --json` adds `tools: string[]` to each enabled module,
containing canonical names in declaration order, or `[]`. Listing imports no
tool definitions. `brain module lint <name> --json` retains its
`{ module, findings, errors }` envelope and adds error rules `tool-load`,
`tool-name`, `tool-annotations`, `tool-schema` and `tool-docs`. Lint uses MCP
startup's definition validator, additionally requires a description for every
input, and checks that the module README's level-two `MCP tools` section names
every declared canonical tool. Annotation/schema errors use their specific
rule instead of a duplicate `tool-load`; import and other definition failures
use `tool-load`. Invalid names remain load errors for normal commands and are
reported as `tool-name` when linting the rejected module.

The `ModuleTool`, `ToolContext` and `defineModuleTool` exports are
`@experimental` until 1.0. The identity helper infers `run`'s input and result
from its schemas. A definition requires a nonempty description, strict zod 4
object `inputSchema` and `outputSchema`, and a `run` function. Both schemas
must be representable as JSON Schema. Annotations must explicitly state
`readOnlyHint` and `openWorldHint`; `destructiveHint` is also required when
`readOnlyHint` is false. An optional title and `idempotentHint` are supported.
Annotations are client hints, never permission grants.

If any import, definition or collision check fails, that module contributes
zero tools. Core and other modules continue serving. The failure appears on
stderr and in the `warnings` of core tools that return warnings.

The SDK validates input against the full strict schema before calling
`run(input, { root, config, taxonomy, signal })`. `config` is the owning
module's validated block; `signal` aborts when the client cancels the request.
Resolved results appear in `structuredContent` and in the first text block
as compact JSON. The SDK validates them against `outputSchema`. Input or
output validation failures return `isError: true`; thrown operations return
`{ isError: true, content: [{ type: "text", text: "Error: <message>" }] }`.
A tool states and applies its own result cap; core adds no generic truncation.

The tool set is fixed for the process lifetime. The server sends no
`notifications/tools/list_changed`, although the SDK advertises
`tools.listChanged`. Config edits take effect in the next process; they do
not revoke existing handles, cancel calls or roll back completed effects.
Calling a name this process did not register returns `isError: true` with
`MCP error -32602: Tool <name> not found`.

Namespacing prevents collisions and does not exclude a tool from compatibility
policy. Each module owns its documented tool names, schemas and behavior.
First-party tools enter this contract when shipped and follow the project's
versioning rules; third-party modules document the same policy in their own
packages. Adding a supported tool is a minor change. Removing or breaking one
requires a maintainer ruling for first-party tools and a breaking release
under the applicable package's policy. A tool and its CLI subcommand call the
same deterministic operation. See the
[module-tool decision](decisions/module-mcp-tools.md) for the full specification.

### First-party module tools

| Tool | Owning module | Inputs | Result |
| --- | --- | --- | --- |
| `jobs_review` | `@schlessera/brain-module-jobs` | Optional `status` (one of `REVIEW_STATUSES` or `all`, default `queued`), `min_score` (finite number, inclusive), `limit` (positive integer, default 20, clamped to 50), `source` (one of `ALL_SOURCES`). Unknown keys and invalid values are tool errors. | `{ jobs: JobSummary[] }`, in the CLI review order: descending relevance score, then descending publication date, excluding duplicates. |

`jobs_review` (0.40.0+) calls the same validated operation as
`brain jobs review --json`; the CLI's full-row `{ jobs }` envelope and human
output remain unchanged. The tool returns a compact projection, at most 50
entries. Each summary has required fields `id: integer`, `title: string`,
`company: string`, `source: string`, `review_status: ReviewStatus`,
`relevance_score: number`, and `tags: string[]`; `location`, `remote_type`,
`salary_raw`, `salary_currency`, `published_at`, and `url` are required
`string | null` fields; `salary_min` and `salary_max` are required
`number | null` fields. No full description is returned. Absent or invalid
stored tags produce `[]`. Stored source identifiers, including retired boards,
remain readable; the input filter accepts the current `ALL_SOURCES` only.
Both result objects are strict.

Salary bounds retain the ingested **annual EUR cents**, including hourly
annualization; `salary_currency` retains the original listing's label and is
not the denomination of the converted bounds. The tool uses its owning
module's contained `dbPath`. A missing database returns `{ jobs: [] }`
without creating it; an existing database may undergo the same schema
initialization/migration as the CLI. Annotations are `readOnlyHint: true` and
`openWorldHint: false`, with backend admission governed separately.

## Guarantees consumers may rely on

- **Containment.** Everything the CLI writes stays inside the brain root.
  Config-supplied directories, module config paths, and caller-supplied
  document paths are repo-relative (no absolute, `~`, `..`, or control
  characters) and resolved through a symlink-aware canonicalizer, so neither a
  symlinked directory nor a dangling symlink redirects a write out of the repo.
- **Mutating commands require an initialized brain.** `add`, `import`, `index`,
  `archive`, `accept-mtime`, `process`, `maintain`, `sync`, `skills sync`, and
  `setup`, plus `okf export`, exit 1 when no `brain.config` is found rather than initializing a
  stray directory. Read-only commands (including `skills lint`) still run.
- **OKF exports are derived and isolated.** `okf export` only writes inside a
  taxonomy-excluded directory, wipes that derived directory before generation,
  and never modifies source concept files. `okf check` is read-only and accepts
  third-party bundle directories.
- **`module list --json` cron entries are shape-constrained.** A container
  entrypoint materializes them into a crontab with root privileges, so `name`
  is kebab-case, `schedule` is a 5-field expression, and `command` is a plain
  `brain …` argument string — no newlines or shell metacharacters can appear.
  **A consumer should still re-validate before interpolating**, including the
  module KEY: defense in depth is the contract here, not producer trust.
- **`modules` config keys** must be an npm package specifier or a contained
  `./path`, and are canonicalized before `import()` — a symlink cannot make the
  loader execute code from outside the root.

## Recommended consumer hygiene

Keep one **contract test** that runs `brain search "x" --json` and
`brain briefing` against a fixture brain and asserts the envelope shapes
above — cheap insurance against silent breaks.

## Configuration exclusions

`exclude.files` contains exact relative file paths; `exclude.dirs` excludes
directories and their descendants, and `exclude.segments` excludes matching
directory segments at any depth. Directory pruning and output-directory
authorization consult only directory/segment rules, never exact-file rules.

**Breaking in the next minor release (approved in #224):** configuration
loading rejects `exclude.files` entries ending in `/`, which were previously
accepted and could make stats disagree with indexing. The error identifies
the field and value and directs the author to `exclude.dirs`. To exclude a
whole directory, replace `files: ["drafts/"]` with `dirs: ["drafts"]`.
Valid exact-file, directory and segment exclusions keep their semantics;
CLI JSON shapes are unchanged.

## Backend confirmation-pattern initialization

**Pre-1.0 breaking tightening (#251):** `compileConfirmPatterns` and both
first-party backend constructors reject a nonempty `confirmBashPatterns` list
if no regex compiles, before turn or tool activity. The server's
`BRAIN_UI_CONFIRM_BASH` regex list follows the same initialization rule. The
error names both configuration fields, preserves invalid-source diagnostics,
and directs the caller to repair the list or intentionally use `[]`; exact
error prose is not a machine schema.

Missing backend configuration still uses the shipped defaults, and explicit
`[]` still disables confirmation. Mixed lists report and skip invalid entries,
preserving the valid patterns, their matching order and effects. The server's
existing malformed-JSON and structural-entry fallback retains its semantics.
The rationale is recorded in [confirm-patterns.md](decisions/confirm-patterns.md).

## Nullable asset enrichment

**Approved pre-1.0 breaking API change (#411):** `Enrichment.describeAsset`
from `@schlessera/brain` now returns `Promise<string | null>` rather than
`Promise<string>`. `createEnrichment` returns `null` when its completion
provider lacks vision (without calling `complete`) or returns empty/whitespace
text for an image or PDF. Non-empty output is trimmed and accepted even if it
equals the title. Errors still reject; `CompletionProvider.complete` and
`Enrichment.generateChunkContext` retain their string return types.

Callers handle `null` before persisting, caching or embedding a description.
Custom implementations return `null` for no description and non-empty strings
for success; always-successful implementations may retain `Promise<string>`.
The shipped `@schlessera/brain/testing` completion contract suite now asserts
`null` and zero completion calls for no vision, and `null` for empty output.
[Caller migration guidance](extending/completions.md#migrating-asset-enrichment)
includes an example.

The indexer leaves undescribed assets on their document/chunk/FTS placeholders,
keeps them findable by title, and queues neither description cache entries nor
embeddings for them. A later `--embeddings` run retries unchanged assets. A
`null` report says only that no description was returned, without attributing
a cause. Existing cached strings are preserved, including title-equal strings;
this change prevents new fallback entries and does not identify old ones.
Use [`--forget-cache <path>` then `--embeddings`](concepts.md#sidecar-caches)
to regenerate a known bad entry; forgetting resets sidecar and database state
for all assets sharing its bytes. Rebuilding only `brain.db` can reuse the old
sidecar and is insufficient.

## Backend-authoring permission toolkit

The deliberate toolkit is exported from `@schlessera/brain-ui-sdk/server`:

| Operation | Public signature types / result |
| --- | --- |
| `decideToolPermission` | `ToolPermissionDecisionInput` → `ToolPermissionApproval | null` |
| `createToolPermissionRequest` | `CreateToolPermissionRequestInput` → `PermissionRequest` |
| `requestToolPermission` | `Pick<BackendBridge, "requestPermission" | "activity"> | null | undefined`, `PermissionRequest`, optional `RequestToolPermissionOptions` → `Promise<PermissionDecision>` |
| `checkEditedApproval` | `EditedApprovalCheckInput` → refusal message `string | null` |
| `compileConfirmPatterns` | `readonly ConfirmPatternSource[]`, invalid-source callback → `CompiledConfirmPattern[]` |

These operations, their exported types and every signature-reachable bridge,
activity and protocol type are intentional authoring surface. They remain
experimental until 1.0, then stabilize under the existing versioning policy;
this does not schedule or freeze 1.0 early. The API report records the complete
signatures and reachable types. The
[authoring guide](extending/agent-backends.md#the-public-permission-toolkit)
shows the binding, and the
[decision inventory](decisions/backend-authoring-toolkit.md) records the exact
public/internal classifications under #343 Q1/Q2.

Adapters decide before dispatch, honor denial and use the same snapshotted
`updatedInput` for checking and application. Missing bridges and no-grant
surfaces deny; no-grant surfaces never ask the host. A throwing denial-activity
reporter cannot change the decision. Bridge rejections remain rejections for
the adapter to translate. Edits introducing a per-use confirmation absent from
the original input are rejected, including a changed full shell command or
archive target; an own `__proto__` key is rejected. Allowed safe edits and
unchanged confirmed inputs may execute.

Confirmation sources accept strings and `{ pattern, effect }`, compiled
case-insensitively in source order. Mixed lists report invalid entries and
retain valid ones; a nonempty all-invalid list throws. `[]` is the intentional
opt-out. Explicit tool-name matching, tool grants versus command confirmations,
archive checks and enforced-turn posture remain promised behavior.

Bundled defaults can change with documented user-visible release notes while
preserving those guarantees. Their precise entries and wording are not frozen;
policy formats and behavioral guarantees are not exempt from versioning.
Subscription-auth action values, mapping and actionable instruction helpers
remain public under the existing wire contract; instruction wording may improve.

Pre-1.0 import migration: the SDK's `DEFAULT_CONFIRM_BASH_PATTERNS`,
`ARCHIVING_UPDATE_REASON`, `archivesDocument`, `bashCommand`,
`SubprocessEnvAudience`, `SUBPROCESS_ENV`, `filterSubprocessEnv` and
`parseSubprocessEnvExtra` move from `/server` to `/internal`. Claude's
`DEFAULT_CONFIRM_BASH_PATTERNS` alias and `VOICE_ALLOWED_TOOLS`, and pi's
`DEFAULT_PI_ALLOWED_TOOLS` and `TOOL_RISK`, move from their ordinary entries to
those packages' `/internal` entries. These explicit internal paths are for
first-party implementation sharing at the same lockstep version, with no
compatibility guarantee. Their existence does not define another extension
seam or classify the other exports covered by the package-wide inventory.
Operator environment configuration retains its documented meaning; the
subprocess implementation table is internal.

## Durable share and CLI intake (additive, #679)

`brain queue add --server ORIGIN --key KEY [--credential-file FILE]
[--title TITLE] [--text TEXT] [--url URL] --json` queues intake on the UI server.
It does not replace `brain add`, index content or mutate the local brain.
It runs without a local brain configuration. At least one nonempty content
field is required, and the explicit key must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`.

The exact success envelope is `{ "queued": true, "created": boolean,
"threadId": string, "itemId": string, "stagingId": string }`, exit 0. Duplicate
key/content returns the original IDs with `created: false`. A different payload
for that key is refused. Queueing only creates a thread and triage item; neither
queueing nor `trusted` provenance authorizes filing or inference.

Transport failures in JSON mode are `{ "queued": false, "error": {
"code": string, "message": string } }`. Codes are `credential_file_invalid`
(exit 1), `unauthorized` (1), `key_conflict` (1), `queue_failed` (2 for a 5xx,
otherwise 1), `invalid_response` (2), and `server_unavailable` (2). The exact
unavailable-server result is `{ "queued": false, "error": {
"code": "server_unavailable", "message": "Queue server unavailable; retry with
the same --key." } }`. Normal CLI argument/usage errors keep the existing
stderr/exit-1 convention. Human success explicitly says content has not been filed.

`--server` must be an HTTP(S) origin, with no credentials, path, query or
fragment. HTTP is allowed only for loopback; other origins require HTTPS.
The optional private credential file contains exactly `{ "server": "ORIGIN",
"cookie": "SIGNED_PRINCIPAL_COOKIE_VALUE" }`, at most 4096 bytes, a regular
file with no group/other permission bits; symlinks are refused. Its normalized
server origin must match `--server` before any request. The cookie is the
existing `brain_ui_session` principal cookie, including a delegated credential
returned by `POST /api/auth/principals`; it retains its existing expiry and
revocation semantics. Cookie authentication applies in password mode; other
server auth modes keep their existing configured authority. No provider key,
ambient cookie environment variable or credential for another audience is read.
Requests have a 10-second timeout and never follow redirects; response JSON is
bounded to 64 KiB. The cookie is never emitted in an error or result.

The transport is protected `POST /api/queue`, whose strict request, response,
errors and recovery promises are specified in [HTTP API](http-api.md#authenticated-cli-intake-additive-679).
Shares keep their existing 201 `ShareIntakeResult` envelope and interactive
confirmation flow, while the real app also records an untrusted triage item.
Unknown multipart authority fields are refused. Duplicate normalized shares
reuse the original staging result; source/principal provenance is server-owned,
immutable and separated from CLI dedup keys. Queue-backed staging is exempt
from legacy opportunistic pruning. Standalone staging retains its old lifetime.
No production autonomous dispatch is enabled by these additive surfaces.

## Shared geo library (additive, #525)

`@schlessera/brain-geo` is a concrete leaf library. Its root export supplies
`RoutePoint` (`lat`, `lon`, nullable `elevation_m` and ISO `time`), strict
`parseGpx`, `routePoint`, great-circle `distanceM`, travel-compatible
`routeMetrics`, `trimRoute`, `quantizeRoute` and `writeGpx`. Existing travel
commands retain their JSON types, strict rejection, rounding and serialization.
The [travel metric contract](../packages/module-travel/README.md#route-import)
continues to apply; metrics/writing require nonempty valid geometry.

`parseTrackGpx(source)` adds recovered file geometry. It returns `segments`,
`warnings`, `kind` (`track` or `route`), `status` (`ok`, `partial` or `no_line`),
`partial`, `counts` (`input`, `retained`, `omitted`, `segments`) and `omissions`.
Each omission names its zero-based selected-source point `index`, primary
`reason` and all `reasons`: latitude/longitude missing-or-invalid or out-of-range.
Counts cover the selected track/route geometry, not foreign metadata or waypoints.
Every omitted point splits the geometry. Valid isolated points stay in the
returned sections as evidence; `no_line` means no section has two points.
Track sections take precedence when usable, otherwise usable routes do.
With neither, track evidence takes precedence over route evidence when present.
Malformed/unsafe/over-limit inputs throw rather than becoming partial results.

Both parsers use the same guarded XML reader. Recovery never modifies the source,
bridges gaps, changes optional unknown values or proves recording/travel from file
metadata. [Shared ownership and recovery](decisions/geo-operations.md) explains
why the new policy is separate from travel's strict compatibility entry point.

`summarizeTrack(parsed, source)` returns the original counts/status, copied geometry,
file source, `[west,south,east,north]` bounds, start/end, shape, warnings, `unknown`
field/reason records and method metadata. Its `measurements` contain `distance`,
`ascent`, `descent`, `altitudeMin`, `altitudeMax`, `elapsed` and `movingTime`, each
with `{ value: number | null, unit: "m" | "s", scope: "usable_sections" }`.
Distance uses unsimplified great-circle edges on a 6,371,008.8 m sphere. Sections
with fewer than two points remain evidence but do not contribute measurements.
Known zero remains zero. Elevation requires complete eligible section samples;
ascent/descent share three-point-median smoothing and 3 m hysteresis. Elapsed
sums each section's ordered, complete first/last timestamp interval, retaining
pauses and excluding gaps; absent/invalid/decreasing timestamps remain unknown.
Moving time is always unknown with `estimator_not_in_scope`. No-line geometry has
unknown distance rather than a successful zero. Absent bounds/start/end and
unknown shape carry reasons as well. An optional recording claim retains its
text and `verified: false`; the library never infers recording from timestamps.

`normalizeTrack(sections, kind?)` accepts arrays of normalized point objects with
numeric `lat`/`lon`, optional `elevation_m`/`time` and a default `"track"` kind.
It returns the same `ParsedTrack` recovery/count/omission contract as GPX.
Malformed structure rejects; invalid coordinates omit/split, never coerce or
clamp. At most 200,000 points (including omissions) and 200,000 sections are
accepted. Missing/invalid metadata is unknown; caller input remains unchanged.
`EARTH_RADIUS_M` is the 6,371,008.8 m sphere used by all distance methods.

`nearestTrackPoint(track, query, toleranceM)` returns status/partial/counts,
`distance: {value: number | null, unit: "m"}`, closest `point: {lat,lon} | null`,
`location: {section,index,fraction} | null`, nullable `withinTolerance`, unknown
reasons and method metadata with `"great_circle_segment"`, radius, tolerance and
`"retained_geometry"` scope. Minor arcs include interiors; gaps remain absent.
Retained singletons and repeated points are valid spatial evidence. Empty geometry
and ambiguous antipodal edges yield unknown; invalid queries/tolerances reject.

`trackCoverage(A, B, {toleranceM, sampleSpacingM?})` returns status/partial, counts
for both inputs, direction `"A_relative_to_B"`, nullable ratio/covered metres,
usable metres of A, nullable `{minimumRatio,maximumRatio}` bounds, unknown reasons
and method parameters. Its `"arc_length_midpoints"` estimate measures only A's
usable sections within tolerance of B's usable sections. Bounds use distance's
1-Lipschitz property to expose uncertainty. The default spacing is
`max(0.1,min(5,toleranceM/4))` metres; explicit spacing is >0 and ≤1,000 m.
Tolerances are finite, nonnegative and at most Earth's half-circumference.
100,000 samples / 5,000,000 comparisons bound analysis. Zero usable length in A,
no usable line in B, ambiguous antipodal geometry and analysis-limit exhaustion
return null ratio/covered length/bounds with reasons. Partial inputs remain partial;
no gaps are filled and no denominator is invented. All helpers require validated
`ParsedTrack` inputs from the shared parser/normalizer.

### Shared geo configuration and server geocoding

The root `geoConfigSchema`, `GeoConfig` and `GeoConfigInput` describe concrete
configuration. All services are disabled/unconfigured by default; `userAgent`
defaults empty. Endpoints must be credential-free HTTP(S) URLs without query or
fragment. Geocoding has `enabled`, optional `url` and `publicServiceEligible`;
the public Nominatim endpoint requires the latter explicit responsibility flag.
Routing configuration holds per-mode prepared datasets and an off-by-default
eligible demo flag; Overpass holds an enabled flag and at most three endpoints.
Optional `cacheDir`, `cacheTtlMs` (0–30 days, default one day), `timeoutMs` and
`admissionWaitMs` (100 ms–60 s, defaults 5 s) and `minimumIntervalMs` (0–60 s,
default 1 s) configure the shared concrete clients. Public operator floors cannot
be lowered by configuration. No provider registry is added.

`@schlessera/brain-geo/server` exports `GeoClient`, result/candidate/attribution,
error/source and runtime-option types. `new GeoClient(config?, runtime?)` validates
configuration. Runtime options accept `fetchImpl` and shared `admissionDir`; they
default to real fetch and the user's global geo admission directory. The root
geometry/configuration entry point imports no server I/O.

`geocode(query)` and `reverse(lat,lon)` return `GeoResult<GeocodeCandidate[]>` with
`status`, nullable `value`/`source`/`error`, `warnings`, `attribution` and candidate
`counts`. Success is `ok`, multiple matches `ambiguous`, usable mixed replies
`partial`, and genuine empty matches `no_match`; disabled and failure statuses are
distinct. A candidate has display/summary/address, numeric point, nullable bounds
and OSM identity, unknown accuracy and its reason. Inputs validate before dispatch.
No-match is recognized from an empty search or the exact Nominatim reverse error;
an unrelated 404 is never fabricated as no-match.

Source reports service/endpoint, `fromCache`, nullable `fetchedAt`/`cacheAgeMs`,
`requestSent` and `transfer: {data,sent}`. Cache hits preserve fetch age and indicate
no new transfer. Errors distinguish `disabled`, `configuration`, `ineligible`,
`capability`, `input`, `timeout`, `network`, `http`, `admission_denied`,
`admission_timeout`, `bad_response`, `response_limit` and `cache_unavailable`, with
optional HTTP/retry details. Valid provider data retains attribution and qualified
accuracy. No transient failure is stored as no-match. Disk caching/admission is
shared across cooperating processes; the [geo guide](../packages/geo/README.md)
documents local aggregation, bounds and fail-closed orphan recovery.

### Shared routing results

`GeoClient.route(points, mode)` accepts 2–100 ordered numeric points and a
`RoutingMode` (`car`/`foot`/`bike`). Configured entries carry `url` through the
route-service prefix, `profile`, `preparedMode`, `dataset` and `verification`.
The mode must match the declared prepared dataset. Public FOSSGIS entries also
require explicit eligible demo configuration and its verified endpoint/profile.
Otherwise the client returns a capability/eligibility error without transfer.

`RoutingResult` retains `request: {mode,points}` and `attempts` even with no route.
Its nullable `CalculatedRoute` contains `kind: "calculated"`, unsimplified geometry,
all requested/snapped waypoints and snap distances, ordered legs with nullable
distance/duration, unit-bearing aggregate distance (`m`) / duration (`s`), unknown
reasons and provider-calculation method metadata. Missing/invalid estimates remain
null and partial; zero remains zero. Geometry/waypoint/leg shape must match the
request. Calculated duration does not establish movement or recording.

The served source adds dataset name/prepared mode/profile/verification and
`fallback: {used,reason,primaryEndpoint}`. Cache hits retain these and original
fetch age. Every attempt lists endpoint/cache status/request transfer and error;
a cached demo result can follow a newly transmitted primary attempt. Cache identity
includes prepared dataset/mode metadata. Requested points are snapshotted before
asynchronous work and are never overwritten with provider-snapped points.

Status is `ok`, `partial`, genuine `no_route`, disabled or error. `NoSegment` has
error code `no_segment`; OSRM errors retain `serviceCode`. Invalid query/input and
disabled/capability errors remain distinct from no-route and are never cached as
it. The demo is off until explicitly enabled and eligible. A missing primary or
one genuine availability failure can use one matching demo attempt; denial,
admission/cooldown, invalid/no-segment/no-route and local storage failures cannot.
An endpoint never retries itself as its own fallback. No geometry is fabricated.

### Shared Overpass POI results

`GeoClient.poi(PoiQuery)` accepts exactly one of `near: {lat,lon}` or
`alongTrack: ParsedTrack`, `radiusM` (1–5,000) and 1–10 AND tag filters. Values
are exact strings or `true` for tag presence, never arbitrary QL/regex. Track
queries retain section gaps, including isolated points, and refuse beyond 2,000
points, 100 nonempty sections, 64 KiB UTF-8 QL or a radius-expanded 5-degree extent
on either axis/pole crossing. Wide/date-line track envelopes are spatial-budget
errors; valid source coordinates are unchanged. No track simplification occurs.

`PoiResult` extends `OverpassResult<PointOfInterest[]>` with query parameters/counts,
nullable recovered-track metadata (`partial`, original counts/omissions), response
counts, `truncated` and method/limit metadata. Status is `ok`, `partial`, genuine
`no_match`, disabled or error. A POI retains OSM identity, nullable name, point,
`position: node | bounding_box_center`, tags, `openingHours: {value,interpreted:false}`,
representative-point distance (`m`) to the query point/retained track and unknown
reasons. Missing/empty opening-hours text is null/`not_mapped`; there is no current
open/closed interpretation. Selection uses Overpass around geometry. A way/relation
center is a representative bounding-box center and may lie outside the radius;
its distance is not the distance to its entrance/full geometry. Distance uses the
shared sphere/minor arcs, never an invented gap. Empty/undefined track distance
stays null with a reason.

Responses contain at most 1,000 usable results. A 1,001st sentinel marks a partial
capped answer with one counted omission and warns that more may exist. More than
1,001 elements is `response_limit`; invalid/duplicate elements are counted omissions,
and wholly malformed nonempty responses fail rather than cache as no-match.
Opening-hours absence alone does not mean malformed data.

`OverpassResult<T>` retains all endpoint/cache/transfer/error attempts and source
fallback `{used,reason,primaryEndpoint}`. Ordered endpoint configuration is capped
at three, duplicates are attempted once, and a cached fallback remains visible
after a primary attempt. Genuine availability failures can fall through; admission,
cooldown, quota/resource denials and local storage failures cannot, even to a cached
alternate. HTTP 504 has Overpass resource-admission meaning. JSON resource/quota
remarks likewise refuse and persist cooldown; incomplete timeout remarks are errors,
never genuine empty matches. Attribution accompanies usable OSM replies.

### Shared background geometry and SDK adapters

The geo root exports the existing SDK pure coastline helpers/types, without server
I/O. SDK server exports retain their names/types and alias the shared implementation.
`CoastlineConfig` additively accepts optional canonical `geo: GeoConfigInput` and
shared runtime `admissionDir`. Required legacy enabled/url/User-Agent and optional
timeout/fetch injection remain supported. `fetchCoastline(request, config)` retains
the exact `CoastlineResult` keys and result-or-empty/partial failure behavior;
`enabled:false` prevents all requests, including with a canonical config supplied.
Legacy settings adapt to concrete shared cache/admission without wire changes.

`GeoClient.coastline(CoastlineRequest)` returns `CoastlineServiceResult`, with the
existing geometry value and per-layer `queries: {layer,result}[]`. Layers are
`CoastlineLayer` (`coastline`, `roads`, `streets`); each result is
`OverpassResult<CoastlineLayerGeometry>` (`lines`, input/omitted counts). Its source
is the latest successful layer, or latest attempted layer if none succeeded; the
complete query list is authoritative for mixed sources/cache ages/transfers/errors.
Bounds are finite in-range ordered `[west,south,east,north]`, capped at 5 degrees
per axis; width is >0 and ≤16,384. Existing detail/tolerance/geometry algorithms
are preserved. Service geometry is bounded to 10,000 ways/200,000 vertices,
including malformed entries, and shared body/time budgets. Mixed malformed data
or failed layers with usable geometry are partial; no usable data after failure
has null value/error. Genuine empty successful geometry has `no_match` and empty
value. Refusal/configuration/local storage failures stop later layers. Attribution
and every layer's endpoint/fallback/attempt evidence remain available.

`reverseGeocode(coords, ReverseGeocodeConfig)` retains exactly
`{displayName,summary,address} | null`. Required legacy enabled/url/User-Agent
settings remain; additive optional `publicServiceEligible`, canonical `geo`,
`fetchImpl` and shared `admissionDir` select the concrete client/runtime.
Canonical service/cache configuration wins; legacy `enabled:false` still prevents
requests. Public Nominatim requires explicit informed eligibility, which is never
inferred from enabled and grants no permission beyond the public-service policy.
An ineligible public request is an existing nullable failure path, preserving raw
coordinates in the location tool. First-party backends default
`NOMINATIM_PUBLIC_SERVICE_ELIGIBLE` to false; only recognized truthy tokens opt in.
Configured nonpublic endpoints remain available. Responses are validated and
cached by endpoint/exact coordinates; transient failures are not cached as null.
No MCP/tool/result/wire shape or protocol revision changes.

### Canonical consumer configuration

`brain.config.ts`/JSON optionally accepts `geo` with the shared `GeoConfigInput`
shape and defaults. Root omission remains omission: parsing `{}` produces `{}`,
and new services remain off. `BrainConfig` is the authoring input type so the
new nested defaults do not require callers to write every optional field.
`defineConfig` remains a typed identity function; load-time schema validation
still validates the whole configuration. Core's optional geo response-cache
directory uses `repoRelativePathSchema` and resolves inside the brain through
`safeResolve`, including symlink containment. `repoRelativePathSchema` is
exported from `@schlessera/brain` for a module author's `configSchema`: a
setting that names a directory inside the brain (finance's `clientsDir`,
images' `imagesDir`) validates with it, which refuses absolute, `~`,
backslash and `..` paths before the module resolves the value under the brain
root.

SDK server additively exports `GeoConfig`, `GeoConfigInput` and `geoConfigSchema`
from the concrete geo library. UI server `CoastlineConfig.geo` is optional for
existing explicit configurations; `BRAIN_GEO_CONFIG_JSON` supplies it from the
environment, validated at startup. Relative response-cache paths resolve from
`BRAIN_PATH`; invalid/empty/malformed configuration fails rather than silently
using legacy public endpoints. Canonical service settings take precedence over
legacy Overpass settings. Legacy disabled prevents requests. Existing permanent
geometry cache keys/results and 5-degree route bounds remain unchanged.
The server environment setting is not forwarded to child processes by default.

### Local vector static maps

Geo server additively exports `staticMap(input, client)` and `GeoClient.staticMap`,
plus `StaticMapInput`, `StaticMapTrack`, `StaticMapPin`, `StaticMapResult`,
`StaticMapReason`, `StaticMapScale` and the track/pin/leg evidence types. Input has
optional `tracks: {track:ParsedTrack,source:TrackSource,label?}[]`,
`pins: {lat,lon,label}[]`, already-calculated `routes: RoutingResult[]`,
`bbox: [west,south,east,north]`, `title`, `widthPx` and
`background: "auto" | "none" | CoastlineServiceResult`. Omitted background is auto.
No routing request is made by a map call. A concrete prefetched background sends
no background request; `"none"` also sends none.

The result has `status: ok | partial | no_map`, `kind: geometry | track_only | none`,
nullable `reason`, nullable `png: Uint8Array`/`svg: string`, `widthPx`, nullable
`heightPx`/`bounds`, complete `text`, `title`, copied `tracks`/`pins`/`legs`/`routes`,
nullable `background`, `attribution`, `warnings` and `method`. Reasons are
`unsupported_projection`, `background_extent`, `background_unavailable`,
`background_omitted`, `no_spatial_input`, `unsupported_text`, `render_budget` and
`renderer_unavailable`. Every no-map outcome has null images and preserves complete
text/source/summary evidence. Invalid or oversized input throws.

Track evidence retains one-based index/label, full unsimplified `TrackSummary`, exact
original omission indices/reasons, and visible/cropped retained-vertex counts.
Pins retain original coordinates/label, one-based index, `drawn` and nullable reason
`outside_viewport | no_artifact`. Every requested adjacent route pair has a leg with
route/index/mode/from/to, `available` and nullable `distanceM`/`durationS`; genuine
zero remains zero. Route stops not represented by explicit pins gain numbered pins.
Missing route geometry never creates a line, and imported section gaps remain gaps.
All stops/legs remain in the full legend, including cropped stops.

The method records `spherical_web_mercator`, `source_vertices_in_mercator`, the
85.0511287798066-degree latitude limit, `gaps: preserved`, bundled IBM Plex glyph
outlines and nullable scale `{value,unit:m,lengthPx,latitude,
method:mercator_at_center_latitude}`. Unsupported polar/date-line/wrapping extents
preserve source coordinates rather than clamp them. Projectable bounds wider than
5 degrees per axis skip background querying and produce a plain image. Missing
background also produces a qualified plain image. Used OSM geometry/calculated
routes retain attribution; FOSSGIS-derived graphics additionally carry the
operator's CC BY-SA 2.0 graphics link. No browser, raster tiles, system fonts or
external resources participate in rendering.

Width is 320–2,048 integer pixels, default 1,024. Maximum inputs are 100 tracks,
1,000 explicit pins, 100 route results and 200,000 aggregate source-track/route/stop
points, including track omissions. Prefetched background is bounded to 10,000 ways/
200,000 vertices. Labels and provenance text are bounded and reject controls. A complete image/legend above
32 million pixels, 16,384 height, 200,000 text characters, 16 MiB SVG or 64 MiB PNG
gives a text fallback. Unsupported glyphs and unavailable local rasterization have
distinct reasons. No stop, leg, omission or attribution is silently truncated.

### Geo CLI envelopes

`brain geo` adds the five subcommands below without changing old CLI/MCP/wire/
frontmatter contracts. Types are `GeoGeocodeOutput`, `GeoRouteOutput`,
`GeoPoiOutput`, `GeoTrackOutput` and `GeoMapOutput` in core's geo command. Each
machine invocation emits one JSON document; usage exceptions remain stderr-only.

| Command | JSON fields |
|---|---|
| `geo geocode <query>` | Complete `GeoResult<GeocodeCandidate[]>` plus `operation: geocode`, `request: {query}`. |
| `geo geocode --reverse lat,lon` | Complete same result plus `operation: reverse`, `request: {lat,lon}`. |
| `geo route lat,lon... --mode car\|foot\|bike` | Complete `RoutingResult` plus `operation: route`. |
| `geo poi --near lat,lon \| --along file.gpx --radius-m metres --tag key[=value]...` | Complete `PoiResult` plus `operation: poi`, nullable brain-relative `sourceFile`. |
| `geo track file.gpx` | Complete `TrackSummary` plus `operation: track`, exact `omissions`, nullable `nearest: NearestTrackPoint` and nullable `comparison: {summary:TrackSummary,omissions,coverage:TrackCoverage}`. |
| `geo map [file.gpx...] --out file.png` | Complete `StaticMapResult` except `png`/`svg`, plus `operation: map`, nullable `artifact: {path,format:png,bytes}`. |

Coordinates are latitude,longitude in CLI arguments. Bbox order remains west,
south,east,north. Route mode is required and ordered stops remain intact. POI
requires exactly one spatial form, explicit radius and 1–10 exact AND filters;
repeatable bare keys mean presence and duplicate keys refuse. Track nearest/
comparison requires explicit `--tolerance-m`; optional `--sample-spacing-m` needs
comparison. Counts, partial status, model, tolerance, direction and unknown reasons
remain the shared results; originals are never rewritten.

Map accepts repeatable `--pin lat,lon,label` (commas after the first two belong to
the label), optional repeated routing `--point lat,lon` with required `--mode`,
`--bbox`, `--title`, `--width` and `--no-background`. Routing resolves before the
static map operation; this is explicit requested traffic rather than a hidden
route calculation in rasterization. Output is brain-relative PNG, requires an
initialized brain and explicit `--out`, and replaces a chosen regular file.
Containment checks include symlinks and repeat after asynchronous resolution;
scratch uses its existing genuine/ignored-directory write and pruning rules.
No-map returns null artifact and does not create its destination. Complete text/
provenance/omissions remain in the JSON while binary PNG/SVG contents are omitted.
Aggregate map input counts omitted source points as well as retained geometry.

Human mode prints source, fetch/cache age, all transfer attempts, dataset/fallback,
unknown estimates and applicable attribution. Exit 0 covers valid/partial results,
genuine no-match/no-route and documented map/text fallback; input/usage is 1 and a
failed service command/storage/local renderer is 2. Typed service input errors may
emit their one JSON result with exit 1; parse/path/usage exceptions print only to
stderr. `brain render` retains its existing envelope/network-denied behavior:
callers inline the already-created local PNG as data before invoking export.

### Imported track files in chat (additive)

`ClientChatMessage.files?: { kind: "file"; path: string }[]` references validated
originals in the existing share staging directory. The host resolves and reparses
those originals before first, queued, native follow-up and retry dispatch. A client
cannot supply trusted coordinates, measurements or a replacement source path.
Images remain in `attachments`; at most `SHARE_MAX_FILES` (10) files and images,
with `SHARE_MAX_TOTAL_BYTES` (50,000,000) total decoded/original bytes, may accompany
one message. Existing image-specific limits still apply. Bad references fail as
`ATTACHMENT_REJECTED`, before a backend runs.

The paired UI transports `POST /api/track-upload` and `GET /api/tracks` are
[internal HTTP routes](http-api.md#imported-track-ui-transport-526); their
published socket/block behavior remains this additive contract.

`POST /api/track-upload` uses the existing authenticated, same-origin multipart
boundary, concurrency and total-body caps. It admits validated GPX, KML 2.2 and
the supported GeoJSON subset only. `TRACK_MAX_FILE_BYTES` is 20 MiB, matching the
shared parser; a larger track returns `413 {error:"file_too_large",limit}`.
Ordinary JSON, PDF, CSV, unsupported formats, malformed or unsafe structures
return `422 {error:"unsupported_track",message}`. A title/text without a track
cannot bypass admission. A cancelled uncommitted stage is removed. Originals are
written unchanged through the existing atomic staging path; no knowledge-base
content is created. Existing `POST /api/share` retains generic file intake and
never labels an unvalidated file as a track.

An initial accepted retry receipt can include canonical `files` for the new
local user row; receipt status queries still disclose no original input.

`SharedFileMeta` additively carries `incomingName?`, `detected?:
"gpx"|"kml"|"geojson"` and `summary?: TrackFileSummary`. Validated nameless,
extensionless or generic `.bin`, `.dat`, `.tmp`, `.xml` and `.json` tracks get a
detected format extension in their sanitized, collision-safe staged name.
`sha256?` identifies a validated original; exact retries check the original
before accepting and refuse changed or unavailable files. Incoming display
name/MIME, detected format and actual staged name/path remain
separate bounded, inert metadata. `TrackFileSummary` is the shared `TrackSummary`
without geometry, plus input waypoint count and omitted waypoint count. Replayed
user messages add `files?: SharedFileMeta[]`; the operational UI database retains
this metadata, not authoritative content or original bytes. Only a byte-identical
recorded server context is removed from replay text. User-authored lookalikes
remain user text.

`GET /api/tracks?path=<staged reference>` returns `TrackFileView`: the shared
`ImportedTrack` plus canonical `file: SharedFileMeta`, recomputed from the original.
Unavailable, expired or unsupported originals return `422 {error:
"track_unavailable",message}`; a missing/overlong path returns 400. Reads enforce
containment, regular-file/no-symlink checks and actual byte limits.

Retry for a file-backed request is advertised only after the server checks
the original bytes, before consuming eligibility. The session catalog is
internal to the server (#1053).

`show_block` adds `{kind:"track",source:{path:string},title?:string}`. The source
is a staged reference only: no model-authored geometry, viewport, metric or
provenance field. The client resolves the original through the route above.
The classifier does not infer track blocks from prose. `TrackMap` is a
presentation-only kit component; `MapView.fitPoints` fits a track envelope
without extra pins, and `MapPin.marker` distinguishes start/end shapes and their
`S/E` merge. Existing place-map behavior stays unchanged.

Imports recover invalid coordinates into separate usable sections with exact
counts/reasons. Every omission and original section boundary breaks both drawing
and measurement. Valid zero, repeated and polar coordinates remain source
coordinates. Optional invalid/missing elevation and timestamps remain unknown;
elapsed includes pauses within sections and excludes gaps, with incomplete or
non-monotonic required times unknown. Moving time remains unavailable. Elevation
uses the shared three-point median/3 m hysteresis and complete eligible altitude
input. Values cover `usable_sections`; recovered values say partial. Formats and
timestamps never establish recorded travel: coordinates are file-provided.

`parseImportedTrack` in `@schlessera/brain-geo` owns adapters: GPX track/route and
waypoints; KML LineString, MultiGeometry and Point, with no NetworkLink, Model or
polygon import; GeoJSON LineString, MultiLineString, Point/MultiPoint and their
Feature/collection wrappers, with no alternate CRS or polygons. XML is strict,
UTF-8/ASCII, entity/DTD-free; input is bounded to 20 MiB, 200,000 total line and
waypoint points and 128 nesting levels. The original is never rewritten. Shared
measurement input and displayed lines are unsimplified in this cut; all retained
points remain drawn unless the entire projection is unsupported.

The static map retains a labeled track-only line when background geography is
unavailable or its drawn envelope exceeds either 5-degree query axis. It sends no
oversized geography request. A Mercator/padded frame outside the supported
latitude/longitude range gives a clear reason with the complete summary,
waypoints and original reference, without clamping/wrapping source points. PNG/PDF
sharing resolves file and optional geometry before composing static HTML; the
scriptless renderer performs no network fetch. An expired original refuses track
export rather than drawing an empty frame.

A host's manifest must advertise MIME types together with extensions. Extend its
existing generic/image entries with these track entries; use the SDK worker
handler at the same action. The generated-host change is tracked separately in
[brain-hosting-template#10](https://github.com/schlessera/brain-hosting-template/issues/10).
The example is checked through `registerShareTarget` and actual multipart parsing.

<!-- track-share-target-example -->
```json
{
  "share_target": {
    "action": "/share-target",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url",
      "files": [{
        "name": "files",
        "accept": [
          "application/gpx+xml", ".gpx",
          "application/vnd.google-earth.kml+xml", ".kml",
          "application/geo+json", ".geojson",
          "application/json", ".json"
        ]
      }]
    }
  }
}
```
<!-- /track-share-target-example -->

A `.json` or generic MIME/name is identified by validated contents. Ordinary JSON
still receives no track summary. See the [GPX schema](https://www.topografix.com/GPX/1/1/),
[KML reference](https://developers.google.com/kml/documentation/kmlreference) and
[GeoJSON RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946) for source formats;
the supported subset and recovery policy above govern this import contract.

## Pi native endpoint routing (breaking routing migration, #762)

Explicitly declared built-in pi provider/model profiles are validated against
the supported catalog, then resolved from the same configured native
`ModelRuntime` used for inference. New ordinary/autonomous turns honor native
`models.json` endpoint configuration. Ordinary persisted resumes use that runtime
without overriding their saved model and still refuse native model fallback.
The brain's transcript directory is independent of native agent-directory
model/auth/cache discovery. No new profile endpoint field, schema, custom-model
discovery or provider seam is introduced.

On every inference request, a native authentication-supplied endpoint wins;
otherwise the configured model endpoint is used. A configured proxy is
conditional on native authentication not supplying an endpoint. A differing
native auth endpoint alone is not a configuration refusal. The backend neither
forces native credentials to a configured URL nor duplicates credential
discovery/refresh, subscription/account routing or billing ownership. Native
refresh may contact authentication servers. Selected provider/model identities
and declared picker profiles stay fixed. A resident session retains its runtime;
no hot-reload promise for `models.json` is added.

This newly honored routing replaces previously ignored endpoint configuration
for new sessions. Review native model/auth configuration when adopting the
change. The [2026-10-03 endpoint policy](decisions/pi-endpoint-routing.md) records
the prior maintainer ruling and approved migration: `contract`/`breaking`, a
`CONTRACT:` commit and same-commit backend/contract guidance plus a named minor
changeset before 1.0 (major from 1.0). No dependency change or release date is
selected. Autonomous nonpersistence, exact tool authority, loaded-runtime
compatibility and the containment/dispatch gates remain binding; endpoint
support does not enable autonomous execution.

## Scheduled tasks (additive, #914)

`brain schedule add|list|cancel|reconcile|due` and the authenticated host
routes below store and inspect scheduled tasks. **They never run one.** No
dispatcher is wired: every stored task reports `executionAvailable: false` with
`blockedReason: "dispatch_disabled"` until the Queue runtime trigger (#915)
exists and [#689](https://github.com/schlessera/brain-kit/issues/689) enables it.
Bridge tools (#916) and PWA review (#917) remain prepared below, not shipped.
Types, bounds and receipts are the ones in the
[prepared contract](#scheduled-task-contract-preparation-913), with the
refinements this section lists; where the two differ, this section wins.

**Storage.** The definition is `context/scheduled-tasks/definitions/<taskId>.md`
under the canonical brain root; cancellation moves it to
`context/scheduled-tasks/retired/`. Core excludes `context/scheduled-tasks`
from indexing by default ([configuration](configuration.md#exclude)), so a
forced `brain index` neither reads nor removes definitions. Frontmatter values
are canonical JSON (valid YAML flow syntax) in the fixed order
`schedule_schema`, `id`, `when`, `scope`, `limits`, `notifyOnSuccess`; the body
is the exact prompt. A file that is not byte-identical to the approved snapshot
quarantines the task (`definition_drift`); the host never rewrites it. The
approved snapshot, fingerprint, approval, receipts and occurrences live in the
UI operational database and travel with the [operational backup](inbox-recovery.md).
A restore pauses every enabled task as `restore_pending` and marks each
outstanding occurrence `unknown`; only operator reconciliation (below) reopens
them.
Publication is refused (`unsupported_capability`) when Git would ignore the
definition path.

**Supported tools.** The host accepts only `brain_read`, validated against the
core tool's registered input schema; its `path` must be an approved target.
Any other tool, a model alias, or non-empty `egress` is `invalid_request`
(no supported tool uses the network). Targets must be exact, normalized,
non-hidden brain-relative paths outside `context/scheduled-tasks`,
`context/policies`, `brain.config*` and `brain.db*`, with no symlinked
component. A variable input may not vary a target path.

**Execution policy.** The reviewed `executionPolicy` is the host's default
backend ID, its preferred profile ID (or null) and the operator-configured
`BRAIN_UI_SCHEDULE_INFERENCE_ORIGINS`. While that variable is unset, proposals
are refused with `unsupported_capability`. Any change to the policy before
approval or publication is `definition_conflict`; propose again.

**HTTP refinements.** `POST /api/schedules/proposals` accepts an optional
`clientTimeZone` beside `{key, definition}`: the CLI's `--client-time-zone`.
An invalid explicit or client zone is `invalid_request`; neither falls back.
`POST /api/schedules` takes `{proposalId, approvalId?}`: the stored approval
for that proposal is used when `approvalId` is omitted, which lets a creator
publish after an operator approved elsewhere. Only the proposal's creator can
publish it. Approval requires an `owner` principal (password mode) or the
ambient principal (other modes); a delegated `agent` credential gets
`unauthorized`. Delegated principals see and cancel only the tasks they
created; operators see all. The occurrence stop route is not mounted yet.
All responses carry `Cache-Control: no-store`.

**CLI.** Syntax and envelopes are the prepared ones. `add --approve` prints the
whole materialized envelope, execution policy and fingerprint on stderr and
grants only when the operator types `approve` on an interactive terminal; with
no TTY, or any other answer, it exits 1 with `approval_required` and the stored
proposal ID. `--attempt-timeout-ms` and `--max-operations` form one reviewed
`limits` object; a missing half takes its default. The scope file is a
regular, non-symlink file of at most 8 KiB holding one JSON object. In JSON
mode, argument errors are `{ok:false,error:{code:"invalid_request",...}}`, exit
1; `credential_file_invalid` exits 1; `server_unavailable`,
`unsupported_capability` and `invalid_response` (including any redirect, which
is never followed) exit 2. Every success envelope is schema-checked before it
is printed.

**Operator reconciliation.** `POST /api/schedules/:id/reconcile` takes
`{key, decision: "reopen"}` and answers 200 `{ok: true, changed, task}`. It is
the verified operator decision the record requires before a task paused as
`restore_pending` or `unknown_effect` may run again: only an operator
principal (the same rule as approval) may make it; a delegated `agent` gets
`unauthorized`, or `not_found` for a task it cannot see. The host still
requires the definition file to match the approved bytes and the host's
execution policy to match the approved one (otherwise `definition_conflict`),
and a usable creator (otherwise `unauthorized`). It refuses while the operational restore marker is pending
(`unsupported_capability`). When a completed restore named a different brain
directory, the first reconciliation binds the ledger to it; the root identity
and every fingerprint are unchanged. Unknown occurrences keep their outcome
and their due instants stay consumed, so nothing is replayed; a one-off with
nothing left to run, or a recurrence past its `endAt`, becomes `expired`
instead of `active`. Keys are receipts as for cancel: a matched replay, or a
task with nothing to reconcile, answers `changed: false`; a key reused for
another task is `key_conflict`. `brain schedule reconcile ID --key KEY` shows
the task and its last occurrence on stderr and sends the decision only when the
operator types `reopen` on an interactive terminal; otherwise it exits 1 with
`approval_required`. Its JSON is the route's envelope.

**Occurrence admission (not wired).** The UI server package contains the
private admission boundary #915 will drive. It turns a task's latest fresh due
instant into one occurrence and its first Queue item in one immediate
transaction; concurrent callers in any process admit it once, and instants
arriving while work is outstanding are skipped as busy. Admission and every
start require the creator and the approving operator to still be usable
(otherwise `blockedReason: "authority_unusable"`) and the host's current
execution policy to equal the approved one (otherwise `"backend_unavailable"`,
which `list` and `due` also report). A start refused for one of these reasons
makes no model call and ends that occurrence `failed`, so a later due instant
can run once the cause is fixed. At or after an approved `endAt`, queued
or retrying work expires instead of starting. The Queue claim reserves
budget as for any autonomous work, and the start transaction is the
cancel-versus-start boundary. Each attempt gets the approved
`attemptTimeoutMs` (at most 600000 ms, never past the occurrence's 24-hour
expiry), and its claim is released only after the backend unwinds. Retries,
yields and continuation items share the occurrence's `maxOperations`. An
attempt that died before its backend acquired the reservation retries; one
that died after it is `unknown`, is never replayed, and pauses its task as
`unknown_effect`. A one-off ends `completed`, `failed` or `expired` with its
occurrence. No route, CLI command or core runner reaches this code, and the
production app constructs none of it.

## Scheduled-task contract preparation (#913)

**Selected design; partly implemented.** The [scheduled-tasks
record](decisions/scheduled-tasks.md) supplies the six approved policies and this
bounded specification for #914–#917. [Scheduled tasks (#914)](#scheduled-tasks-additive-914)
ships the definition store, approval, CLI and HTTP routes except occurrence stop.
The bridge tools, occurrence stop, runtime dispatch and Activity/notification
correlation below remain unimplemented, and no permission grant or dispatch exists.
Consumers must not infer availability from these examples. Implementation adds
its actual schemas/exports/routes/receipts, compatibility tests and minor
changesets in `CONTRACT:` commits; #689 still gates production execution.
Existing contract shapes above are unchanged.

### Shared definition and response types

All new request/nested objects are strict: reject unknown fields, duplicate
JSON/YAML keys, nonfinite numbers, invalid UTF-8 and NUL. Decoded control
characters are rejected in IDs, paths, origins, names, operation and cursor;
textual prompt/tool-input values may contain LF/TAB. IDs and keys match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`;
IDs are host-minted and keys are caller-chosen per authenticated principal/root/
operation. Date values are valid offset/Z ISO instants, normalized to UTC `Z`;
responses use integer milliseconds for durations such as `attemptTimeoutMs`
and integer counts for counters, not interchangeable date/string values.

The JSON request definition is exactly:

```ts
type ScheduleDefinitionInput = {
  prompt: string;
  when: { kind: "at"; at: string; timeZone?: string }
      | { kind: "cron"; cron: string; timeZone?: string; endAt?: string | null };
  scope: {
    operation: string;
    tools: { name: string; inputs: JsonObject }[];
    targets: string[];
    egress: string[];
    variableInputs: {
      pointer: string;
      bound: { kind: "enum"; values: JsonScalar[] }
          | { kind: "string"; maxBytes: number }
          | { kind: "number"; min: number; max: number };
    }[];
  };
  limits?: { attemptTimeoutMs: number; maxOperations: number };
  notifyOnSuccess?: boolean;
};
```

`JsonScalar` is null/boolean/string/finite number; `JsonObject` is bounded JSON
with no prototype/authority fields and recursively validated against the selected
registered tool's actual input schema. Max JSON nesting is 8, arrays 32 members,
objects 32 own keys. Scope is at most 8 KiB serialized; prompt is nonempty after
whitespace validation and at most 16 KiB UTF-8. Preserve its approved text.
Operation is nonempty, at most 256 UTF-8 bytes. At most 16 tools, 32 exact
brain-relative target paths (256 bytes each), 16 exact normalized tool-egress
origins (256 bytes each), and 32 variable leaves are allowed. No command/template
interpolation or arbitrary executable schemas. A variable pointer names an
existing tool-input leaf; enum contains 1–32 bounded scalars, strings have a
positive maxBytes <= 16384, numeric min/max are finite and ordered. It cannot
change tool names, target paths, egress, timing, limits, actor or authority.
All undeclared leaves retain exact approved values. Reject duplicates and
unregistered/unsupported inputs; string bounds do not bypass tool validation.

`when` is an exclusive union, with the validated/resolved IANA zone persisted
on both forms. CLI can supply a validated client zone explicitly; the bridge
obtains its fallback zone from verified turn `ClientEnvironment`, never model
text. If neither is usable, disclose UTC. An explicit invalid zone is an error.
Optional recurring endAt is a future offset/Z instant at first publication;
omission materializes to null. It is an immutable scheduling window, not a
live-attempt stop: at now >= endAt invalidate future/unstarted work and stale
continuations, report configuration expired, and retain a started attempt under
its original authority/deadline/freshness. Due eligibility also requires
evaluatedAt < endAt when set. Cron is <= 128 bytes and follows the record's five-field numeric grammar,
including Sunday 0/7 and bounded lists/ranges/positive star/range steps. If either
day field begins with `*`, both day predicates must match, including its step;
otherwise either may match. Reject extra fields, impossible calendars and
unsupported extensions.
First creation requires a future offset/Z one-off. A matched recorded retry
returns its original receipt even after that date passes.

Missing limits materialize to `{attemptTimeoutMs:600000,maxOperations:3}`;
provided values are positive safe integers with timeout <= 600000 and
maxOperations <= 3. Missing notifyOnSuccess materializes to false. These values
are reviewed and immutable. They grant neither budget capacity nor execution.
Definition files have exactly `schedule_schema:1`, host `id`, materialized `when`,
`scope`, `limits`, `notifyOnSuccess` as frontmatter and `prompt` as the body.
Max file size is 32 KiB; the canonical fingerprint covers all materialized fields,
exact prompt, host root/creator and the approved host-selected execution policy.
The file carries no actor/approval/runtime/control-state authority. Task definition
is the retained approved snapshot, not a claim that a drifted raw file is approved;
definition_drift/missing-file status quarantines it without silently rewriting it.

`executionPolicy` is server-owned `{backendId:string, profileId:string|null,
inferenceOrigins:string[]}` (each ID <= 128 bytes, at most 16 normalized origins).
Operator review sees it alongside scope; callers cannot select its fields, prices,
billing identity or emergency reserve. Runtime/profile changes cannot widen the
approved tool/input/target/audience bounds. Current backend availability,
conservative billing evidence and daily admission still apply.

```ts
type ScheduleDefinition = Omit<ScheduleDefinitionInput, "when" | "limits" | "notifyOnSuccess"> & {
  when: { kind: "at"; at: string; timeZone: string }
      | { kind: "cron"; cron: string; timeZone: string; endAt: string | null };
  limits: { attemptTimeoutMs: number; maxOperations: number };
  notifyOnSuccess: boolean;
};
type OccurrenceState = "queued" | "running" | "unwinding" | "waiting_for_action"
  | "retrying" | "completed" | "failed" | "cancelled" | "expired" | "unknown";
type ScheduleResult = { state: "available" | "pruned" | "unavailable";
  text: string | null }; // UTF-8 text <= 4096 bytes; available implies text != null
// pruned/unavailable require text == null; a reference is not result availability.
type ScheduleOccurrence = { id: string; taskId: string; dueAt: string;
  expiresAt: string; state: OccurrenceState; operationsUsed: number;
  maxOperations: number; runIds: string[]; result: ScheduleResult };
type BlockedReason = "dispatch_disabled" | "budget_disabled" | "capacity"
  | "authority_unusable" | "definition_drift" | "backend_unavailable"
  | "unknown_effect" | "occurrence_limit" | "restore_pending";
type ScheduleTask = { id: string; definition: ScheduleDefinition;
  creatorPrincipalId: string; createdAt: string;
  zoneSource: "explicit" | "client" | "utc_fallback";
  state: "publishing" | "active" | "paused" | "cancelled" | "completed" | "failed" | "expired";
  executionAvailable: boolean; blockedReason: BlockedReason | null;
  nextDueAt: string | null; lastOccurrence: ScheduleOccurrence | null;
  compensationPending: boolean };
type DueCandidate = { taskId: string; occurrenceId: string; dueAt: string;
  expiresAt: string; admittable: boolean; blockedReason: BlockedReason | null };
```

Returned `definition` includes all defaults/resolved zone, not optional omissions.
Host-owned zoneSource reports the original resolution, including disclosed UTC fallback.
A `publishing` task cannot dispatch. `active` describes a valid enabled definition,
not successful/available execution. `paused` includes unknown-effect/drift refusal;
completed/failed/expired are terminal one-off states; expired also records an
ended recurring configuration without inventing a successful occurrence. Recurring occurrence failure does
not erase future configuration; unknown effects pause it. Cancelled tombstones
remain inspectable. `nextDueAt` is null when no future occurrence is eligible;
`lastOccurrence` is null before an actual durable occurrence. `operationsUsed`
is an integer 0..maxOperations and runIds contains at most three real attempt IDs;
unstarted scheduling facts do not fabricate Activity roots. Only running/unwinding
states describe a started attempt. Request keys, task IDs, original-due occurrence
IDs, Queue item IDs and run IDs remain distinct.

Due candidates are read-only computed eligibility at `evaluatedAt`, not claims,
persisted occurrences or a promise of execution. The same unconsumed candidate
can recur in successive queries. One outstanding occurrence suppresses a new
candidate; otherwise choose the latest unconsumed due instant with
`dueAt <= evaluatedAt < expiresAt` (expiresAt = dueAt + 24h). Authority/budget/
backend/restore refusal is visible in admittable/blockedReason. Querying due
never advances the scheduler cursor, changes counters or creates model work.

List/due requests accept limit (default 25, integer 1..100) and optional opaque
cursor <= 1024 bytes. List supports only state (one Task state) and id (exact task
ID); due supports only the paging inputs. Responses are bounded to 512 KiB; a
page may stop before its requested limit to respect that byte cap, with a cursor
that advances past the last returned row. One entry must fit; never return an
unchanged cursor/empty page that cannot progress. Stable ordering is createdAt/id
for list, dueAt/taskId for due. Host-signed cursors bind root, authorized actor,
operation/filters, initial creation cutoff/evaluatedAt and last ordering tuple,
with 15-minute expiry. Invalid/mismatched cursors fail; no client SQL/offset.
State/authority may change between pages and must be revalidated for mutations;
pagination does not promise a frozen operational snapshot.

Exact response field types are:

```ts
type AddScheduleResult = { ok: true; created: boolean; task: ScheduleTask };
type ListSchedulesResult = { ok: true; tasks: ScheduleTask[]; nextCursor: string | null };
type CancelScheduleResult = { ok: true; changed: boolean; task: ScheduleTask;
  runningOccurrences: ScheduleOccurrence[] }; // at most one started occurrence
type DueSchedulesResult = { ok: true; due: DueCandidate[]; evaluatedAt: string;
  nextCursor: string | null };
type StopOccurrenceResult = { ok: true; requested: boolean; occurrence: ScheduleOccurrence };
```

Proposal success is `{ok:true,proposal:ScheduleProposal}` (the exact fields/types
specified below, including materialized ScheduleDefinition); approval success is `{ok:true,approvalId:string}`. All success
booleans above are literal/boolean as shown; no additional opaque transport
wrapper. runningOccurrences contains only actually started running/unwinding
work, even if the task is now cancelled.

### Approval, endpoints and receipts

Creation has proposal, verified review and publication stages in the same host.
A proposal stores no authoritative definition and enables no execution. Proposed
supported HTTP endpoints are all mounted behind normal auth/root/principal checks:

| Method/path | Exact input | Exact success |
| --- | --- | --- |
| POST /api/schedules/proposals | `{key, definition}` | `{ok:true,proposal}`; 201 new, 200 matched replay. |
| POST /api/schedules/proposals/:id/approve | `{fingerprint,decision:"approve"}` | `{ok:true,approvalId}`; 200. |
| POST /api/schedules | `{proposalId,approvalId}` | `{ok:true,created,task}`; 201 new, 200 matched replay. |
| GET /api/schedules | list paging/filter query | `{ok:true,tasks,nextCursor}`; 200. |
| POST /api/schedules/:id/cancel | `{key}` | `{ok:true,changed,task,runningOccurrences}`; 200. |
| GET /api/schedules/due | due paging query | `{ok:true,due,evaluatedAt,nextCursor}`; 200. |
| POST /api/schedules/occurrences/:id/stop | `{key}` | `{ok:true,requested,occurrence}`; 200. |

`proposal` is exactly `{id,taskId,key,definition,zoneSource,executionPolicy,fingerprint,expiresAt,
approvalState}`; fingerprint is 64 lowercase hex, expiry is 15 minutes from initial
proposal, approvalState is pending/approved. Proposal id and its reserved future taskId are
distinct host-minted IDs; neither is execution. The fingerprint
uses the materialized stored definition `{schedule_schema:1,id:taskId,prompt,when,
scope,limits,notifyOnSuccess}`, rootIdentity, creatorPrincipalId and executionPolicy. Canonical inputs/key are bound to the
authenticated creator/root before approval. Matched retries return the original
resolved definition/zone/expiry; changed payload conflicts. Expired unconsumed
proposals require a new request/approval, without reviving a retired task.

Only a verified operator decision may create approvalId: normal auth alone,
agent credentials, a fingerprint, or an "approved" payload is insufficient.
The approve route enforces the existing server-resolved operator authority
(owner-kind for principal-cookie mode, the configured operator in ambient modes),
checks current proposal/creator, and records actor/channel/time and the immutable
fingerprint/nonce. Bridge requests obtain this record through the trusted host
permission/Action path, not a model-visible approve tool. CLI explicit review
uses its operator credential and confirmed exact fingerprint; a delegated
credential can propose/query but cannot self-approve. Stored receipt/provenance,
not a claimed input channel or User-Agent, decides eligibility. Unavailable
operator provenance refuses approval honestly.

approvalId is opaque (ID bounds above), linked to that exact proposal/root/creator/
operator/fingerprint, expires with an unconsumed proposal and is consumed once
by publication. The host rechecks current actor authority and matching definition/
execution policy before publishing, including first-publication future one-off
and recurring endAt validation.
Concurrent uses return the one original
receipt or conflict; no broad reusable grant. No prompt/actor/profile/trust/billing
field is accepted on publish/cancel/stop. Replay reads the original publication
receipt before consumed-token/past-date checks, still under current authentication.
It returns the task's current retained state; never recreates a cancelled file,
resets counters or transfers creator authority to a replacement credential.

Cancel keys bind exact task/action within caller/root. Repeated matching cancel
returns changed:false and current retained task/runningOccurrences; a changed
payload conflicts. Cancellation atomically invalidates future/unstarted work
and stale Action continuations, journals retirement and keeps receipts. Started
attempts retain their approved snapshot and current authority/expiry limits; an
authorized move of unchanged definition bytes is not drift or a running stop. It
returns started running/unwinding occurrences honestly, not "agent stopped".
Stop keys separately bind an occurrence/action; requested means cancellation
requested, not backend drained or prior effects undone. Query until terminal;
release only after actual unwind. Pending future cancellation is independent.

### CLI and tool mapping

Prepared core syntax (all use explicit --server, optional --credential-file and
--json; argument flags are strict):

```text
brain schedule add --key KEY --prompt TEXT (--at ISO|--cron EXPR)
  [--time-zone ZONE] [--client-time-zone ZONE] [--end-at ISO] --scope-file FILE
  [--attempt-timeout-ms N] [--max-operations N] [--notify-success] [--approve]
brain schedule list [--id ID] [--state STATE] [--limit N] [--cursor CURSOR]
brain schedule cancel ID --key KEY
brain schedule due [--limit N] [--cursor CURSOR]
```

--end-at is accepted only with --cron. scope-file contains the strict scope object, at most 8 KiB, is a regular
non-symlink file and grants nothing. CLI add submits a proposal; --approve displays
the entire materialized envelope/execution policy/fingerprint and requires explicit
operator confirmation before the authenticated approval request. No TTY/affirmative
operator confirmation means no automatic grant. A pre-approved matching proposal
can publish on a later add retry without --approve; pending proposals return
approval_required with the bounded proposal ID in the message, allowing the
operator to identify its stored review; no approval secret is exposed. A terminal prompt does not replace the host's operator checks.
JSON successful add is `{ok:true,created:boolean,task:ScheduleTask}`; list/cancel/
due use the exact endpoint envelopes. Creation is not execution.

Credential audience/private-file/no-redirect/10-second request rules follow
[queue intake](#durable-share-and-cli-intake-additive-679), with a 512 KiB response
bound for these new schedule responses. No provider key, ambient cookie variable,
raw DB, local runner or offline-activation fallback. A store-capable host may
accept an approved future schedule while reporting executionAvailable:false;
an unavailable store/unsupported approval cannot falsely return created success.

The three future tools are `mcp__brain-ui__schedule_task`,
`mcp__brain-ui__list_scheduled_tasks`, `mcp__brain-ui__cancel_scheduled_task`.
Both actual backend registrations share strict SDK schemas and eager attached
executors. schedule_task input is `{key,definition}`; the host supplies fallback
client zone, proposal/approval identity and verified creator. The model cannot
supply approvalId, actor, executionPolicy, profile, trust, billing or wider granted
membership. Description: write a self-contained future prompt; propose exact
bounded scope; creation needs operator approval and does not execute work.
list_scheduled_tasks takes only the list query inputs and is read class;
cancel_scheduled_task takes `{id,key}` and is confirm class, reporting future-only
cancellation and actual runningOccurrences. schedule_task is confirm class and
not auto-allowed in voice or no-grant/unattended membership. CLI/tool/PWA mutation
responses observe the same authoritative records; tool results/errors and model
text never become approval. The PWA consumes list/cancel/detail data and the
separate authenticated stop where supported, within its reviewed design.

Shared errors are `{ok:false,error:{code:string,message:string}}`, with bounded
message <= 1024 bytes and no credential/prompt/tool/SQL echo. Closed codes:
invalid_request (400), invalid_cursor (400), credential_file_invalid (CLI only),
unauthorized (401/403), not_found (404), key_conflict (409), approval_required (409),
approval_expired (409), definition_conflict (409), server_unavailable (503 or CLI
transport), invalid_response (CLI/schema), unsupported_capability (503).
No undocumented success-shaped error. Query success, including empty due and
inspection of a failed/pruned outcome, exits 0. Validation/auth/conflict/not-found
exits 1. Unavailable/unsupported/invalid response/timeout/redirect/5xx exits 2.
JSON argument errors use invalid_request/exit 1, not an absent envelope. Retry
writes with the original key, never a new key after an ambiguous response.

Complete fictional examples use the pinned Odysseus reference date, 2026-07-12. They
are interface examples, not actual CLI/host receipts. The CLI obtains one stored
proposal, explicit operator review, then publication through the routes above:

```text
brain schedule add --server https://scheduler.example --credential-file ./operator.json
  --key ithaca-review-01 --prompt "Read notes/ithaca.md and report outstanding checks. Do not change files or use network tools."
  --cron "0 7 * * 1-5" --time-zone Europe/Athens --scope-file ./scope.json --approve --json
```

The scope file is exactly the scope in this complete add response. JSON mode
keeps review/confirmation on the terminal/stderr and emits one result on stdout.
The corresponding schedule_task input is `{key:"ithaca-review-01",definition}`
with this complete definition; approval/proposal IDs are obtained by the host,
not supplied by the model. Successful creation still reports disabled execution:

```json
{
  "ok": true,
  "created": true,
  "task": {
    "id": "task_ithaca_review",
    "definition": {
      "prompt": "Read notes/ithaca.md and report outstanding checks. Do not change files or use network tools.",
      "when": {
        "kind": "cron",
        "cron": "0 7 * * 1-5",
        "timeZone": "Europe/Athens",
        "endAt": null
      },
      "scope": {
        "operation": "Report outstanding Ithaca checks",
        "tools": [
          {
            "name": "brain_read",
            "inputs": {
              "path": "notes/ithaca.md"
            }
          }
        ],
        "targets": [
          "notes/ithaca.md"
        ],
        "egress": [],
        "variableInputs": []
      },
      "limits": {
        "attemptTimeoutMs": 600000,
        "maxOperations": 3
      },
      "notifyOnSuccess": false
    },
    "creatorPrincipalId": "principal_example_operator",
    "createdAt": "2026-07-12T06:00:00.000Z",
    "state": "active",
    "executionAvailable": false,
    "blockedReason": "dispatch_disabled",
    "nextDueAt": "2026-07-13T04:00:00.000Z",
    "lastOccurrence": null,
    "compensationPending": false,
    "zoneSource": "explicit"
  }
}
```

A subsequent list reads the same record:

```json
{
  "ok": true,
  "tasks": [
    {
      "id": "task_ithaca_review",
      "definition": {
        "prompt": "Read notes/ithaca.md and report outstanding checks. Do not change files or use network tools.",
        "when": {
          "kind": "cron",
          "cron": "0 7 * * 1-5",
          "timeZone": "Europe/Athens",
          "endAt": null
        },
        "scope": {
          "operation": "Report outstanding Ithaca checks",
          "tools": [
            {
              "name": "brain_read",
              "inputs": {
                "path": "notes/ithaca.md"
              }
            }
          ],
          "targets": [
            "notes/ithaca.md"
          ],
          "egress": [],
          "variableInputs": []
        },
        "limits": {
          "attemptTimeoutMs": 600000,
          "maxOperations": 3
        },
        "notifyOnSuccess": false
      },
      "creatorPrincipalId": "principal_example_operator",
      "createdAt": "2026-07-12T06:00:00.000Z",
      "state": "active",
      "executionAvailable": false,
      "blockedReason": "dispatch_disabled",
      "nextDueAt": "2026-07-13T04:00:00.000Z",
      "lastOccurrence": null,
      "compensationPending": false,
      "zoneSource": "explicit"
    }
  ],
  "nextCursor": null
}
```

Cancelling before any attempt started retains the task and invalidates future
work. Repeating this key returns changed:false and the same retained identity:

```json
{
  "ok": true,
  "changed": true,
  "task": {
    "id": "task_ithaca_review",
    "definition": {
      "prompt": "Read notes/ithaca.md and report outstanding checks. Do not change files or use network tools.",
      "when": {
        "kind": "cron",
        "cron": "0 7 * * 1-5",
        "timeZone": "Europe/Athens",
        "endAt": null
      },
      "scope": {
        "operation": "Report outstanding Ithaca checks",
        "tools": [
          {
            "name": "brain_read",
            "inputs": {
              "path": "notes/ithaca.md"
            }
          }
        ],
        "targets": [
          "notes/ithaca.md"
        ],
        "egress": [],
        "variableInputs": []
      },
      "limits": {
        "attemptTimeoutMs": 600000,
        "maxOperations": 3
      },
      "notifyOnSuccess": false
    },
    "creatorPrincipalId": "principal_example_operator",
    "createdAt": "2026-07-12T06:00:00.000Z",
    "state": "cancelled",
    "executionAvailable": false,
    "blockedReason": null,
    "nextDueAt": null,
    "lastOccurrence": null,
    "compensationPending": false,
    "zoneSource": "explicit"
  },
  "runningOccurrences": []
}
```

Empty due and explicit approval failure retain their exact envelopes:

```json
{
  "ok": true,
  "due": [],
  "evaluatedAt": "2026-07-12T06:00:00.000Z",
  "nextCursor": null
}
```

```json
{
  "ok": false,
  "error": {
    "code": "approval_required",
    "message": "Review the stored schedule proposal before creation."
  }
}
```

### Activity, notification and recovery compatibility

The implementation adds optional scheduleId/occurrenceId correlation to actual
autonomous Activity roots/rollups and authenticated result links, without changing
existing origin or outcome meanings. Original-due identity links up to three
attempts/continuations. Pruning must leave an honest result/link state and retained
occurrence outcome/counters; no invented run for unstarted/skipped work.

Success completion intents default off per schedule; failure/stuck/Actions keep
existing semantics. Deduplicate final occurrence notices across intermediate
roots/restarts, preserve generic push payloads and durable authenticated results.
Existing 20-intents/hour suppression and three failed attempts/five-minute retry
backoff remain. Intent/provider acceptance never claims receipt or reading.
Coordinated Git plus operational backup retains all new relations/approval/
compensation/receipt/counter/result/notice state and validates it before gated
restore/admission. Existing backup version/schema checks must cover those added
relations; old tests/images are not schedule recovery proof. Matching restored
bytes alone cannot disprove later cancellation/revocation: require authoritative
later receipts or verified operator reconciliation and keep uncertain tasks paused. The 24-hour recovery
point and unknown-effect investigation remain binding.

## Video watching (opt-in module)

`brain video watch <url|path> [--question TEXT] [--start T] [--end T] --json`
returns `{ source, engine, model, clip, answer, timestamps, warnings }`.
`source` contains `kind: "youtube" | "file"`, nullable `url`, `path`, `title`,
and `durationSeconds`. `engine` is `"gemini"`, `model` and `answer` are strings,
`clip` has nullable numeric `start`/`end` in seconds, and `timestamps` and
`warnings` are string arrays. Unknown metadata is null; model observations are
never metadata. Timestamps are deduplicated in answer order, inside the clip;
invalid/outside citations produce warnings rather than fabricated evidence.
The answer is returned verbatim. Failure emits no success envelope and exits
nonzero. Disclosure and diagnostics use stderr, preserving JSON stdout.

The experimental `ContentPart` union adds a `kind: "video"` variant with
`mimeType`, optional numeric `clip: { start?, end? }`, and exactly one source
(`uri`, `path` or `data`). `CompletionProvider.capabilities.video?: boolean`
treats omission as unsupported, preserving existing providers; built-in Gemini
reports true and Anthropic false. `complete` adds optional `signal: AbortSignal`.
Video requests do not use configured completion fallback. Uploads created by
a request are deleted after success or failure; failed cleanup throws.
See [the module README](../packages/module-video/README.md) for defaults,
source restrictions and privacy disclosure. These are additive minor changes.

### Bounded hygiene repair operations (additive, #1025)

These operations require valid configuration, except the read-only
`check configuration-blocker`. They use #1024's canonical IDs/fingerprints.
Confirmed resolve/Undo and ordinary check require an initialized brain; flags
before the subcommand or positional arguments after `--` cannot bypass that
write guard. Repair previews and the configuration-blocker recheck remain read-only.
CLI invocation confirms an effect; server principal authorization and durable
Action execution remain the server's responsibility. No inference runs.

| Operation | Input | JSON result / exit |
| --- | --- | --- |
| `hygiene resolve <id> --handler <name> --input <json> --expect-fingerprint <fp> --dry-run` | Handler and its typed JSON input | `status: "preview"`, `id`, `handler`, `diff`, `previewToken`; exit 0. No brain file, index or log is written. |
| `hygiene resolve <id> --handler <name> --input <json> --expect-fingerprint <fp> --expect-preview <token>` | The same input and the preview's opaque premise token | `status: "fixed"`, `id`, `changedFiles`; exit 0, only after real file validation and detection succeed. `stale`, `refused`, `check_failed` exit 1. |
| `hygiene undo <undoToken> --dry-run` | Opaque receipt token from a failed post-check | `status: "preview"`, `id`, inverse `diff`; exit 0, writes nothing. |
| `hygiene undo <undoToken>` | Confirm that inverse effect | `status: "undone"`, `id`, `changedFiles`; exit 0. `stale` or `refused` exit 1 and writes no content. |
| `hygiene check <id>` | A logged finding ID | `status: "still_detected"`, `id`, `handler`, or `status: "not_detected"`, `id`, `changedFiles`; exit 0. `check_failed` or `refused` exit 1. Still detected and failed checks write no brain file or log. |
| `hygiene check configuration-blocker` | Reserved configuration blocker identity | `status: "blocked"` (exit 1) or `"ready"` (exit 0), `id`, `handler`; blocked also has `reason` (loader diagnostic). Both are read-only. Other hygiene commands still refuse invalid configuration. |

A `diff` carries `path` (brain-relative), `before` and `after` (complete exact
UTF-8 text), and `changes: [{before, after, line}]` (every bounded replacement,
1-based line). A `handler` carries `name`, `category`, `kind` (`choice`, `field`,
`manual`, `blocker`), `input: {type, values?, example?}`, `effect`, `postCheck`,
`path`, `line`, `explanation`, and optional `suggestedPath`. `input.type` is
`none`, `path`, `string`, `enum`, `date` or `strings`.

The fixed handler set is:

- `link-suggested`: input `null`; available only for exactly one contained
  note matching the target's slug, alias or exact title. No fuzzy match.
- `link-note`: input a brain-relative path to an existing, included Markdown
  document inside the brain. Outside paths, symlink escapes, symlink documents,
  excluded/non-document/missing targets and unrepresentable link paths refuse.
- `link-text`: input `null`; remove this target's link tokens, keeping each
  display label (the original target when unlabelled). Code and frontmatter
  tokens are preserved. Link-to-note effects retain labels and heading suffixes.
- `required-field`: typed input for the field named by the finding: `title`
  (non-empty string), `type` (configured taxonomy enum), `created`/`updated`
  (real calendar date `YYYY-MM-DD`), `tags` (non-empty string array of lowercase,
  hyphenated tags). Only that key is edited; a minimal-editor refusal never
  falls back to serializing frontmatter. Other validation categories are manual.
- `manual`: no content effect; file/line and explanation for an explicit edit,
  then `check`. `blocker`: reload configuration before starting review.

Content effects refuse non-UTF-8 source files (`reason: "not-utf8"`) rather than
normalizing unrelated bytes. Refusals carry `reason`; invalid field input additionally carries
`fieldError: {field, message}` with format/enum guidance. Stale results carry
`reason` and write no content or log. The fingerprint binds category evidence;
`previewToken` additionally binds the handler, input and exact replacement
bytes (including repeated token multiplicity), excluding unrelated file bytes.
An unrelated edit after preview is preserved. An apply without a preview token
is a usage error (exit 1). Neither token is an authority grant.

`check_failed` carries `code`, `undoToken`, `changedFiles`; the written effect
remains, the finding stays open and nothing rolls back automatically. Undo
requires the complete file to still match the effect's written bytes, offers
its own inverse preview, and restores the exact pre-effect bytes only upon
explicit invocation. Repeated Undo becomes stale. Repair receipts are Markdown
under `context/hygiene/repairs/<opaque-token>.md`; they hold the before/after
text and handler with standard valid frontmatter drawn from the configured
taxonomy, with no authoritative state in `brain.db`.

Only a successful repair records `resolved-by: handler:<name>`; a successful
manual recheck records `resolved-by: check`. Other findings keep their state
and evidence. Reconciliation still reopens a resolved finding detected again.
File validation failure, detector failure or unavailable resolution recording
cannot report `fixed`. Unexpected storage/publication errors use the standard
internal-error exit 2; an interrupted receipt requires recheck/reconciliation,
not blind replay of a content write. The compare-then-rename writer retains its existing
last-read-to-rename race limitation; these commands supply no multi-file
transaction or server-level replay/authorization guarantee.
