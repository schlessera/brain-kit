# brain-kit Integration Contract

The machine-readable surface and deliberately supported user inputs other
systems and brain owners may depend on. The [supported-input policy](supported-inputs.md)
includes brain configuration, documented environment inputs, per-module JSON
settings and canonical module content, with field references delegated to their
owners. The TypeScript API is what the packages' ordinary entry points export,
including every type their signatures reach; `/internal` entry points are not
part of it ([package entry points](integration-contract/package-api.md#package-entry-points)). Implementation
details outside these promises may change without notice. Contract changes require a `CONTRACT:` commit prefix and a
same-commit update of the index or relevant authoritative component. How they are versioned:

- **Additive** — a new field, a new optional input, a new tool, a
  `schema_version` bump for a migration that only adds. Ships in a minor.
- **Breaking** — a field removed, renamed or retyped, or a value whose meaning
  changes. Before 1.0 it ships in a minor as well, and additionally needs the
  `breaking` label, a maintainer ruling recorded on its issue before code is
  written, and a changeset that names the break. From 1.0 it needs a major
  version bump of `@schlessera/brain-*`.

The reasoning is in [decisions/contract-versioning.md](decisions/contract-versioning.md).

## Authoritative surfaces

- [package api](integration-contract/package-api.md).
- [cli](integration-contract/cli.md).
- [frontmatter](integration-contract/frontmatter.md).
- [mcp](integration-contract/mcp.md).
- [http](integration-contract/http.md).
- [wire](integration-contract/wire.md).

## Original section map

Presentation-only split from `9adc62e70b4f5eac9b5e3ef779552cd1858a6bd2`.
Every original heading below points to its unchanged section. The introductory
policy stays here; rules, examples, amendments and evidence move with their sections.
Original fragment identities remain available at this entry point.

<a id="package-entry-points"></a>

- [Package entry points](integration-contract/package-api.md#package-entry-points) (original line 23).

<a id="explicit-autonomous-backend-turns-675"></a>

- [Explicit autonomous backend turns (#675)](integration-contract/package-api.md#explicit-autonomous-backend-turns-675) (original line 174).

<a id="autonomous-admission-configuration-additive-678"></a>

- [Autonomous admission configuration (additive, #678)](integration-contract/package-api.md#autonomous-admission-configuration-additive-678) (original line 200).

<a id="interactive-priority-and-cooperative-autonomous-yield-additive-687"></a>

- [Interactive priority and cooperative autonomous yield (additive, #687)](integration-contract/package-api.md#interactive-priority-and-cooperative-autonomous-yield-additive-687) (original line 219).

<a id="operational-recovery-command-additive-686"></a>

- [Operational recovery command (additive, #686)](integration-contract/cli.md#operational-recovery-command-additive-686) (original line 254).

<a id="rail-acts-and-all-commands-additive-944"></a>

- [Rail acts and All commands (additive, #944)](integration-contract/package-api.md#rail-acts-and-all-commands-additive-944) (original line 313).

<a id="working-sessions-and-the-shared-composer-row-additive-949"></a>

- [Working sessions and the shared composer row (additive, #949)](integration-contract/package-api.md#working-sessions-and-the-shared-composer-row-additive-949) (original line 326).

<a id="runtime-approval-composition-additive-1141"></a>

- [Runtime approval composition (additive, #1141)](integration-contract/package-api.md#runtime-approval-composition-additive-1141) (original line 344).

<a id="search-result-cards-additive-1138"></a>

- [Search result cards (additive, #1138)](integration-contract/package-api.md#search-result-cards-additive-1138) (original line 356).

<a id="streaming-waiting-status-approved-pre-10-break-1144"></a>

- [Streaming waiting status (approved pre-1.0 break, #1144)](integration-contract/package-api.md#streaming-waiting-status-approved-pre-10-break-1144) (original line 374).

<a id="exec-wrapper-in-app-configuration-additive-1363"></a>

- [Exec wrapper in app configuration (additive, #1363)](integration-contract/package-api.md#exec-wrapper-in-app-configuration-additive-1363) (original line 387).

<a id="logo-assets-additive-1424-1425"></a>

- [Logo assets (additive, #1424, #1425)](integration-contract/package-api.md#logo-assets-additive-1424-1425) (original line 401).

<a id="logo-in-the-empty-state-additive-1426"></a>

- [Logo in the empty state (additive, #1426)](integration-contract/package-api.md#logo-in-the-empty-state-additive-1426) (original line 426).

<a id="consumers"></a>

- [Consumers](integration-contract/package-api.md#consumers) (original line 433).

<a id="model-reranker-activation"></a>

- [Model reranker activation](integration-contract/package-api.md#model-reranker-activation) (original line 441).

<a id="travel-ownership-and-canonical-content"></a>

- [Travel ownership and canonical content](integration-contract/frontmatter.md#travel-ownership-and-canonical-content) (original line 471).

<a id="travel-photo-copies"></a>

- [Travel photo copies](integration-contract/frontmatter.md#travel-photo-copies) (original line 516).

<a id="travel-registries"></a>

- [Travel registries](integration-contract/frontmatter.md#travel-registries) (original line 574).

<a id="asynchronous-ui-startup"></a>

- [Asynchronous UI startup](integration-contract/package-api.md#asynchronous-ui-startup) (original line 595).

<a id="html-renderer-budgets"></a>

- [HTML renderer budgets](integration-contract/package-api.md#html-renderer-budgets) (original line 645).

<a id="cli-conventions"></a>

- [CLI conventions](integration-contract/cli.md#cli-conventions) (original line 689).

<a id="stable---json-shapes"></a>

- [Stable --json shapes](integration-contract/cli.md#stable---json-shapes) (original line 705).

<a id="auditissue"></a>

- [AuditIssue](integration-contract/cli.md#auditissue) (original line 786).

<a id="brain-eval---json"></a>

- [brain eval --json](integration-contract/cli.md#brain-eval---json) (original line 859).

<a id="brain-index-counters"></a>

- [brain index counters](integration-contract/cli.md#brain-index-counters) (original line 1037).

<a id="embedding-eligibility-and-coverage-semantics"></a>

- [Embedding eligibility and coverage semantics](integration-contract/cli.md#embedding-eligibility-and-coverage-semantics) (original line 1141).

<a id="recorded-corpus-trend-verdicts-additive-in-0400"></a>

- [Recorded corpus trend verdicts (additive in 0.40.0)](integration-contract/cli.md#recorded-corpus-trend-verdicts-additive-in-0400) (original line 1170).

<a id="stats-history-additive-in-0400"></a>

- [Stats history (additive in 0.40.0)](integration-contract/cli.md#stats-history-additive-in-0400) (original line 1236).

<a id="browser-scraping-navigation-policy"></a>

- [Browser scraping navigation policy](integration-contract/package-api.md#browser-scraping-navigation-policy) (original line 1369).

<a id="mcp-server-stdio-brain-mcp-or-srcmcp-serverts"></a>

- [MCP server (stdio, brain mcp or src/mcp-server.ts)](integration-contract/mcp.md#mcp-server-stdio-brain-mcp-or-srcmcp-serverts) (original line 1408).

<a id="hosted-authoritative-application-tools"></a>

- [Hosted authoritative application tools](integration-contract/mcp.md#hosted-authoritative-application-tools) (original line 1461).

<a id="hosted-png-mask-application-additive-1037"></a>

- [Hosted PNG mask application (additive, #1037)](integration-contract/mcp.md#hosted-png-mask-application-additive-1037) (original line 1533).

<a id="chat-ui-in-process-tools-mcp__brain-ui__"></a>

- [Chat-UI in-process tools (mcp__brain-ui__*)](integration-contract/mcp.md#chat-ui-in-process-tools-mcp__brain-ui__) (original line 1567).

<a id="tool-component-contracts"></a>

- [Tool component contracts](integration-contract/mcp.md#tool-component-contracts) (original line 1594).

<a id="ask_user_form-additive-in-0400"></a>

- [ask_user_form (additive in 0.40.0)](integration-contract/mcp.md#ask_user_form-additive-in-0400) (original line 1610).

<a id="ask_user_rank-additive-in-0400"></a>

- [ask_user_rank (additive in 0.40.0)](integration-contract/mcp.md#ask_user_rank-additive-in-0400) (original line 1667).

<a id="ask_user_list-additive-in-0400"></a>

- [ask_user_list (additive in 0.40.0)](integration-contract/mcp.md#ask_user_list-additive-in-0400) (original line 1699).

<a id="ui-server-http-routes"></a>

- [ui-server HTTP routes](integration-contract/http.md#ui-server-http-routes) (original line 1916).

<a id="published-react-health-and-sync-helpers-breaking-health-correction"></a>

- [Published React health and sync helpers (breaking health correction)](integration-contract/http.md#published-react-health-and-sync-helpers-breaking-health-correction) (original line 1937).

<a id="typed-status-software-identity-additive-598"></a>

- [Typed status software identity (additive, #598)](integration-contract/http.md#typed-status-software-identity-additive-598) (original line 1959).

<a id="internal-queue-poke-additive"></a>

- [Internal Queue poke (additive)](integration-contract/http.md#internal-queue-poke-additive) (original line 1971).

<a id="interactive-html-preview-additive-1084"></a>

- [Interactive HTML preview (additive, #1084)](integration-contract/http.md#interactive-html-preview-additive-1084) (original line 1983).

<a id="account-partition-key-additive-1014"></a>

- [Account partition key (additive, #1014)](integration-contract/http.md#account-partition-key-additive-1014) (original line 2000).

<a id="corpus-stats-history-get-apibrainstatshistory-additive-in-0400"></a>

- [Corpus stats history (GET /api/brain/stats/history, additive in 0.40.0)](integration-contract/http.md#corpus-stats-history-get-apibrainstatshistory-additive-in-0400) (original line 2033).

<a id="runtime-stats-get-apiactivitystats-additive-in-0370"></a>

- [Runtime stats (GET /api/activity/stats, additive in 0.37.0)](integration-contract/http.md#runtime-stats-get-apiactivitystats-additive-in-0370) (original line 2041).

<a id="content-index-query-api"></a>

- [Content-index query API](integration-contract/package-api.md#content-index-query-api) (original line 2119).

<a id="ui-server-optional-core-peer-breaking-host-migration-697"></a>

- [UI server optional core peer (breaking host migration, #697)](integration-contract/package-api.md#ui-server-optional-core-peer-breaking-host-migration-697) (original line 2161).

<a id="braindb-direct-sql-reads"></a>

- [brain.db (direct SQL reads)](integration-contract/frontmatter.md#braindb-direct-sql-reads) (original line 2222).

<a id="revision-negotiation"></a>

- [Revision negotiation](integration-contract/wire.md#revision-negotiation) (original line 2308).

<a id="server--client-frames"></a>

- [Server → client frames](integration-contract/wire.md#server--client-frames) (original line 2353).

<a id="durable-queue-and-actions-additive"></a>

- [Durable Queue and Actions (additive)](integration-contract/wire.md#durable-queue-and-actions-additive) (original line 2372).

<a id="action-notices-additive-683"></a>

- [Action notices (additive, #683)](integration-contract/wire.md#action-notices-additive-683) (original line 2506).

<a id="activity-stream-rev-3-additive"></a>

- [Activity stream (rev 3, additive)](integration-contract/wire.md#activity-stream-rev-3-additive) (original line 2556).

<a id="classified-blocks-rev-4-additive"></a>

- [Classified blocks (rev 4, additive)](integration-contract/wire.md#classified-blocks-rev-4-additive) (original line 2626).

<a id="per-message-reasoning-effort-additive-543"></a>

- [Per-message reasoning effort (additive, #543)](integration-contract/wire.md#per-message-reasoning-effort-additive-543) (original line 2662).

<a id="message-source-additive-in-0390"></a>

- [Message source (additive in 0.39.0)](integration-contract/wire.md#message-source-additive-in-0390) (original line 2714).

<a id="local-exchanges-additive-in-0400"></a>

- [Local exchanges (additive in 0.40.0)](integration-contract/wire.md#local-exchanges-additive-in-0400) (original line 2735).

<a id="turn-failures-additive-in-0400"></a>

- [Turn failures (additive in 0.40.0)](integration-contract/wire.md#turn-failures-additive-in-0400) (original line 2776).

<a id="manual-retry-receipts-additive-in-0400"></a>

- [Manual retry receipts (additive in 0.40.0)](integration-contract/wire.md#manual-retry-receipts-additive-in-0400) (original line 2853).

<a id="cross-backend-handoff-additive-61"></a>

- [Cross-backend handoff (additive, #61)](integration-contract/wire.md#cross-backend-handoff-additive-61) (original line 2892).

<a id="unavailable-profiles-additive-1044"></a>

- [Unavailable profiles (additive, #1044)](integration-contract/wire.md#unavailable-profiles-additive-1044) (original line 2964).

<a id="tool-resolution-receipts-additive-957"></a>

- [Tool resolution receipts (additive, #957)](integration-contract/wire.md#tool-resolution-receipts-additive-957) (original line 2993).

<a id="live-conversation-additive-957"></a>

- [Live conversation (additive, #957)](integration-contract/wire.md#live-conversation-additive-957) (original line 3028).

<a id="interactive-answer-receipts-breaking-910"></a>

- [Interactive answer receipts (breaking, #910)](integration-contract/wire.md#interactive-answer-receipts-breaking-910) (original line 3216).

<a id="session-drafts-additive-979"></a>

- [Session drafts (additive, #979)](integration-contract/wire.md#session-drafts-additive-979) (original line 3318).

<a id="session-recovery-additive-964"></a>

- [Session recovery (additive, #964)](integration-contract/wire.md#session-recovery-additive-964) (original line 3387).

<a id="pending-follow-ups-additive-1002"></a>

- [Pending follow-ups (additive, #1002)](integration-contract/wire.md#pending-follow-ups-additive-1002) (original line 3480).

<a id="pill-labels-additive-1004"></a>

- [Pill labels (additive, #1004)](integration-contract/wire.md#pill-labels-additive-1004) (original line 3525).

<a id="file-layer-contracts"></a>

- [File-layer contracts](integration-contract/frontmatter.md#file-layer-contracts) (original line 3591).

<a id="extension-interfaces"></a>

- [Extension interfaces](integration-contract/package-api.md#extension-interfaces) (original line 3691).

<a id="dictation-speech-integration-and-conformance"></a>

- [Dictation speech integration and conformance](integration-contract/package-api.md#dictation-speech-integration-and-conformance) (original line 3728).

<a id="saved-audio-transcription-additive-1021"></a>

- [Saved-audio transcription (additive, #1021)](integration-contract/package-api.md#saved-audio-transcription-additive-1021) (original line 3773).

<a id="siteadapter-conformance-and-migration"></a>

- [SiteAdapter conformance and migration](integration-contract/package-api.md#siteadapter-conformance-and-migration) (original line 3880).

<a id="agentbackend-conformance-baseline"></a>

- [AgentBackend conformance baseline](integration-contract/package-api.md#agentbackend-conformance-baseline) (original line 3919).

<a id="hygiene-review-data-additive-1024"></a>

- [Hygiene review data (additive, #1024)](integration-contract/package-api.md#hygiene-review-data-additive-1024) (original line 3984).

<a id="hygiene-selection-additive-1026"></a>

- [Hygiene selection (additive, #1026)](integration-contract/package-api.md#hygiene-selection-additive-1026) (original line 4011).

<a id="module-hygiene-context-breaking-699"></a>

- [Module hygiene context (breaking, #699)](integration-contract/package-api.md#module-hygiene-context-breaking-699) (original line 4099).

<a id="module-dormancy-additive-527"></a>

- [Module dormancy (additive, #527)](integration-contract/package-api.md#module-dormancy-additive-527) (original line 4127).

<a id="module-settings-additive-528"></a>

- [Module settings (additive, #528)](integration-contract/package-api.md#module-settings-additive-528) (original line 4171).

<a id="module-tools"></a>

- [Module tools](integration-contract/mcp.md#module-tools) (original line 4251).

<a id="first-party-module-tools"></a>

- [First-party module tools](integration-contract/mcp.md#first-party-module-tools) (original line 4327).

<a id="guarantees-consumers-may-rely-on"></a>

- [Guarantees consumers may rely on](integration-contract/package-api.md#guarantees-consumers-may-rely-on) (original line 4354).

<a id="recommended-consumer-hygiene"></a>

- [Recommended consumer hygiene](integration-contract/package-api.md#recommended-consumer-hygiene) (original line 4379).

<a id="configuration-exclusions"></a>

- [Configuration exclusions](integration-contract/package-api.md#configuration-exclusions) (original line 4385).

<a id="backend-confirmation-pattern-initialization"></a>

- [Backend confirmation-pattern initialization](integration-contract/package-api.md#backend-confirmation-pattern-initialization) (original line 4400).

<a id="nullable-asset-enrichment"></a>

- [Nullable asset enrichment](integration-contract/package-api.md#nullable-asset-enrichment) (original line 4416).

<a id="backend-authoring-permission-toolkit"></a>

- [Backend-authoring permission toolkit](integration-contract/package-api.md#backend-authoring-permission-toolkit) (original line 4445).

<a id="durable-share-and-cli-intake-additive-679"></a>

- [Durable share and CLI intake (additive, #679)](integration-contract/cli.md#durable-share-and-cli-intake-additive-679) (original line 4501).

<a id="shared-geo-library-additive-525"></a>

- [Shared geo library (additive, #525)](integration-contract/package-api.md#shared-geo-library-additive-525) (original line 4548).

<a id="shared-geo-configuration-and-server-geocoding"></a>

- [Shared geo configuration and server geocoding](integration-contract/package-api.md#shared-geo-configuration-and-server-geocoding) (original line 4621).

<a id="shared-routing-results"></a>

- [Shared routing results](integration-contract/package-api.md#shared-routing-results) (original line 4660).

<a id="shared-overpass-poi-results"></a>

- [Shared Overpass POI results](integration-contract/package-api.md#shared-overpass-poi-results) (original line 4692).

<a id="shared-background-geometry-and-sdk-adapters"></a>

- [Shared background geometry and SDK adapters](integration-contract/package-api.md#shared-background-geometry-and-sdk-adapters) (original line 4730).

<a id="canonical-consumer-configuration"></a>

- [Canonical consumer configuration](integration-contract/package-api.md#canonical-consumer-configuration) (original line 4770).

<a id="local-vector-static-maps"></a>

- [Local vector static maps](integration-contract/package-api.md#local-vector-static-maps) (original line 4796).

<a id="geo-cli-envelopes"></a>

- [Geo CLI envelopes](integration-contract/package-api.md#geo-cli-envelopes) (original line 4845).

<a id="imported-track-files-in-chat-additive"></a>

- [Imported track files in chat (additive)](integration-contract/package-api.md#imported-track-files-in-chat-additive) (original line 4889).

<a id="pi-native-endpoint-routing-breaking-routing-migration-762"></a>

- [Pi native endpoint routing (breaking routing migration, #762)](integration-contract/package-api.md#pi-native-endpoint-routing-breaking-routing-migration-762) (original line 5016).

<a id="scheduled-tasks-additive-914"></a>

- [Scheduled tasks (additive, #914)](integration-contract/package-api.md#scheduled-tasks-additive-914) (original line 5047).

<a id="scheduled-task-contract-preparation-913"></a>

- [Scheduled-task contract preparation (#913)](integration-contract/package-api.md#scheduled-task-contract-preparation-913) (original line 5159).

<a id="shared-definition-and-response-types"></a>

- [Shared definition and response types](integration-contract/package-api.md#shared-definition-and-response-types) (original line 5172).

<a id="approval-endpoints-and-receipts"></a>

- [Approval, endpoints and receipts](integration-contract/package-api.md#approval-endpoints-and-receipts) (original line 5339).

<a id="cli-and-tool-mapping"></a>

- [CLI and tool mapping](integration-contract/package-api.md#cli-and-tool-mapping) (original line 5400).

<a id="activity-notification-and-recovery-compatibility"></a>

- [Activity, notification and recovery compatibility](integration-contract/package-api.md#activity-notification-and-recovery-compatibility) (original line 5652).

<a id="video-watching-opt-in-module"></a>

- [Video watching (opt-in module)](integration-contract/package-api.md#video-watching-opt-in-module) (original line 5673).

<a id="bounded-hygiene-repair-operations-additive-1025"></a>

- [Bounded hygiene repair operations (additive, #1025)](integration-contract/package-api.md#bounded-hygiene-repair-operations-additive-1025) (original line 5696).

<a id="human-started-hygiene-review-additive-1027"></a>

- [Human-started hygiene review (additive, #1027)](integration-contract/package-api.md#human-started-hygiene-review-additive-1027) (original line 5768).
