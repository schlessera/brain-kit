# Supported HTTP API

This is the `@schlessera/brain-ui-server` HTTP specification under the
[integration contract](integration-contract.md) and the
[HTTP selection decision](decisions/http-api-boundary.md). **Supported** means
an independent client or integration may rely on the specified method, path,
inputs, responses and behavior. **Internal** means a transport used by the
paired UI implementation; its raw path and payload are excluded from the HTTP
compatibility guarantee. Authentication requirements are a separate property.
A public liveness probe can be supported; an authenticated settings route can
be internal.

The inventory includes the additive Queue intake, poke, scheduled-task, session-draft, composer-file, session-recovery, attachment-read, interactive HTML preview, saved-audio transcription, human-started hygiene-review, governance-event, roadblock-report, reference-grant, Apify-state, Apify-policy, retained-journal/user-revert, untrusted-mark, chat-deletion and individual safety-review routes mounted by `createApp`: 179 unique declared
method/path pairs, plus the conditional SPA fallback. It describes the current
implementation, including limitations, rather than a proposed redesign.
Unknown response fields must be tolerated. There is no HTTP API revision
parameter, universal JSON envelope, or HTTP `schema_version` field.

## Inventory and selection

Each row is one declared method/path. `S` means supported and specified below;
`I` means internal. The reason column names the current consumer and any
inherited promise. New selections of independent retrieval/capture endpoints
are deliberate here; existing promises are retained even where runtime or
client code has a gap. Source owners are listed after the table.

| Method | Path | Class | Purpose | Consumers, existing promise and reason |
| --- | --- | --- | --- | --- |
| GET | `/api/storage/removals` | S | Read removal capability and latest receipt | Current human-owner authority; exact canonical attachments only. |
| POST | `/api/storage/removals/inspection` | S | Inspect current attachment facts | Read bounded eligibility and consequences without allocating a durable operation. |
| POST | `/api/storage/removals/reviews` | S | Review exact attachment paths | Bound versions, consequences and recovery coverage before confirmation. |
| POST | `/api/storage/removals/undo-reviews` | S | Review retained originals for Undo | New identity and current absent-target checks. |
| POST | `/api/storage/removals` | S | Confirm one reviewed selection | Durable intent and verified originals precede unlink. |
| GET | `/api/storage/removals/:id` | S | Read a removal or Undo receipt | Principal-bound readback never replays effects. |
| DELETE | `/api/storage/removals/:id` | S | Cancel remaining selected items | Current acknowledgement finishes; completed effects remain. |
| GET | `/api/storage/maintenance` | S | Read approved maintenance rows and latest receipts | Current human-owner authority; three fixed owners only. |
| POST | `/api/storage/maintenance` | S | Admit one identified maintenance operation | Durable owner-bound identity and credential-free worker execution. |
| GET | `/api/storage/maintenance/:id` | S | Read the original operation receipt | Readback never replays an effect. |
| DELETE | `/api/storage/maintenance/:id` | S | Request cancellation of remaining work | Existing committed effects remain in the receipt. |
| GET | `/api/storage/history` | S | Read bounded aggregate history | Current human-owner access; no scan on read. |
| GET | `/api/storage/guidance` | S | Read pressure, scenarios and delivery evidence | Current human-owner access; no scan on read. |
| GET | `/api/storage` | S | Read current bounded inventory state | Human-owner Storage inspection; no delegated or worker access. |
| POST | `/api/storage/scans` | S | Refresh configured stores | Human-owner Storage inspection; no delegated or worker access. |
| DELETE | `/api/storage/scans/:id` | S | Cancel an active scan | Human-owner Storage inspection; no delegated or worker access. |
| GET | `/api/storage/scans/:id/entries` | S | Read a filtered bounded page | Human-owner Storage inspection; no delegated or worker access. |
| GET | `/api/storage/scans/:id/tree` | S | Read a bounded subtree projection | Human-owner Storage inspection; no delegated or worker access. |
| GET | `/api/storage/scans/:id/entries/:entryId/references` | S | Inspect bounded indexed reference evidence | Human-owner Storage inspection; no delegated or worker access. |
| GET | `/api/activity/digest` | I | Read digest and record app visit | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| POST | `/api/activity/digest/dismiss` | I | Record digest dismissal | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| POST | `/api/activity/digest/generate` | I | Generate digest manually | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| GET | `/api/activity/inbox` | I | List presentation intents | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| POST | `/api/activity/inbox/:id/ack` | I | Acknowledge one intent | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| POST | `/api/activity/inbox/ack-all` | I | Acknowledge all intents | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| GET | `/api/activity/rollups` | S | Aggregate runs by day/job/session | Independent monitoring; preserve activity README, SDK wire shapes and detailed stats contract. |
| GET | `/api/activity/runs` | S | List live roots and paginated history | Independent monitoring; preserve activity README, SDK wire shapes and detailed stats contract. |
| GET | `/api/activity/runs/:runId` | S | Read retained run detail or pruned rollup | Independent monitoring; preserve activity README, SDK wire shapes and detailed stats contract. |
| GET | `/api/activity/stats` | S | Read labeled runtime statistics and coverage | Independent monitoring; preserve activity README, SDK wire shapes and detailed stats contract. |
| POST | `/api/auth/login` | S | Verify password and issue owner cookie | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/logout` | S | Revoke cookie session(s) and clear cookie | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| GET | `/api/auth/methods` | S | Report available login methods | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| DELETE | `/api/auth/passkey/:id` | S | Delete credential and revoke its sessions | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| PUT | `/api/auth/passkey/:id` | S | Rename a credential | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| GET | `/api/auth/passkey/list` | S | List credential summaries across RPs | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/passkey/login-options` | S | Create authentication challenge/options | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/passkey/login-verify` | S | Verify assertion and issue owner cookie | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/passkey/register-options` | S | Create registration challenge/options | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/passkey/register-verify` | S | Verify and store a passkey | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| GET | `/api/auth/principals` | S | List live principals | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/principals` | S | Mint a delegated agent credential | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| DELETE | `/api/auth/principals/:id` | S | Revoke a principal and its descendants | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| GET | `/api/auth/principals/:id/reference-grants` | S | List a principal's live reference-source grants | Owner authority for private reference acquisition (#2429); additive. |
| POST | `/api/auth/principals/:id/reference-grants` | S | Grant a principal a repository prefix and named host credential | Owner authority for private reference acquisition (#2429); additive. |
| DELETE | `/api/auth/principals/:id/reference-grants/:grantId` | S | Revoke one reference-source grant | Owner authority for private reference acquisition (#2429); additive. |
| POST | `/api/brain/add` | S | Capture content and report indexing outcome | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/brain/briefing` | S | Read CLI briefing text | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| POST | `/api/brain/index` | S | Retry incremental indexing without recapture | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/brain/list` | S | List filtered document summaries | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/brain/search` | S | Search corpus and return degraded-mode warnings | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/brain/stats` | S | Read current corpus statistics | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/brain/stats/history` | S | Read recorded corpus-stat series | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| POST | `/api/brain/sync` | S | Stream a serialized repository sync | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/drafts` | S | List live session drafts | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| GET | `/api/drafts/:id/profile` | S | Read confirmed worker profile and enforced facts | Independent session clients; preserve policy lower bounds, principal scope and truthful unknown limits (#1663). |
| PUT | `/api/drafts/:id/profile` | S | Save a next-turn tightening preference | Independent session clients; preserve confirmed saves, current-turn profile and voice read-only authority (#1663). |
| GET | `/api/drafts/:draftId` | S | Read a draft's text and images | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| PUT | `/api/drafts/:draftId` | S | Create or replace a draft revision with If-Match | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| DELETE | `/api/drafts/:draftId` | S | Delete a draft, leaving a tombstone | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| POST | `/api/drafts/:draftId/attachments` | S | Store one draft image | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| POST | `/api/drafts/:draftId/bind` | S | Bind a draft to the session its accepted first message started | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| POST | `/api/drafts/:draftId/files` | S | Store one composer file as a durable, read-only original | Composer file attachments (#3153); preserve streaming admission, idempotency receipts, draft and pool bounds and the no-execution boundary. |
| GET | `/api/attachments/:fileId` | S | Read back one referenced composer original after checking its digest | Composer file attachments (#3153); preserve reference-only authorization, digest checking and the download headers. |
| GET | `/api/files/content` | S | Read content metadata/text or raw bytes | Independent content clients and SDK service-worker policy; raw API media remains network-only. |
| GET | `/api/files/html` | I | Serve an HTML file for the sandboxed, script-running preview | React file viewer iframe and "Open in new tab" link (#1084); browser-rendered UI transport. Its isolation headers are specified below. |
| GET | `/api/files/resolve` | I | Resolve ancestor navigation and existence | React file browser; view/navigation helpers are paired UI transport. |
| GET | `/api/files/tree` | I | List browsable directory entries | React file browser; view/navigation helpers are paired UI transport. |
| GET | `/api/files/wikilinks` | I | Read or refresh cached slug-to-path map | React file browser; view/navigation helpers are paired UI transport. |
| GET | `/api/files/untrusted` | I | Read one path's untrusted mark as this principal may see it | React Files toolbar (#2673); paired UI transport. Its authority and disclosure rules are specified below. |
| PUT | `/api/files/untrusted` | I | Mark a readable file untrusted | React Files toolbar (#2673); paired UI transport. Its authority and disclosure rules are specified below. |
| DELETE | `/api/files/untrusted` | I | Clear a present or retained mark (owner only) | React Files toolbar and `Marked untrusted` list (#2673); paired UI transport. Its authority rules are specified below. |
| GET | `/api/files/untrusted/list` | I | List the marks this principal may see | React `Marked untrusted` list (#2673); paired UI transport. Its disclosure rules are specified below. |
| GET | `/api/geo/coastline` | S | Read attributed map geometry for a bounding box | Independent map clients; preserve show_block map HTTP promise and graceful geometry degradation. |
| GET | `/api/governance/roadblocks` | I | Retained roadblock rankings for the paired activity bridge | #1672; authenticated and local-only. The additive `query_activity` scope is the supported agent contract. |
| GET | `/api/governance/events` | S | Read the governance events kept with session history | Independent diagnostics and the roadblock report; additive #1651 ([contract](integration-contract/http.md#governance-events-additive-1651)). Versioned per kind; never renders to the user. |
| GET | `/api/graph/clusters` | I | Read clustered presentation graph | React graph views; no independent HTTP guarantee. Existing CLI/MCP and direct-SQL promises remain separately binding. |
| GET | `/api/graph/discovery` | I | Read root-based discovery subgraph | React graph views; no independent HTTP guarantee. Existing CLI/MCP and direct-SQL promises remain separately binding. |
| GET | `/api/graph/maintenance` | I | Read graph maintenance findings | React graph views; no independent HTTP guarantee. Existing CLI/MCP and direct-SQL promises remain separately binding. |
| GET | `/api/graph/meta` | I | Read graph availability and provenance | React graph views; no independent HTTP guarantee. Existing CLI/MCP and direct-SQL promises remain separately binding. |
| GET | `/api/graph/neighborhood` | I | Read bounded local presentation subgraph | React graph views; no independent HTTP guarantee. Existing CLI/MCP and direct-SQL promises remain separately binding. |
| GET | `/api/health` | S | Probe SQLite liveness without identity | Health probes and React connectivity; preserve public minimal response without identity. |
| GET | `/api/hygiene/review` | S | Read the durable review strip and pending Action | Independent clients and hygiene review controls; preserve SDK review/read shapes. |
| POST | `/api/hygiene/review` | S | Start, pause, resume or refresh human review | Human principal authority and one pending Action; preserve SDK command/read shapes. |
| GET | `/api/hygiene/review/details/:itemId` | S | Read the owner-only recorded facts behind a private managed-worktree card | Owner principal only, per request; never cached or replicated. Preserve SDK details shapes. |
| POST | `/api/hygiene/review/preview` | S | Bind typed handler input to a current CLI preview | Human principal authority, stored option and version; preserve SDK preview shapes. |
| POST | `/api/internal/inbox/poke` | S | Recover and trigger the Queue lifecycle | Generated-host cron caller; independent boot bearer token plus actual loopback socket. See the [runtime specification](inbox-runtime.md). |
| GET | `/api/models` | S | Read full catalog including hidden profiles | Independent chat clients; preserve model README and SDK ModelCatalogResponse/hidden-set promises. |
| PUT | `/api/models/billing` | I | Replace billing classification overrides | React settings: incidental configuration transport; no independent HTTP promise. Supported hidden-set override listed separately. |
| PUT | `/api/models/custom` | I | Replace custom OpenRouter model IDs | React settings: incidental configuration transport; no independent HTTP promise. Supported hidden-set override listed separately. |
| PUT | `/api/models/default` | I | Replace preferred model selection | React settings: incidental configuration transport; no independent HTTP promise. Supported hidden-set override listed separately. |
| PUT | `/api/models/hidden` | S | Replace hidden-profile set | README and SDK explicitly name this route; hidden profiles remain usable by pinned sessions. |
| GET | `/api/models/pricing` | I | Read pricing-table freshness | React settings: incidental configuration transport; no independent HTTP promise. Supported hidden-set override listed separately. |
| POST | `/api/models/refresh` | S | Force model discovery refresh | Independent chat clients; preserve model README and SDK ModelCatalogResponse/hidden-set promises. |
| PUT | `/api/models/thinking` | I | Replace reasoning-effort overrides | React settings: incidental configuration transport; no independent HTTP promise. Supported hidden-set override listed separately. |
| GET | `/api/modules` | I | List configured modules, including unavailable neighbors | React module settings; CLI module/settings contracts remain binding. |
| GET | `/api/modules/:name/settings` | I | Read schema, values, provenance and revision | React module settings; CLI module/settings contracts remain binding. |
| PUT | `/api/modules/:name/settings` | I | Validate and commit JSON overrides with If-Match | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/modules/:name/settings/preview` | I | Validate a draft and compute module notes without writing | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/modules/:name/migration/preview` | I | Preview a module-owned content migration | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/modules/:name/migration` | I | Apply the reviewed migration atomically | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/modules/:name/state` | I | Activate or park a configured workflow | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/modules/:name/actions/:id` | I | Run a declared module CLI action using saved settings | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/pi-auth/login` | I | Start configured vendor OAuth flow | Pi settings UI; configured-vendor-specific administrative transport, not brain session authentication. |
| DELETE | `/api/pi-auth/login/:id` | I | Cancel vendor login flow | Pi settings UI; configured-vendor-specific administrative transport, not brain session authentication. |
| GET | `/api/pi-auth/login/:id` | I | Poll vendor login flow | Pi settings UI; configured-vendor-specific administrative transport, not brain session authentication. |
| POST | `/api/pi-auth/logout` | I | Remove configured vendor credential | Pi settings UI; configured-vendor-specific administrative transport, not brain session authentication. |
| GET | `/api/pi-auth/providers` | I | Read configured vendor credential status | Pi settings UI; configured-vendor-specific administrative transport, not brain session authentication. |
| GET | `/api/providers` | S | Read visible profiles and backend capabilities | Independent chat clients; preserve model README and SDK ModelCatalogResponse/hidden-set promises. |
| GET | `/api/push/public-key` | S | Read VAPID application-server public key | SDK push renewal and custom PWA clients; preserve principal ownership and private-key exclusion. |
| POST | `/api/push/subscribe` | S | Bind/renew a browser subscription | SDK push renewal and custom PWA clients; preserve principal ownership and private-key exclusion. |
| GET | `/api/push/subscriptions` | S | Inspect caller-owned subscription summaries | SDK push renewal and custom PWA clients; preserve principal ownership and private-key exclusion. |
| POST | `/api/push/zone` | I | Refresh a client context's reported notification zone | React lifecycle refresh for client-local Action notice timing; registration carries the device zone through the supported subscribe input. |
| POST | `/api/push/unsubscribe` | S | Remove caller-owned subscription | SDK push renewal and custom PWA clients; preserve principal ownership and private-key exclusion. |
| POST | `/api/render` | S | Render supplied document to PNG or PDF | Independent share/render clients; preserve RenderRequest, renderer seam and 501 without renderer. |
| GET | `/api/sessions` | S | List backend sessions with partial availability | Independent session clients; preserve SDK ChatSession/history shapes and partial-backend availability behavior. |
| GET | `/api/sessions/:id/profile` | S | Read confirmed worker profile and enforced facts | Independent session clients; preserve policy lower bounds, principal scope and truthful unknown limits (#1663). |
| PUT | `/api/sessions/:id/profile` | S | Save a next-turn tightening preference | Independent session clients; preserve confirmed saves, current-turn profile and voice read-only authority (#1663). |
| GET | `/api/sessions/:id` | S | Read owning-backend session transcript | Independent session clients; preserve SDK ChatSession/history shapes and partial-backend availability behavior. |
| GET | `/api/sessions/:sessionId/turns/:turnId/revert/plan` | S | Review eligible and excluded history paths | Current human principal; exact session/turn; optional action revert/restore. |
| GET | `/api/sessions/:sessionId/turns/:turnId/revert` | S | Read latest original history receipt | Bound to current principal/session/source turn; never retries effects. |
| GET | `/api/sessions/:sessionId/turns/:turnId/revert/:operationId` | S | Reconcile one original operation | Same bound identity; missing receipt stays unavailable. |
| POST | `/api/chat-deletions` | S | Delete the caller's own chat's local history | Authenticated owner only; stable caller operation identity; content-free per-store outcomes (#3230). |
| GET | `/api/chat-deletions/:operationId` | S | Read one deletion operation's current receipt | Read-only and owner-scoped; one content-free `not_admitted` for every miss (#3455). |
| POST | `/api/sessions/:sessionId/turns/:turnId/revert` | S | Start a user-only journaled revert or restoration | Stable caller operation identity; raw stale-state comparison; gate and shared server locks. |
| GET | `/api/sessions/:sessionId/turns/:turnId/journal` | S | Read retained turn observations | Exact session/turn ownership; nullable unknown facts and explicit expiry. |
| GET | `/api/sessions/:sessionId/turns/:turnId/journal/:sequence/preview` | S | Read a bounded text preview | Raw UTF-8 bytes; explicit size/line/binary fallback, no coercion. |
| GET | `/api/sessions/:sessionId/turns/:turnId/journal/:sequence/:side` | S | Download a retained raw version | Before/after only; durable read lease, no direct hash access. |
| GET | `/api/journal/configuration-coverage` | S | Read the brain's current untraced configuration-input set | Latest complete inventoried turn only; explicit `unknown`, never an empty list. |
| GET | `/api/agent-policy` | I | Read shared admission policy and reported enforcing limits | Read-only Devices & agents facts; no editor or duplicate policy cache. |
| GET | `/api/policy-proposals/:turnId/:requestId` | I | Read one principal-owned policy request receipt | Same-request reconciliation only; never writes or reactivates approval. |
| GET | `/api/sessions/:id/safety` | S | Read bounded revisioned host safety evidence | Exact authenticated history owner; immutable records, snapshot aggregate/high-water, scoped cursor, explicit coverage/unavailable, no mutation (#3604). |
| POST | `/api/sessions/:id/safety/reviews/prepare` | S | Prepare review of one finalized safety occurrence | Live password-mode human owner, exact Origin and bounded JSON; host-issued body/brain/principal/generation-bound handle (#3603). |
| POST | `/api/sessions/:id/safety/reviews/:requestId/commit` | S | Commit or read back one individual safe verdict | Live owner rechecked on the acquired FULL transaction and final response; immutable receipt plus fresh aggregate, no bulk clear or standing rule (#3603). |
| GET | `/api/sessions/:id/attachment-reads` | S | Read a session's recorded attachment reads, outcome and scope only | Sent-row read states (#3589, #3155); preserve the session and message-reference filters, no text and no provider path. |
| GET | `/api/sessions/:id/recovery` | S | Read a session's latest accepted work and pending interactions | Trackers and independent session clients (#964, D52); preserve the revision ordering, Activity terminal proof, honest unknown and the no-execution boundary. |
| POST | `/api/queue` | S | Queue authenticated CLI intake without filing content | CLI and independent intake clients; preserve explicit key, provenance and queue receipt. |
| GET | `/api/schedules` | S | List stored scheduled tasks, cancelled ones included | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/schedules` | S | Publish an approved schedule proposal | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/schedules/:id/cancel` | S | Cancel future and unstarted work of one task | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/schedules/:id/reconcile` | S | Reopen a task paused by a restore or an unknown effect | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| GET | `/api/schedules/due` | S | Read due candidates without claiming them | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/schedules/proposals` | S | Store a schedule proposal for review | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/schedules/proposals/:id/approve` | S | Record a verified operator approval | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/share` | S | Stage and queue confirmed untrusted share payload | SDK share-target and custom PWA shells; preserve ShareIntakeResult and body-unread fallback. |
| GET | `/api/skills` | I | List built-in and custom skills | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| POST | `/api/skills` | I | Create custom skill and sync agent links | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| DELETE | `/api/skills/:name` | I | Delete custom skill and sync | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| GET | `/api/skills/:name` | I | Read skill detail and files | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| PUT | `/api/skills/:name` | I | Replace custom skill content and sync | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| POST | `/api/skills/:name/enabled` | I | Change enabled state and sync | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| POST | `/api/skills/install/github` | I | Install skills from GitHub and sync | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| POST | `/api/skills/install/zip` | I | Install uploaded skill archive and sync | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| GET | `/api/status` | S | Read protected operational/runtime status | Independent monitoring and React status; preserve release/runtime/subscription promises. |
| POST | `/api/status/worker-host` | S | Re-run the agent worker host probe and return what it recorded | React "Check again" and independent monitoring; additive #1632 ([contract](integration-contract/http.md#worker-host-status-additive-1632)). Admits no turn. |
| POST | `/api/track-upload` | I | Validate and stage composer track originals | Paired React composer transport; the published file-reference wire/block behavior remains its own contract. |
| GET | `/api/tracks` | I | Resolve canonical imported-track evidence | Paired React track-block/export transport; no independent retrieval API selected. |
| GET | `/api/tool-permissions` | I | List remembered always-allow grants | React approval settings; paired administrative transport. Permission behavior remains governed by its own contract. |
| DELETE | `/api/tool-permissions/:tool` | I | Revoke one remembered grant | React approval settings; paired administrative transport. Permission behavior remains governed by its own contract. |
| GET | `/api/voice/providers` | S | Read registered dictation providers and effective selection; never mint | Authenticated discovery, no-store. |
| GET | `/api/voice/dictation/settings` | S | Read brain-wide dictation choice, SMART mode and revision | Independent of live conversation settings. |
| PUT | `/api/voice/dictation/settings` | S | Save dictation choice with If-Match revision | Human owner/ambient only; stale writes never overwrite. |
| GET | `/api/voice/capabilities` | S | Read active-provider capabilities without minting a credential | Saved-audio discovery and independent clients; additive #1021 contract. |
| GET | `/api/voice/recordings/:recordingId/transcription` | S | Read an account-owned durable transcription receipt | Saved-audio status recovery; never dispatches a provider. |
| PUT | `/api/voice/recordings/:recordingId/transcription` | S | Explicitly upload or retry saved audio | Account ownership, verified hash, bounded body and durable claim protect idempotency. |
| DELETE | `/api/voice/recordings/:recordingId/transcription` | S | Erase transcript text and retain a tombstone | Explicit acceptance/discard; delayed uploads cannot reopen consumed ids. |
| GET | `/api/voice/keyterms` | S | Read or rebuild domain keyterms | Independent speech clients; preserve SDK VoiceSessionResponse, deprecated token transition and keyterm shapes. |
| GET | `/api/voice/overrides` | S | Read pronunciation replacements | Independent speech clients; preserve SDK VoiceSessionResponse, deprecated token transition and keyterm shapes. |
| POST | `/api/voice/session` | S | Mint active-provider dictation session | Independent speech clients; preserve SDK VoiceSessionResponse, deprecated token transition and keyterm shapes. |
| POST | `/api/voice/token` | S | Mint deprecated Deepgram token response | Independent speech clients; preserve SDK VoiceSessionResponse, deprecated token transition and keyterm shapes. |
| GET | `/api/vpn-check` | I | Probe authenticated reachability and name the account partition | React ConnectionGate probe; mode-independent {vpn:true} is UI transport, not a VPN assertion for integrations. Additive `accountKey` names the device-local account partition ([contract](integration-contract/http.md#account-partition-key-additive-1014)). |
| GET | `/api/web-search` | I | Read backend web-search settings | Pi settings UI; backend-specific config editor rather than a query API. |
| PUT | `/api/web-search` | I | Update provider routing/keys and invalidate cache | Pi settings UI; backend-specific config editor rather than a query API. |
| GET | `/api/apify` | I | Read Apify provider state, policy and spend | Additively #3580: `actor_approvals: [{ actor_id, actor, approved_at }]` lists remembered Actor approvals, timestamp in Unix milliseconds.  Settings UI (#3159, #3163); live human owners only. Reports `disabled`, `authentication_required`, `configured` or `unavailable`; never a token. Contacts Apify only while the policy enables it. Additively since #3163 also `policy` (the effective `apify` block, each grant's `active`/`expired`/`other_account` status, the policy hash an edit names as its base) and `spend` (`ledger` `absent`/`read`/`unavailable`, today's account-wide and brain ledger scopes, and unsettled runs, never as $0). `?session=&turn=` adds that turn's scope; `?refresh=1` re-verifies the token and settles open runs first. |
| POST | `/api/apify/actors/revoke` | I | Revoke one remembered Actor approval | Live human owners only. Strict `{ actor_id }`, immutable alphanumeric id. Returns `{ revoked: true }`; idempotent, scoped to brain, principal and bound account. |
| POST | `/api/apify/account` | I | Confirm the token's changed Apify account | Settings UI (#3159); live human owners only. Starts a new authority generation; accepts no token. |
| POST | `/api/apify/policy` | I | Propose one Apify setting through the policy-change review | Settings UI (#3163); live human owners only. `{ change, base_hash }` names exactly one of `enabled`, `discovery`, `actors` or `remove_grant` and the policy version it changes. Returns `{ turn_id, request_id, review }` with a pending `PolicyChangeReview` of the complete proposed `governance.md`; writes nothing. 409 when the policy changed since it was read; 422 when the file cannot be rewritten exactly. |
| POST | `/api/apify/policy/:turnId/:requestId` | I | Answer that exact review | Settings UI (#3163); only the proposing owner. `{ approve }`; an approval lets the existing policy writer publish it inside a user journal window. A repeated or late answer returns the recorded receipt and never writes again; a lost answer is reconciled through `GET /api/policy-proposals/:turnId/:requestId`. |
| POST | `/share-target` | S | Explain missing service worker without reading body | SDK share-target and custom PWA shells; preserve ShareIntakeResult and body-unread fallback. |
| GET | `/ws` | S | Authenticate and admit WebSocket upgrade | SDK BrainUiClient; supported HTTP upgrade boundary, followed by the existing wire contract. |
| GET | `/*` (conditional) | I | Serve configured SPA deep links | Custom shell with `staticRoot`; deployment asset transport, not an independent JSON API. |

The route factories live under [ui-server routes](../packages/ui-server/src/routes/).
Authentication factories live in [auth.ts](../packages/ui-server/src/middleware/auth.ts),
[passkeys.ts](../packages/ui-server/src/middleware/passkeys.ts) and
[principals.ts](../packages/ui-server/src/middleware/principals.ts).
[app.ts](../packages/ui-server/src/app.ts) owns prefixing and middleware order.
All 179 declared endpoints are mounted regardless of backend, renderer or
speech-provider availability: unavailable capabilities return the responses
below rather than removing their handlers. Only static serving is conditional.

### Implicit methods and wildcard handlers

Hono dispatches **HEAD through GET**, preserving response status/headers and
removing the body. This applies to each GET row and the conditional fallback;
it does not create another payload contract. Middleware still sees the original
HEAD method, so the non-GET origin policy also applies. Raw-file HEAD ignores
Range. WebSocket upgrade requires an actual GET.

`ALL /api/*` installs origin policy, configured CORS and authentication.
With nonempty `ALLOWED_ORIGINS`, CORS middleware answers allowed **OPTIONS
/api/** preflights with 204 before authentication, advertising GET, POST, PUT,
DELETE, the `Content-Type`, `If-Match`, `Idempotency-Key`, `Content-SHA256` and `Speech-Provider` headers, and credentials. Origin policy runs first; a rejected
origin gets 403. Without that configured middleware there is no universal
OPTIONS endpoint: authentication/routing decide the response. These are
transport behaviors, not independently supported OPTIONS resource operations.

`ALL /api/internal/inbox/poke` refuses methods other than its supported POST
with JSON HTTP 405 and `Allow: POST`, before general authentication. The
supported POST retains origin policy and its independent token/socket checks.

`ALL /api/auth/passkey/*` and `ALL /api/auth/principals/*` add mode and owner
checks to the management families after authentication. Public login ceremonies
are mounted earlier. `ALL /*` supplies logging and security headers; with
`staticRoot`, another `ALL /*` serves files and then normalized `GET /*` (declared as `"*"`) serves index.html
for unresolved deep links. Missing index.html yields 404. That fallback can
also answer an unmatched authenticated GET API path with HTML; clients must
check status and content type. Without static serving, unmatched paths use
Hono's 404. Wildcard middleware is not an additional independent resource API.

### Supported SDK and React dependencies

The SDK's published `/push-handlers` entry defaults renewal to
`POST /api/push/subscribe`; the whole supported subscription lifecycle is
specified below. Its `/share-target` entry defaults interception to
`POST /share-target`; the fallback and confirmed upload remain supported.
`/sw-policy` treats all `/api` traffic, including raw content loaded as images,
as network-only. It does not turn every matching URL into a stable HTTP API.
`BrainUiClient` accepts a caller-supplied socket URL; `/ws` admission and the
wire protocol are supported. SDK HTTP payload types named below retain their
public shape promises.

The React package exports `createBrainApi` and exposes `root.api` as an
embedding service. Those **public function signatures and behavior** must
remain compatible under the public-export policy; this inventory does not
reclassify ordinary exports or signature-reachable SDK types as internal.
Some functions implement UI settings/digest workflows through internal HTTP
rows. Changing such transport requires changing the paired client together
while preserving the public function's supported behavior, or obtaining the
required ruling for a public API break. Internal here excludes independent
raw HTTP consumption, not working published UI functionality. The inventory
is an input to the public-export audit (#534), not a substitute for it.

The published `health()` helper resolves to `{ status: string; uptime: number;
timestamp: string }`. Its former `version: string` declaration is removed by
the approved breaking correction in #693; the public route never supplied
version. Migrate former version reads to authenticated `status()` when
software identity is needed. `health()` does not fabricate a value or fetch
protected status automatically.

`brainSync()` retains `{ success: boolean; message: string }` by consuming the
actual SSE response through its configured request transport and current base
getter. Only a complete valid terminal `done` resolves, mapping `success` and
`text`; terminal false is a completed unsuccessful result. The parser handles
UTF-8 byte boundaries, LF/CRLF/CR lines, multiline data and keepalive comments.
Missing/malformed terminal data, premature EOF and transport failure reject as
incomplete, without establishing job cancellation. Non-2xx responses preserve
`ApiRequestError`; the helper never implicitly retries the POST or resumes the
stream. Server admission/reservation/draining semantics below still apply.

## Common request and response rules

Use the method shown. Paths are origin-relative. Protected rows use the app's
configured auth mode:

- `password`: a signed `brain_ui_session` cookie naming a live, unexpired,
  unrevoked owner or delegated agent principal; missing/invalid credentials
  yield 401 `{ error: "Authentication required", authRequired: true }`.
- `proxy`: a validated upstream identity header, configured and trusted by the
  operator; missing identity yields the same 401. Do not treat a caller's
  self-declared header as proof outside that trusted boundary.
- `tailscale`: the configured trusted client-IP policy; denial is 403
  `{ error: "VPN access required" }`.
- `none`: an ambient principal with no credential requirement, for an app
  deliberately configured without application authentication.

These modes share the protected route set. Ordinary protected reads and writes
are not owner-only or per-principal content partitions unless explicitly stated
below. An agent credential therefore has access to the authenticated corpus and
execution APIs; it is not a read-only credential. Passkey and delegated-principal
management additionally require an owner in password mode: other modes return
400, an authenticated non-owner returns 403 `{ error: "Owner access required" }`.

Origin policy precedes authentication for every **non-GET /api/** request.
It accepts same-origin fetch metadata, matching Origin or a configured
allowlist; opaque `Origin: null` is rejected. Headerless non-browser requests
are accepted by origin policy and still require authentication. Proxy trust
controls external-origin resolution. WebAuthn's ceremony allowlist is confined
to `/api/auth/passkey/`; it does not authorize other API writes. Rejection is
403 `{ error: "cross_origin_rejected" }`. `/share-target` is deliberately
outside this policy; `/ws` has its own admission checks.

A row marked **JSON** requires `Content-Type: application/json`, with standard
parameters permitted; other media types yield 415
`{ error: "unsupported_media_type" }`. Rows marked **body ignored** do not
parse or validate a supplied body. Parsed JSON is limited to 262,144 bytes,
except rendering's 5,000,000-byte limit; declared or streamed excess yields
413 `{ error: "Request body too large" }`. Index recovery requires the media
type but does not read a JSON body. No universal validation layer exists:
route-specific checks below are what currently run. Unspecified query keys
and extra object fields are generally ignored, not rejected.

Unless specified otherwise, successful JSON responses are 200 and use the
object/type described below. Timestamps are milliseconds since epoch except
explicit ISO strings. Route-local failures generally return `{ error: string }`;
wording from a subprocess/provider is diagnostic and not a machine error enum.
Uncaught failures, including some malformed JSON values, can return Hono's
500 plain text `Internal Server Error`; clients cannot assume every error is
JSON. The validation gaps below are observations, not an invitation to depend
on accepting malformed inputs. No `Retry-After` guarantee is made.

Ordinary HTTP replies carry `X-Frame-Options: DENY` and a CSP with
`frame-ancestors 'none'`; route-specific CSP is retained. Genuine WebSocket
upgrade attempts bypass those response-header writes. CORS is opt-in and
credentials are allowed only for configured origins. Caching is specified on raw content, rendering and geometry below; no
universal Cache-Control header is promised.

## Liveness and operational status

**GET /api/health** is public, accepts no inputs, and performs a real read of
the app's SQLite schema. Healthy: 200
`{ status: "healthy", uptime: number, timestamp: string }`, where uptime is
milliseconds since the route module initialized and timestamp is ISO UTC.
A failed secondary backend returns 200 with `status: "degraded"` and
`reasons: ["backend_unavailable"]`, retaining uptime and timestamp. Error text
and backend identities remain behind authentication on `/api/status`.
An unreadable database yields 503 `{ status: "unhealthy" }`, without detail.
It never exposes release, source commit, runtime, credentials or session state;
healthy does not certify upstream model or brain CLI availability.

**GET /api/status** is protected, accepts no inputs, and returns
`{ healthy: boolean, uptime, version, software, cronJobs, activeSession, metrics,
runtime?, subscription?, backendAvailability?, nativeRecovery? }`. `version` is the configured source commit (default
`"dev"`), not a release; `software` is `{ release, sourceCommit }`. `cronJobs`
contains `{ name, lastRunAt, lastStatus, lastDurationMs, lastError }`, nullable
when a job has not run; it includes recorded jobs and configured in-process
jobs. `activeSession` means any active turn, not simply an open socket.
`metrics` is the recorded metric-series snapshot, or `[]` without a reader;
series have name, kind (counter/updowncounter/histogram/gauge), numeric
value and scalar attributes; histogram value is the observation count.
Operational reads can fail with the common 500.

`backendAvailability` contains `unavailable` (this boot's excluded backends) and
`lastFailures` (the latest persisted failure per backend, retained after repair).
Each record has `backendId`, `phase: "resolution" | "runtime"`, `errorClass`,
`message`, `site` (the failed boot check) and ISO `at`. `healthy` is false while `unavailable` is nonempty.
The default backend must pass boot validation; unavailable secondary backends
are never constructed or routed to. Correct the package/runtime or host
configuration and start again to revalidate. Prior records alone do not imply
current degradation.

`nativeRecovery`, when present, reports native intent quarantine at server boot:
`{ quarantinedIntents, stagingChargedBytes, diagnosticsPath }`. A null charge
means its bound could not be established; it never means zero, and `healthy` is
false while that recovery restriction remains. A numeric zero means no stage
storage can belong to the quarantined identities. The diagnostics
path is host-private and appears only behind authentication, never on `/health`.
Healthy identities remain usable within provably available staging capacity.

`runtime.workerHost` is whether this host can run agent workers (#1632):
`{ ordinary?, restricted? }`, each `{ available, checkedAt, trigger }` plus
`requirement` when unavailable. `checkedAt` is ISO UTC; `trigger` is `"boot"`,
`"turn"` or `"check"`, naming what ran the latest real probe. Boot probes
`ordinary`, and `restricted` only while autonomous work is enabled; every turn
re-records the mode it probed. It never admits or refuses a turn: each turn
runs its own probe. **POST /api/status/worker-host** is protected, accepts no
body, re-runs the boot's probes and returns the same `workerHost` object
([contract](integration-contract/http.md#worker-host-status-additive-1632)).
While the server runs as uid 0, `workerHost` also carries
`rootServer: { warning }` (#1638): the boot log's warning that its workers can
read root-owned files and connect to root-owned and abstract Unix sockets.
The server is not refused for it
([contract](integration-contract/http.md#root-server-warning-additive-1638)).
`workerHost.limits` (#1660) lists the resource limits every worker runs
under: `enforced` entries `{ limit, source, value }` and `absent` entries
`{ limit, source, reason }`
([contract](integration-contract/http.md#worker-resource-limits-additive-1660)).
`workerHost.governed.egress` (#1665) is `{ active, detail }`: whether governed
and strict turns run on their own turn egress proxy, which needs managed native
storage ([contract](integration-contract/http.md#governed-profile-status-additive-0420-1649)).
`workerHost.governed` (#1648) says whether the `governed` profile can run and
where the server evaluates the brain's own code: `{ available, hostExecution }`,
with `reason` (`server_cwd_in_brain`, `database_in_brain`, `private_state_in_brain` or
`worker_host_unavailable`) and `detail` when unavailable. `hostExecution` is
`"worker"` while the brain's config, the `brain` CLI and git run only in
maintenance workers, and `"host"` where no governed turn can have changed the
brain. Boot records it and every check re-records it
([contract](integration-contract/http.md#governed-availability-additive-1648)).

`runtime` reports observed chat runtime and optional sync state, using the
[runtime identity declarations](../packages/ui-server/src/activity/runtime-status.ts)
and the [sync reporting contract](integration-contract/wire.md#activity-stream-rev-3-additive).
`subscription` contains `tokenSet`, nullable ISO `mintedAt`, `expiresAt`,
`lastProvenAt`, `provenBy: "turn" | "model_discovery" | null` and nullable
`lastAuthFailure` (`errorClass`, ISO `at`, `action`, `source`, optional
`runId`, `message`, `status`). An invalid configured mint date leaves
`mintedAt` and `expiresAt` null and adds `expiryWarning` with
`reason: "invalid_mint_date"`, `message` starting "expiry unknown: invalid mint date",
`errorClass` and ISO `at`. It warns at boot and retains the last cause in the
operational settings store; it never refuses serving or changes authentication.
It never returns the token. Optional monitoring
fields reflect injected capabilities; they are not a liveness requirement.

## Login, passkeys and delegated credentials

These auth routes are supported for independent clients as well as the login
UI. Public ceremonies precede the general guard; management does not.

**POST /api/auth/login — public, JSON.** Body `{ password: string }`; missing,
empty or non-string passwords become invalid credentials. Password mode only:
other modes return 400; a passkey for the current RP disables password login
unless recovery is configured, returning 403. Malformed JSON returns 400,
invalid credentials 401, rate/capacity limits 429, and principal capacity 503.
Malformed JSON and non-object JSON (null, arrays or scalars) return 400
`{ error: "Invalid request body" }`; object password defaults remain unchanged.
The limiter currently counts five failed passwords per IP and 100 globally
per minute, with bounded concurrent verification. Success returns `{ ok: true }`
and a Secure, HttpOnly, SameSite=Strict signed session cookie at `/`, with a
30-day owner principal. Verification failure does not reveal hash validity.
The cookie is an opaque capability; no token-format parsing is supported.

**POST /api/auth/logout — body ignored.** In password mode this public-before-
guard handler requires a valid cookie itself (401 otherwise). An owner's
logout revokes all cookie-bearing owner and agent sessions; an agent's logout
revokes only that agent. Live connections and queued work are invalidated.
In other modes it clears the cookie without credential revocation. All successful
calls return `{ ok: true }` and delete the session cookie. It does not sign a
caller out of the upstream proxy or VPN.

**GET /api/auth/methods — public.** No inputs; returns
`{ password: boolean, passkey: boolean }`, with `Cache-Control: no-store`.
Both are false outside password mode. In password mode the current RP's
credential presence and password-recovery setting decide the flags.

Passkey ceremonies require an allowed **Origin** even for a non-browser
client. RP ID comes from the configured override or Origin hostname; ceremony
origin must match the app, general/scoped allowlist or explicit loopback opt-in.
Disallowed/missing ceremony origin returns 400 `{ error: "Origin not allowed" }`.
All passkey operations return 400 `{ error: "Passkey login is not enabled" }`
outside password mode, after the common guard on management requests.
Challenges are single-use and expire after two minutes; retry requires new
options. The bounded, process-local challenge store can evict old challenges.

| Supported operation | Auth/body and inputs | Success | Additional errors and behavior |
| --- | --- | --- | --- |
| POST `/api/auth/passkey/login-options` | Public; body ignored; Origin required | WebAuthn JSON request options: challenge, RP ID, empty allowCredentials, userVerification required | 429 options-rate limit (currently 10/IP/minute); creates an authentication challenge. |
| POST `/api/auth/passkey/login-verify` | Public; JSON `AuthenticationResponseJSON` from the browser ceremony | `{ ok: true }`, with the same owner session cookie as password login | 400 malformed JSON; 401 unknown/foreign-RP credential, expired/replayed challenge or failed verification; 429 failed-verify/in-flight limit; 503 session capacity. Verifies challenge, origin, RP and credential, updates counter/last-use; a failed attempt consumes its challenge. |
| POST `/api/auth/passkey/register-options` | Password owner; body ignored; Origin required | WebAuthn JSON creation options | Discoverable credential and user verification required; no attestation; excludes existing RP credentials; ES256/RS256 algorithms. Creates a registration challenge. |
| POST `/api/auth/passkey/register-verify` | Password owner; JSON `{ response: RegistrationResponseJSON, label?: string }`; Origin required | `{ ok: true, credential: PasskeySummary \| null }` | 400 missing response, malformed/non-object JSON, expired/replayed challenge, duplicate or failed registration. Label is trimmed and sliced to 64 characters; absent/non-string becomes empty. Stores only verified credential data. |
| GET `/api/auth/passkey/list` | Password owner; no inputs | `{ credentials: PasskeySummary[] }` | All RPs, newest registration first; no credential public-key bytes. |
| PUT `/api/auth/passkey/:id` | Password owner; JSON `{ label?: string }`; credential ID in path | `{ ok: true }` | 400 malformed/non-object JSON; 404 unknown credential. Same label normalization; omitted label clears it. |
| DELETE `/api/auth/passkey/:id` | Password owner; body ignored; credential ID in path | `{ ok: true }` | 404 unknown credential. Revokes sessions derived from that credential and their delegated agents; deleting the last RP credential re-enables password login unless configured otherwise. |

`PasskeySummary` is the SDK shape `{ id, label, rpId, createdAt, lastUsedAt,
backedUp, deviceType, transports, aaguid }`; lastUsedAt, deviceType, transports and aaguid are nullable; backedUp is boolean.
Credential IDs and ceremony data are opaque WebAuthn values, not paths.

**GET /api/auth/principals — password owner.** Returns
`{ principals: [{ id, kind, auth_method, label, created_at, expires_at,
last_seen_at, is_own }] }` for live principals. `is_own` identifies the calling
principal; dates use epoch milliseconds and last_seen_at may be null.
Credential cookie values are never included.

**POST /api/auth/principals — password owner, JSON.** Body
`{ label: string, ttlDays?: number }`. Label strips control characters, trims
and slices to 64 characters; empty is 400. TTL defaults to seven days and must
be an integer 1–30; invalid JSON, a non-object body, or invalid TTL is 400.
Success returns `{ id, label, expiresAt, cookie }` and `Cache-Control: no-store`;
the cookie is the signed value for `brain_ui_session`, returned once rather
than installed as the owner's session cookie. Send it in a Cookie header.
Unusable creator is 403; exhausted principal capacity is 503. The new agent
has no owner-management privilege.

**DELETE /api/auth/principals/:id — password owner, body ignored.** Revokes
the principal and its delegation descendants, invalidates associated live
runtime state, and returns `{ ok: true }`. Unknown/already revoked target is
404. An owner can revoke their own credential; later requests then fail auth.

<a id="reference-source-grants"></a>

**Reference-source grants (additive, #2429) — password owner.** A grant is
the only authority for private reference acquisition
([decision](decisions/reference-source-grants.md)). It binds the served brain,
one live owner or agent principal, a repository prefix and a named existing
host credential or none. A configured credential never grants access by
itself.

- **GET `/api/auth/principals/:id/reference-grants`** returns `{ grants:
  [{ id, principal_id, repository_prefix, credential, created_by, created_at }] }`
  for that principal's live grants, oldest first; `created_at` is epoch
  milliseconds. An unknown, revoked, expired or non-cookie principal is 404.
- **POST `/api/auth/principals/:id/reference-grants`**, JSON body
  `{ repositoryPrefix: string, credential?: string | null }`. The prefix is an
  HTTPS URL without user info, query or fragment, a loopback `http://` URL, or an
  absolute `file:///` path; it may be a bare HTTPS origin. Empty, `.` and `..`
  segments, whitespace, control characters, backslashes and percent-encoding
  are 400. Hosted prefixes are stored lowercase-origin without a trailing slash
  or `.git`; a prefix covers itself and paths below it at a segment boundary.
  `credential` defaults to null. Otherwise it is exactly
  `BRAIN_UI_SYNC_GITHUB_TOKEN`, `BRAIN_UI_SKILLS_GITHUB_TOKEN` or
  `GITHUB_TOKEN`, and the prefix origin must be `https://github.com` or a
  loopback origin; a file prefix takes no credential. Violations are 400. Success
  is 201 with the grant object. Malformed or non-object JSON is 400; an unknown
  or unusable target principal is 404; an identical live grant is 409; 256 live
  grants is 503.
- **DELETE `/api/auth/principals/:id/reference-grants/:grantId`**, body
  ignored, revokes that principal's live grant and returns `{ ok: true }`.
  Revocation applies to the next authority check, including in-flight private
  refreshes. An unknown, already revoked or other principal's grant is 404.

Revoking or expiring the principal ends every grant it holds. Grant routes share
the principal family's password-mode and owner checks; other modes return the
same not-enabled response.

## Corpus queries, capture and sync

All are protected. HTTP query values are strings; the brain CLI supplies its
configuration defaults, taxonomy validation and degraded search behavior.
The route does not create a second independent taxonomy or ranking policy.

| Supported operation | Inputs/defaults/validation | Success | Errors and behavior |
| --- | --- | --- | --- |
| GET `/api/brain/search` | Required nonempty `q`; optional `type`, `tag`, `mode`, `limit` (Number conversion). Mode is fts/vector/hybrid when valid; default mode hybrid, limit 20; archived documents excluded. | `{ results: BrainSearchResult[], warnings: string[] }` | 400 missing q; 504 search deadline (15 seconds by default); other CLI/parsing failures 500 `{ error }`. Request abort cancels the read-only child. Result fields include path, title, type, relevance, score, snippet and comma-separated tags (null when none). Old bare-array CLI responses become results with empty warnings. |
| GET `/api/brain/briefing` | No inputs | `{ content: string }` | CLI briefing stdout, including its formatting; failed command is 500 `{ error }`. Keyless: `brain briefing` gathers facts without a model. The React Daily briefing panel reads this route; no route runs a repo-local briefing script. |
| GET `/api/brain/list` | Optional type, tag, status, relevance and Number-converted limit; limit 20 when omitted; archived excluded unless status=archived | `{ results: SearchResult[] }`, the full CLI list result | CLI/subprocess failures are 500 `{ error }`; filter strings are not HTTP enum-validated. Rows include path, title, type, status, relevance, nullable summary, updated, nullable deadline/generatedFrom, comma-separated tags (null when none), score=0 and empty snippet. No created field or tags-array conversion is added by HTTP. |
| GET `/api/brain/stats` | No inputs | Full `brain stats --json` object | No HTTP wrapping, filtering or formatting; CLI failure 500 `{ error }`. The integration contract owns the complete corpus shape, including unknown values. |
| GET `/api/brain/stats/history` | No inputs (no HTTP since filter) | Full `brain stats --history --json` object | Preserve [stats-history behavior](integration-contract/http.md#corpus-stats-history-get-apibrainstatshistory-additive-in-0400), including 500 with an older CLI; older servers can lack the route. |
| POST `/api/brain/add` | JSON `{ content: string, type?: string, title?: string, tags?: string[] }`; nonempty string content and declared optional field types are checked before CLI dispatch; CLI supplies default type/title/taxonomy rules | `{ success: true, action: "created" \| "appended", path, title, type, indexed: boolean, indexError?: string }` | 400 missing/empty content; common body limit/media type; CLI/save/outcome parsing failures 500 `{ error }`. Malformed/non-object JSON or invalid field types return JSON 400 before CLI dispatch or content writes. Capture may succeed with indexed:false: retry index, never resubmit content automatically. |
| POST `/api/brain/index` | JSON media type required; body ignored | `{ success: true }` | Concurrent retries coalesce per route instance. Failed index is 500 `{ error }`; no captured content is written again. |

The approved nullable declaration correction (#702) preserves these HTTP
values. TypeScript clients must handle `SearchResult.tags: string | null`;
`result.tags ?? ""` is a local display fallback. The server list mirror now
matches the CLI fields above. See [the declaration migration](integration-contract/cli.md#stable---json-shapes)
and [reranker/provider migration](extending/rerankers.md#nullable-tags-migration).

Search/list payloads are the actual CLI JSON results, not the server's narrower
TypeScript mirrors. Optional/additive CLI fields are retained. Type/tag/status/
relevance filters are passed through as strings; there is no HTTP taxonomy enum
validator. Search has no HTTP include-archived switch. Capture defaults come
from CLI ingestion: explicit type/title/nonempty tags override classification;
otherwise taxonomy hints/append matches choose the type (fallback inbox type),
matched title or first content line chooses the title, and content-derived tags
are used. See [ingestion](../packages/core/src/lib/ingestion.ts).

Empty, zero or NaN search/list limits are not forwarded by the CLI wrapper;
other Number-converted values are forwarded for CLI interpretation. These are
current pass-through rules, not an HTTP promise to accept arbitrary strings
or out-of-range limits as valid numbers.

**POST /api/brain/sync — protected, body ignored.** A successful admission is
200 `text/event-stream`. SSE `data` records contain JSON:
`{ type: "start" | "progress" | "done", text?: string, success?: boolean }`.
Progress is line-oriented human CLI output; a `done` frame contains success
and a human message. It is not the CLI JSON sync result and is not a single
JSON HTTP response. Keepalive comments may occur every 15 seconds; parsers
must ignore SSE comments. A terminal failure after admission stays HTTP 200
with `type: "done", success: false`; transport termination without done is
an incomplete result, not success.

One HTTP sync per canonical brain root is admitted across app instances;
concurrent attempts get 409 `{ error }` before SSE starts. The route invokes
`brain sync --human`. Disconnecting the reader stops delivery but **does not
cancel sync or release its reservation**; output continues draining until the
child exits. Successful sync attempts voice keyterm rebuild; a rebuild failure
is progress text and does not turn successful sync into failure. A degraded
rebuild (no usable core peer, or an index core cannot read) is reported as
progress text and not cached. A canonical
root-resolution failure before admission can use the common 500. No idempotency
key or SSE resumption promise exists.

## Sessions and execution records

All are protected; access is to the shared server record, not solely the
calling principal's runs or sessions.

**GET /api/sessions.** Optional `includeRetainedConversations=true` adds principal-owned host-only conversation metadata in `retainedConversations` (`id`, `created_at`), without fabricating backend sessions or tasks. At most 200 metadata rows are returned; `retainedAfter` is the exclusive ID cursor for the next page. Omit it for the first page. Dialogue itself uses the separately negotiated bounded WebSocket history protocol. Returns `{ sessions: ChatSession[],
unavailableBackends?: string[] }`, newest lastActiveAt first. Each session has
id, nullable title, createdAt, lastActiveAt, totalCostUsd, numTurns and
backendId. Stored nonzero accounting supplements a backend's zero figures.
A handoff destination on any backend (additive, #61, #1621) also carries
`handoffFrom: { sessionId, title, backendId?, afterTurns? }`, as the
[integration contract](integration-contract/wire.md#cross-backend-handoff-additive-61)
describes. A session the host has labelled (additive, #1004) carries
`label`, a few words about its latest request, as the
[integration contract](integration-contract/wire.md#pill-labels-additive-1004)
describes.
Each backend list has a three-second wait; unfinished work is reused by retries
and is not canceled. One unavailable backend is omitted and identified in the
optional list without discarding healthy backends; registry-level failure is
500 `{ error }`.

**GET /api/sessions/:id.** ID is opaque; no body/query inputs. Returns
`{ id, messages: SessionHistoryMessage[] }` using the stored owning backend.
Message shapes follow the SDK/wire history contract. An unknown/unavailable
backend or history failure is 500 `{ error }`; the route does not translate
missing sessions into a universal 404 or provide a separate history deadline.
A chat deleted under [explicit chat deletion](#explicit-chat-deletion-additive-3230)
(additive, #3230) is the one exception: before or after its history is read it
answers 404 `{ error: "SESSION_NOT_FOUND", message }` with no messages, and it
is absent from `GET /api/sessions`, including `retainedConversations`.

<a id="retained-turn-journal"></a>

**Retained turn journal.** All three routes use the existing authenticated
owner/session boundary. GET `/api/sessions/:sessionId/turns/:turnId/journal`
returns `TurnJournalDetails`: summary, ordered observations, overlapping turn
IDs and missing-detail reasons. No retained turn in that session is JSON 404.
An expired summary is still readable, with no raw detail or review actions.

Journal details additionally expose outward admission receipts (#1664) through
optional `outwardActions` and `outwardActionsTruncated`. Rows include event
id/time, tool, action, nullable target, decision, history-rewrite status and
`revertible: false`. They record approval/refusal, never external completion.
The response bounds this list to 1,000 records and explicitly reports more;
the retained governance query remains available. Ownership remains the same
session/turn boundary.

GET `/api/journal/configuration-coverage` is brain-wide, not per session: it
returns the brain's current untraced configuration-input set (#3257), the one
the latest complete turn recorded from a configuration inventory, or
`{ state: "unknown" }` when none has. The
[integration contract](integration-contract/http.md#brain-wide-configuration-coverage-additive-3257)
specifies the shape.

GET the same session path plus `/:sequence/preview` accepts a positive safe integer
observation sequence. Missing/expired observations are 404; invalid sequences
are 400. Successful preview is `{ inline:true, before, after }`, decoding raw
UTF-8 only. Combined before/after bytes above 256 KiB, combined lines above
5,000, binary data or unavailable bytes return `{ inline:false, reason }`.
Size fallback also supplies before/after byte sizes. It never reads more than
the inline byte allowance to build a preview. A metadata-only index version has no
retained bytes: its preview is `{ inline:false, reason:"metadata_only" }` and
its raw download is 404.

GET the same path plus `/:sequence/:side`, with `side` exactly `before` or
`after`, returns retained raw bytes as an octet-stream attachment with private
no-store caching and nosniff. Invalid sequence/side is 400, missing/expired
detail 404, and temporarily unavailable storage 503. A durable read lease
keeps the object charged and retained until completion/cancellation. Paths and
hashes from a caller are never opened. Both preview and download require the
same session/turn membership as the summary.

**User history restoration (#1653).** The four `/revert` operations above
require an authenticated human (`owner` or ambient human principal), never an
agent/system principal. Original voice or unavailable/expired turns cannot be
selected. The plan folds a path's first observed before-state and last observed
after-state; ignored, incomplete, unsupported and Git-metadata paths are named
as excluded, and the metadata-only index family as `metadata_only`, which alone
does not make the operation partial
([#2873](integration-contract/http.md#metadata-only-index-history-breaking-2873)). `action=restore` selects retained observed versions of quarantined
paths, without exposing host-private quarantine paths or moving Git refs.

POST accepts `{ id, path?, action? }`. `id` is an opaque 16–96 character ASCII
letter/digit/underscore/hyphen operation identity; `path` selects one observed
path, absent means whole turn; `action` is `revert` (default) or `restore`.
Unknown fields or malformed input are 400. The ID is bound to current principal,
session, source turn and selection; reuse with exactly the same request returns
the original receipt and never repeats the effect. Mismatched identity,
unavailable source or no eligible paths are 409. Storage failure is 503; an
unconfirmed response must be reconciled by the original receipt before any
further effect is considered. GET latest returns `{ receipt: TurnRevertReceipt
| null }`; GET identity returns that receipt or 404. All are private/no-store.

A 202 receipt records `waiting`, `applying`, `complete`, `partial`, `failed` or
`unknown`, the original/source and synthetic journal turn IDs, and named per-path
states. `undoAvailable` is false when its own retained operation journal cannot
provide an eligible Undo, including expiry. Revert waits for running turns, holding new turns behind its queue
intent while allowing an old turn's nested shared maintenance. It takes the
exclusive writer gate and `BRAIN_LOCK_KEY`/`GIT_LOCK_KEY`, then compares existence,
type, permissions and raw bytes immediately before descriptor-rooted restoration.
Changed paths conflict while other eligible paths proceed. Regular CAS versions
are verified and leased before streamed restoration; symlinks are restored
literally. No text normalization, Git command or outward-effect rollback occurs.
A failed write can leave partial work; it is observed and never reported as an
atomic all-path restore. The user operation is journaled with `actor=user`,
`kind=revert`, and `sourceTurnId`; Undo selects that journal through the same
comparison. Interrupted applying operations are unknown and are never resumed
or retried automatically. Incremental index refresh is queued after releasing
the gate. Missing or changed parents conflict; unsupported entries are excluded; unobserved
empty directory metadata is not invented.

| Supported operation | Inputs/defaults | Success and observable behavior | Errors |
| --- | --- | --- | --- |
| GET `/api/activity/runs` | Optional origin/job/session/status strings; `activityCompute=1` declares the client parses `compute`-origin runs, which are omitted otherwise (#3108); limit defaults 50, Number-converted and clamped 1–200 (zero/NaN → 50); before Number-converted, default now+1 (zero/NaN → default) | `{ live: ActivityRunSummary[], history: ActivityRunSummary[] }`. Live open roots match origin/job/session, are not limited/paginated or filtered by before/status. History is newest-first rollups strictly before before, with all filters and limit; live IDs excluded. SDK summary preserves unknown/null accounting. | Read failures 500 `{ error }`; filters are not enum-validated by the route. |
| GET `/api/activity/runs/:runId` | Run ID; `include=payloads` opts into tool_input/tool_output events; a `compute:` run needs `activityCompute=1` and is an unknown run without it (#3108) | `ActivityRunDetail`: retained `{ runId, detailPruned:false, spans, events, highWaterSeq, rollup? }`; after pruning `{ runId, detailPruned:true, rollup }`. Same wire mappers and accounting semantics as activity WS frames. | Never-existed run 404 `{ error: "Unknown run" }`; read failures 500 `{ error }`. Pruned detail is a successful resolution, not a missing run. |
| GET `/api/activity/rollups` | days: truncate Number, zero/NaN/absent → 7, clamp 1–90 | `ActivityRollups`: `{ timeZone, days, jobs, sessions }`, aggregates over runs started at/after now−days. Days newest-first, in configured timezone (default UTC); invalid timezone grouping degrades to UTC. Root-only sums; unknown list cost is a floor, unknown effective cost is counted by unpricedRuns. | Read failures 500 `{ error }`. No upper bound is applied by this older aggregate route. Both cost axes round each completed group sum to four decimals at the response boundary; stored costs retain their original precision. |
| GET `/api/activity/stats` | days: truncate Number, zero/NaN/absent → 30, clamp 1–90 | Full `ActivityRuntimeStats`, specified in the [runtime-stats contract](integration-contract/http.md#runtime-stats-get-apiactivitystats-additive-in-0370). Closed window, labeled coverage, raw sums, independent unpriced counters and nullable incomplete averages. | Read/computation failures 500 `{ error }`. Does not read brain.db. |

For fractional/negative finite values these rules produce whole-day windows;
query conversion does not produce a validation 400. Aggregate arrays and
optional/null wire fields follow the SDK declarations. The more detailed
runtime-stats and cost-tracking contract continues to govern those payloads.

## Content and confirmed shares

**GET /api/files/content — protected.** Required nonempty repo-relative `path`;
`raw=1` requests bytes, every other raw value requests JSON. No body. Paths
cannot be absolute, contain `..`, NUL or Windows path syntax, or escape the
canonical brain root via symlinks. Directory browse exclusions are not a second
access-control layer on this read endpoint. Files larger than 10,485,760 bytes
are refused.

Default response is `FileContentResponse`:
`{ path, kind: "markdown" | "html" | "text" | "binary", size, mtime, mime,
content?: string }`; binary metadata omits content. Raw mode returns bytes
with MIME by type/extension, Content-Length, inline disposition, nosniff,
Accept-Ranges: bytes, restrictive CSP and
`Cache-Control: private, max-age=0, must-revalidate`.

A valid single Range on raw GET returns 206 with Content-Range and exact
Content-Length; unsatisfiable range returns 416 with `bytes */size`. Malformed
or multiple ranges are ignored (200), as are Range with If-Range and HEAD.
Suffix/open-ended ranges are supported. A changing file is remeasured once;
a partial still-changing response can report an unknown total `*`.
Missing path is 400 `missing_path`, unsafe path 400 `invalid_path`, missing file
404 `not_found`, excess size 413 `{ error:"file_too_large", size }`, other
failures 500 `internal_error`. Error names are JSON `error` strings.

**POST /share-target — public, body ignored, outside /api.** Always 303 to
`/?share_error=no_worker`; no payload is read or saved. This is the network
fallback when the SDK service worker did not intercept a share navigation.
It must precede authentication: a cross-site POST does not carry the Strict
session cookie. Successful SDK interception instead stashes locally and
redirects with `?share=<id>` (or `share_error`); that is the SDK's local flow,
not a server upload. Loading the app makes the next worker interception possible.

**POST /api/share — protected.** Multipart fields `title`, `text`, `url` are
optional nonempty strings; binary files must be repeated in `files`. Empty
files are ignored. Normalized payload must contain text, URL or a file. Only
http/https URLs become the normalized URL; unusable URL text is retained as
text, not fetched. The app must show untrusted stashed input and obtain user
confirmation before uploading it for ingestion. Intake stages bytes and creates one untrusted thread and ready triage item; it does
not authorize the agent to execute a share's instructions.

Limits: 10 files, 25,000,000 bytes/file, 50,000,000 total file bytes and
200,000 UTF-8 bytes per normalized text field; at most 50 staged shares and
three simultaneous intakes per route instance. The body reader allows total
file cap plus 1,000,000 bytes for multipart framing, counting streamed bytes
before parsing rather than trusting Content-Length.

Success: 201 `ShareIntakeResult` (`id`, repo-relative `dir`, `receivedAt`,
optional title/text/url, `files: [{ name, path, mediaType, bytes }]`, optional
`skipped: string[]`). Paths and ID are server-minted; names are sanitized and
conflicts deduplicated. Data is staged under `.brain-ui/inbox` and the result
omits the manifest's source field. Individual unwritable files are reported as
skipped instead of discarding other staged data. Oversized bodies/fields/files
or full inbox yield 413 `{ error, limit }` with `share_too_large`,
`text_too_large`, `file_too_large`, `too_many_files` or `inbox_full`; malformed
form 400 `invalid_form`, empty payload 400 `empty_share`, concurrent capacity
503 `busy`, other staging failures 500 `share_failed`. The common origin
rejection remains 403. Trust/profile/source/principal and capability overrides are rejected as
`invalid_form`, including case and underscore/hyphen spelling variants.
Unrecognized application metadata retains the existing ignored-field behavior.
Identical normalized fields and file names/media types/actual bytes replay the
original staging result and update `lastSeenAt`, with one thread/item/staging
area. Changed content is a new arrival; share and CLI dedup namespaces are separate.
Committed Queue staging is protected from legacy seven-day housekeeping;
ordinary standalone staging keeps that TTL. The item retains its declared
expiry. This endpoint starts no model run and provides no execution grant.

## Push subscription lifecycle

All are protected and return JSON. Stored subscriptions belong to the resolved
principal, not just to anyone who can present their endpoint. No API returns
VAPID private key or stored delivery key material.

| Supported operation | Inputs/validation | Success | Errors and behavior |
| --- | --- | --- | --- |
| GET `/api/push/public-key` | None | `{ publicKey: string }`, application-server public key | Sender failure 500 `{ error }`. |
| GET `/api/push/subscriptions` | None | `{ subscriptions: [{ label, createdAt, lastUsedAt, endpointHash, timeZone }] }` for caller only; label/lastUsedAt/timeZone nullable | Endpoint hash is first 16 hex characters of SHA-256; never endpoint or keys. `timeZone` (additive, #683) is the device's last usable reported IANA zone; null means its Action notices wait for a zone report. Store failure 500 `{ error }`. |
| POST `/api/push/subscribe` | JSON `{ subscription: { endpoint: URL string (max 2048), keys: { p256dh: string (1–512), auth: string (1–512) } }, label?: string (max 120), timeZone?: string (max 256) }` | `{ ok: true }` | Invalid JSON/schema/store error 400 `{ error }`; unusable principal 401 `{ error:"Authentication required" }`. Upserts the caller's subscription; resubmitting the same endpoint updates keys/label and binds it to the current caller. Additive `timeZone` (#683) records the device's notification zone; a value the server's zone database rejects is stored as missing rather than refused, and omitting it keeps the device's last reported zone. |
| POST `/api/push/unsubscribe` | JSON `{ endpoint: URL string (max 2048) }` | `{ removed: boolean }` | Invalid JSON/schema/store error 400 `{ error }`. Removing an unknown or another principal's endpoint returns removed:false. |

These routes preserve the default SDK worker renewal request; custom shells
may override subscribeUrl only with an endpoint implementing the same request
semantics. A revoked/logged-out worker may fail renewal and retry when the app
opens; the service worker does not acquire fresh authentication itself.

## Rendering

**POST /api/render — protected, JSON.** Body `RenderRequest`:
`{ content: string (nonempty), contentType: "markdown" | "html",
format: "png" | "pdf", title?: string (max 200) }`. No defaults for the three
required fields; title defaults to `"share"` for the download name. Limit is
5,000,000 raw request bytes, including inlined media. No renderer: 501
`{ error:"render_unavailable", detail }` before body parsing (after media-type
check). Invalid JSON or schema: 400 `{ error:"invalid_request", detail }`;
common excess body: 413. Renderer failure: 500
`{ error:"render_failed", detail }`.

Success is bytes, 200 `image/png` or `application/pdf`, Content-Length,
`Cache-Control: private, max-age=0, must-revalidate` and inline filename. The
filename replaces characters outside letters/digits/underscore/dot/hyphen
with underscore, takes at most 60 characters and appends the format extension.
Content uses the shared document-template behavior; rendering capabilities
are injected by the host and are not evidence of a new renderer extension seam.

## Models and speech

Model operations are protected. Roster IDs and discovered membership can evolve;
clients use IDs as opaque selections and the declared metadata for presentation.

**GET /api/providers.** No inputs. Returns
`{ providers: ProviderInfo[], backends: Record<string, { id, capabilities, stateRoomAllowance?: { bytes, observedAt } }>, unavailable?: UnavailableProfileInfo[] }`.
The optional allowance is current host metadata in bytes with a Unix-millisecond
observation time. It invalidates older saved-state ratios when the allowance
changes; it is not measured session usage. See
[measured conversation state room](integration-contract/wire.md#measured-conversation-state-room-additive-1679).
Visible profiles only; hidden profiles still resolve for pinned sessions.
`providers` lists only profiles that can run now. `unavailable` (additive,
#1044) lists visible profiles a backend is configured with but cannot run, each
`{ id, label, reason, backendId }` with `reason` from the closed
`ProfileUnavailableReason` enum (`needs-credentials`, `unsupported-configuration`); it is absent when there
are none, and its ids are never valid `providerId`s. Clients own the reason's
copy and show an unknown reason generically.
Each backend record contains id and declared capabilities. ProviderInfo has id/label,
optional vendor/backendId/contextWindow/thinkingLevel/source/billingMode/
pricingRoute, with SDK meanings. Cached discovery is refreshed when stale;
only a cold source blocks on discovery. Uncaught source/registry failures use
the common 500, not an invented success-with-empty fallback.

**GET /api/models.** No inputs. Returns `ModelCatalogResponse` with
`models: ModelCatalogEntry[]` (ProviderInfo plus hidden and optional billing/
thinking override), nullable `refreshedAt`, boolean `stale`,
`discovery: { enabled, error? }`, and current default/custom-model metadata
(`defaultModelId`, optional resolvedDefaultId, customModels). Includes hidden
profiles. Same freshness semantics and common 500 failure boundary.

**PUT /api/models/hidden — JSON.** Body `{ hidden: string[] }`, a full
replacement, not a delta. Only array/string shape is validated; empty clears
visibility overrides and unknown string IDs are retained. Invalid JSON/body
is 400 `{ error }`; common limit/media errors apply. Persists the set,
invalidates profile memo and returns the new ModelCatalogResponse; subsequent
visible picker reads reflect the change. Other database/registry failures can
use common 500. Pinned-session profile resolution remains possible.

**POST /api/models/refresh — body ignored.** No inputs. Absent discovery source
returns 409 `{ error }`. Otherwise forces refresh, invalidates profile memo
and returns ModelCatalogResponse. Refresh failure serves the previous roster
and its discovery failure metadata; it does not erase models or turn that
refresh failure into a 500. Other registry/catalog failures can use common 500.

Speech operations are protected, with body ignored for POST. They support
SDK speech-session payloads rather than exposing long-lived provider keys:

| Supported operation | Inputs/defaults | Success | Errors and behavior |
| --- | --- | --- | --- |
| POST `/api/voice/session` | Optional JSON `VoiceSessionRequest` `{ providerId?, smart? }`; absent body uses the effective provider | `VoiceSessionResponse`: providerId, connection url, optional token/params, expiresAt and capabilities (streaming, interimResults, keyterms, endpointing, derived savedAudio, optional smartTranscription) | An explicit unregistered provider gives 409 `speech_provider_unavailable` before minting; malformed/non-object JSON or wrong field types give 400 `voice_session_invalid`. No effective provider or mint/session validation failure gives 500 `{ error }`; no fallback. Gemini mint failures are always `{ error: "Gemini dictation session failed" }`, never Google's text. Keyterms are included only when supported by the provider; browser/local sessions can omit token and use empty URL/zero expiry. |
| POST `/api/voice/token` | No inputs | `{ token, expiresAt }` | Deprecated Deepgram-specific alias retained for client migration; mints directly with 60-second requested TTL, 500 `{ error }` on failure. |
| GET `/api/voice/keyterms` | `rebuild=1` forces cache rebuild; all other values read normal cache | `{ keyterms: string[], generatedAt, count }` | 500 `{ error }` on read/build failure, including a missing, corrupt, locked or unreadable index. Without a usable optional `@schlessera/brain` peer, or with an index version core cannot read, 200 with an empty vocabulary that is never cached ([optional core peer](integration-contract/package-api.md#ui-server-optional-core-peer-breaking-host-migration-697)). |
| GET `/api/voice/overrides` | No inputs | `{ overrides: [{ match, replacement }] }` | Configured pronunciation replacements; 500 `{ error }` on cache read/build failure. |

## Map geometry

**GET /api/geo/coastline — protected.** Required `bbox=w,s,e,n`, four finite
numbers with −180 ≤ west < east ≤ 180, −90 ≤ south < north ≤ 90, each span at
most five degrees. Invalid/missing bbox yields 400 `{ error:"invalid_bbox" }`.
Optional width Number-converted, default/fallback 330 when invalid or nonpositive,
bucketed upwards to 330/660/1320; optional detail coast/roads/streets overrides
otherwise automatic detail. Unknown detail values use automatic detail.

Success is 200 `CoastlineResult`: coastline/roads/streets as arrays of `[lon,lat]`
polylines, land rings, detail, partial, toleranceM and attribution. Every reply,
including empty geometry, includes OpenStreetMap attribution. Provider
unavailability/failure degrades to empty or partial geometry with 200 rather
than a chat-rendering failure. Complete nonempty geometry is cached indefinitely
with quantized keys; cache hits include
`Cache-Control: public, max-age=31536000, immutable`. Partial/empty results are
not stored indefinitely. This deliberate exception to private content caching
does not override the SDK's network-only `/api` service-worker rule.

## WebSocket admission

**GET /ws** supports an actual WebSocket upgrade, followed by the
[wire protocol contract](integration-contract/wire.md#revision-negotiation).
It is outside `/api`; origin checking runs first, then the same auth-mode
credential/IP policy, then connection capacity, then upgrade. Rejected origin:
403 `{ error:"Cross-origin WebSocket rejected" }`; failed auth: 401
`{ error:"Authentication required" }`; capacity: 503 plain text
`WebSocket connection limit reached`; authenticated non-upgrade: 400
`{ error:"WebSocket upgrade required" }`. A successful upgrade changes the
transport; wire negotiation, frames and close behavior are governed by that
existing contract, not by a JSON HTTP success envelope. There is no bearer-token
query parameter or new HTTP version negotiation in this inventory.

## Recorded gaps

The supported promises above are not removed to accommodate these observations:

- The [runtime coverage matrix](http-api-coverage.md) maps every supported
  operation to a real mounting check and named behavior tests (#691).
  Guard-only failures are not proof that a protected handler is mounted.
- [#693](https://github.com/schlessera/brain-kit/issues/693) aligns the public
  React health and sync helpers: health currently requires a version absent
  from the intentionally minimal public response; brainSync parses SSE as JSON.
  Correcting the supported health return type needs the maintainer ruling
  recorded there. This specification does not implement that type migration.

No route removal, consolidation or authentication redesign is authorized here.
A proposal affecting an existing supported promise needs its own ruling before
implementation. The tracker holds unfinished work; this page holds the current
boundary and the evidence needed to interpret its promises.

## Authenticated CLI intake (additive, #679)

**POST /api/queue — protected.** JSON has exactly `{ key, title?, text?, url? }`;
unknown fields are 400 `invalid_request`. `key` is 1–128 ASCII characters,
starting with a letter or digit and then letters/digits/`.`/`_`/`:`/`-`. At
least one normalized content field must survive; text normalization and limits
match share intake. The common 256 KiB JSON body cap and JSON media type guard
apply. Files are supported by `/api/share`; CLI intake takes these text fields.

Success is 201 `{ queued: true, created: boolean, threadId: string,
itemId: string, stagingId: string }`. The server derives immutable `cli` /
`trusted` provenance and the admitting principal from the authenticated endpoint.
The staging manifest records `source: "cli"`; a receipt in the operational UI
store retains principal attribution after credential pruning. A trusted origin
is no blanket execution authority. Existing password, proxy, tailscale and
explicitly configured none authentication rules apply, including delegated
principals' ordinary route access. Current authority is rechecked after awaited
input/staging and inside the committing transaction.

Replaying the key with identical normalized content returns `created: false`
and the same IDs, updates `lastSeenAt`, and creates no additional staging area.
The first arrival's provenance stays unchanged. Different content for that key
is 409 `{ error: "key_conflict" }`. Replays never revive a terminal/removed item.
Other responses: common 401/403, 400 `empty_share` / `invalid_request`, 413
`{ error, limit }` from text limits, common 413 body limit, 415
`unsupported_media_type`, and 500 `queue_failed`. Keep the same key after an
unknown delivery outcome; a committed operation followed by response loss is
safe to retry.

A server-minted staging ID is journaled before files are written. The work and
committed receipt enter the UI database in one transaction. Definite failed
writes compensate staging; failed compensation is retained for boot/next-intake
reconciliation. Abandoned preparations become cleanup after an hour, protecting
other live writers. Cleanup never removes a committed receipt's bytes. These
receipts are included in the existing audit-only operational export; they do
not turn it into a filesystem backup. The CLI never accesses UI SQLite or
`brain.db` for this operation, and intake does not file markdown or dispatch
production autonomous work before its containment/system gates.

## Scheduled tasks (additive, #914)

Seven protected routes store and inspect scheduled tasks for `brain schedule`
and other clients. None of them runs work: no dispatcher is wired, and the
stored task reports `executionAvailable: false` / `dispatch_disabled`. Request
bodies must be `application/json`, at most 64 KiB of valid UTF-8, with no NUL
and no duplicate object keys. Unknown fields or query parameters are
`invalid_request`. Every response is `Cache-Control: no-store`. Errors are
`{ ok: false, error: { code, message } }` with the closed codes and statuses of
the [schedule contract](integration-contract/package-api.md#scheduled-tasks-additive-914):
400 `invalid_request`/`invalid_cursor`, 401/403 `unauthorized`, 404
`not_found`, 409 `key_conflict`/`approval_required`/`approval_expired`/
`definition_conflict`, 503 `server_unavailable`/`unsupported_capability`.
The common authentication guard answers before these handlers with its own
401/403 body.

**POST /api/schedules/proposals** takes `{ key, definition, clientTimeZone? }`
and answers 201 `{ ok: true, proposal }` (200 for a matched replay by the same
principal and key). It validates and materializes the definition, resolves the
zone, and stores nothing authoritative. **POST
/api/schedules/proposals/:id/approve** takes `{ fingerprint, decision:
"approve" }` from an operator principal and answers 200 `{ ok: true,
approvalId }`. **POST /api/schedules** takes `{ proposalId, approvalId? }` from
the proposal's creator; it answers 201 `{ ok: true, created: true, task }` once
the ledger and the definition file agree, and 200 `created: false` when a
receipt already exists. **GET /api/schedules** accepts `limit`, `cursor`,
`state` and `id`. **POST /api/schedules/:id/cancel** takes `{ key }` and
answers 200 `{ ok: true, changed, task, runningOccurrences }`. **POST
/api/schedules/:id/reconcile** takes `{ key, decision: "reopen" }` from an
operator principal and answers 200 `{ ok: true, changed, task }`: it reopens a
task paused as `restore_pending` or `unknown_effect` once its file still
matches the approved bytes, and `changed: false` for a matched replay or a task
with nothing to reconcile. **GET
/api/schedules/due** accepts `limit` and `cursor`; it is read-only. Cursors are
host-signed, bound to the caller, filters and evaluation time, and expire after
15 minutes. Responses stay under 512 KiB.

## Session drafts (additive, #979)

Six protected routes keep each session's unsent composer draft on the host,
as [D52](decisions/design-kit/sessions-and-drafts.md#5-per-session-drafts-stored-on-the-host-storage-c)
designed. They are advertised by `server_hello.capabilities.sessionDrafts:
true`, with `server_hello.sessionDraftLimits` carrying the bounds; a client
must not claim host saving without that flag. Shapes are the SDK's `Draft*`
types in `@schlessera/brain-ui-sdk/protocol`, and the
[integration contract](integration-contract/wire.md#session-drafts-additive-979)
holds the semantics. None of them sends, starts, answers or grants anything.
Every response is `Cache-Control: no-store`. The common authentication guard
answers first; each handler then re-resolves its principal inside its write
transaction, after the body is read, and answers a revoked or expired one
with the guard's 401 `{ error: "Authentication required", authRequired: true }`.
The namespace is the host's, shared by every principal that authenticates to
it; it is not partitioned per login.

**GET /api/drafts** returns `{ drafts: DraftSummary[] }`, every live draft,
newest change first. At most `maxDrafts` exist, so one response is the
complete list. **GET /api/drafts/:draftId** returns the `Draft`, its images'
decoded bytes base64-encoded in `bytes`.

**PUT /api/drafts/:draftId** takes `If-Match: <revision>` (`0` creates),
`Idempotency-Key` and the JSON body `{ sessionId: string | null, text,
attachmentIds: string[] }`, at most 4,390,912 bytes (the composer's text and
ten snapshots' at JSON's six-byte escapes; 512 KiB before #3588), and answers 200 `{ revision,
updatedAt }` only after the commit. A save cannot change `sessionId`; that
is a conflict. An empty draft is deleted, not saved (400). **POST
/api/drafts/:draftId/attachments** takes the raw image as the body, its type
as `Content-Type` (`image/jpeg`, `image/png`, `image/webp` or `image/gif`;
otherwise 415 `{ error: "unsupported_media_type" }`), an optional `name`
query parameter and `Idempotency-Key`, and answers 200 `{ attachmentId }`.
The bytes must carry the declared type's signature. A save lists the image
to attach it; an upload no save lists is removed an hour later.
**DELETE /api/drafts/:draftId** takes `If-Match` and answers 204, leaving a
tombstone; retrying the same delete answers 204 again. **POST
/api/drafts/:draftId/bind** takes `{ sessionId, requestId }` and answers 200
`{ revision }` only when the host accepted a first message carrying this
draft and that `requestId`, and it started that session.

Failures are `{ error: <code>, message, ... }`: 400 `DRAFT_INVALID`;
404 `DRAFT_NOT_FOUND`; 409 `DRAFT_CONFLICT` with `current` (the host's
`Draft`), `DRAFT_KEY_REUSED` or `DRAFT_NOT_ACCEPTED`; 410 `DRAFT_DELETED`
with `tombstoneRevision`; 413 `DRAFT_TOO_LARGE` and 507 `DRAFT_CAPACITY`,
each with `limit` and `bound`; 428 `DRAFT_PRECONDITION_REQUIRED` when
`If-Match` is missing. Bodies are counted as they stream, whatever
`Content-Length` says. A refused or failed request leaves the committed
draft unchanged.

<a id="composer-file-attachments-additive-0450-3153"></a>

## Composer file attachments (additive, 0.45.0, #3153)

Advertised by `server_hello.capabilities.composerFiles`; the frame rules are
in the [integration contract](integration-contract/wire.md#composer-file-attachments-additive-0450-3153).
Both routes sit behind the same authentication and same-origin rules as the
draft routes, and answer `Cache-Control: no-store`. The upload creates no
inbox item, queue job or triage. `/share` and `/track-upload` are unchanged.

### `POST /api/drafts/:draftId/files`

The raw bytes of one file, streamed; nothing is buffered whole. Headers:
`Idempotency-Key` (required, 1-128 of `A-Za-z0-9._:-`), `Content-Type` (a
hint), `X-File-Name` (a hint, percent-encoded UTF-8, at most 1,024 bytes
encoded) and `Content-Length` (optional, used for early refusal and as the
pool reservation; without it the reservation is 25,000,000 bytes).

The host reserves pool room, streams the bytes to a partial directory while
counting and hashing them, detects the kind from the stored bytes and
publishes the file read-only at `.brain-ui/attachments/<fileId>/<name>` by one
atomic rename. Detection is by signature first (`%PDF-`; JPEG, PNG, GIF,
WebP; HEIC/HEIF; ZIP, gzip, 7z, RAR), then strict UTF-8 text, then the shared
track parser for text up to 20 MiB. Anything else is `binary`. A name or MIME
type is only a hint: it never makes a file a track or a PDF.
`trackRejected: true` says a track hint did not parse. Upload never claims the
contents were read.

`201` returns an `AttachmentFile`. Repeating a key with the same draft, name
hint, media hint and bytes returns `200` with the same file, without storing a
second copy.

| Status | `error` | `bound` / meaning |
| --- | --- | --- |
| 413 | `ATTACHMENT_TOO_LARGE` | `file` (25,000,000), `draftFiles` (50,000,000), `draftCount` (10) |
| 507 | `ATTACHMENT_CAPACITY` | `pool` (the configured `BRAIN_UI_ATTACHMENT_POOL_BYTES`) |
| 410 | `DRAFT_DELETED` | the draft was deleted or sent |
| 400 | `ATTACHMENT_INVALID` | an empty file, a malformed header, or an `X-` header claiming authority, a path or a kind |
| 409 | `ATTACHMENT_KEY_REUSED` | the key named a different upload |
| 503 | `busy` | three composer uploads are already running; retry |

`draftCount` and `draftFiles` count everything the draft's current revision
references, plus uploads for the same draft that no save has bound yet and
that are under an hour old. Files its outgoing snapshots own are not counted
(#3588): each snapshot is its own message, checked against the envelope when a
save lists it, and the newer composer revision keeps a whole envelope. The pool counts every recorded
original in any state, every live reservation and the legacy draft images.
Reservations are taken in one immediate transaction, so concurrent uploads
cannot multiply the cap. At capacity nothing is removed to make room.

`PUT /api/drafts/:draftId` accepts `fileIds` (at most 10) and `outgoing`
(`{ requestId, text, fileIds, state: "held" | "dispatched" }`, `null` to
clear, absent to keep). A save binds exactly the listed files to the revision
and the snapshot's files to the snapshot. Each listed file must be `stored`
and minted for this draft, or the save is 400 `ATTACHMENT_INVALID`. At most
10 attachments are listed, legacy images included, and at most 50,000,000
original bytes together (413 `DRAFT_TOO_LARGE`, `bound` `draftCount` or
`draftFiles`). The old `maxDraftBytes` ceiling bounds text and legacy images
only. `GET` returns `files` (only files still stored) and `outgoing`.

<a id="outgoing-snapshot-list-additive-0450-3588"></a>

#### Outgoing snapshot list (additive, 0.45.0, #3588)

A draft keeps a list of outgoing snapshots instead of one slot, under the
maintainer's G1 A ruling on #3155. Each `DraftSnapshot` is `{ snapshotId,
requestId, text, fileIds, state: "held" | "returned" | "dispatched", createdAt
}`: a send that is held while its files upload, returned unsent, or dispatched
and not yet confirmed. The client mints `snapshotId`; the host stamps
`createdAt` at creation. `GET` returns them as `snapshots`, oldest first, and
omits the field when there are none.

`PUT` takes the whole list as `snapshots` (each item without `createdAt`);
absent keeps it. Under the save's `If-Match` and `Idempotency-Key`:

- **Create.** A `snapshotId` the draft does not hold creates a `held` or
  `dispatched` snapshot; its `requestId` must be new to the draft. The save
  counts every live snapshot of the chat — every live draft bound to the same
  `sessionId`, whichever tab or device saved it, or this draft alone when it
  has no session — in the same immediate transaction. If the result would
  exceed `maxOutgoingSnapshots` (10, advertised in `SessionDraftLimits`), it
  is 409 `{ error: "DRAFT_OUTGOING_FULL", message, limit }` and nothing is
  stored. That save is the reservation: the client sends the message only
  after it succeeds. An ordinary send with every file ready records a
  `dispatched` snapshot the same way.
- **Edit in place.** A listed snapshot may move `held` → `returned` (Cancel,
  or a file failed), `held` → `dispatched` (dispatch) or `dispatched` →
  `returned` (a recovery read showed it was not accepted). A `held` one may
  change its `fileIds` as its uploads are admitted. Its `requestId` and `text`
  never change. These saves never need a free slot, even at 10 of 10.
- **Release.** Leaving a `returned` snapshot out deletes it: Edit, when its
  text and files move into the composer revision of the same save, or
  Delete…. Its files lose their snapshot reference, and those no longer
  referenced start their seven-day clock. A `held` or `dispatched` snapshot
  cannot be left out (400 `DRAFT_INVALID`); nothing is evicted, merged or
  overwritten. Accepting the message whose `requestId` a snapshot carries
  releases that snapshot alone, its files moving to the conversation in the
  acceptance transaction.

Every snapshot's files stay referenced, charged to the draft sub-limit and the
pool, and each snapshot is checked against the per-message envelope. When an
acceptance consumes a draft that still holds other snapshots, the draft is not
a tombstone: it stays at the next revision with an empty composer and those
snapshots. `DELETE` of a draft holding a `held` or `dispatched` snapshot is
409 `{ error: "DRAFT_OUTGOING_PENDING", message, current }`; its `returned`
snapshots go with it.

The single-slot fields of #3153 keep working. `Draft.outgoing` shows the
newest `held` or `dispatched` snapshot in the old shape. A save's `outgoing`
object creates the snapshot of its `requestId` (with that id as `snapshotId`)
or edits it in place, and `null` removes the snapshot `outgoing` shows. A save
naming both `outgoing` and `snapshots` is 400. A draft saved with a slot
before migration 079 has that slot as its first snapshot.

### `GET /api/attachments/:fileId`

Streams one original up to 25,000,000 bytes, after checking its recorded size
and SHA-256 through no link. Any live reference authorizes the read: a draft
revision, an outgoing snapshot or a sent message. Answers carry
`Content-Security-Policy: default-src 'none'`, `X-Content-Type-Options:
nosniff`, and `Content-Disposition: attachment` for every kind except an image
preview. `404 ATTACHMENT_NOT_FOUND` for an unknown, unreferenced or missing
file; `409 ATTACHMENT_CHANGED` when the bytes no longer match, with none of
them served. The raw file route keeps its 10,485,760-byte cap.

<a id="attachment-reads-additive-0450-3589"></a>

### `GET /api/sessions/:id/attachment-reads` (additive, 0.45.0, #3589)

Advertised by `server_hello.capabilities.attachmentReads`; absent on a host
without composer files, which a client reads as "show no read state". Behind
the same authentication guard as the other session routes, with the same
authority a history replay of the session has: a usable principal of this host,
whose namespace every authenticated principal shares. A revoked or expired one
gets the guard's `401 { error: "Authentication required", authRequired: true }`
and nothing about the session.

`200` returns `SessionAttachmentReadsResponse` `{ sessionId, reads }`, with
`Cache-Control: no-store`. Each `AttachmentReadEntry` is `{ fileId, turnId,
outcome, scope, at }`: one recorded `read_attachment` call that reached an
original, oldest first. `outcome` is any outcome but `refused`, whose calls
reach no original and are not recorded. `scope` is the pages or byte range
the result covered, or `null` when nothing was read. Only reads recorded by
this session's turns, of originals a message of this session still names, are
returned. A session with none, or one the host does not know, answers an empty
list. A retired chat is `404 SESSION_NOT_FOUND`. Text is never kept or
returned, and nothing here reaches a provider.

A read recorded during a live turn also reaches every connection that declared
`attachmentReads` in its `client_hello`, as one
[`attachment_read` frame](integration-contract/wire.md#attachment-reads-additive-0450-3589).

### Lifetime

An upload no save or message ever bound is removed an hour after upload. An
original that was referenced is removed seven days after its last reference
went; rebinding cancels that. A sweep runs at boot and every ten minutes. It
marks eligible files in one transaction and only then unlinks them, so a
rebind that loses the race is refused rather than binding a deleted file. At
boot, reservations and partial uploads of an earlier process are discarded, a
record whose directory is gone becomes `missing`, and a directory with no
record is adopted, charged, with a fresh seven days. Clocks are the server's
stored wall clock, never file times.

## Session recovery (additive, #964)

**GET /api/sessions/:id/recovery** is protected and read-only: it never
selects a session, starts work, answers an interaction or grants anything.
It is mounted, and `server_hello.capabilities.sessionRecovery: true` is sent,
only by a host that records accepted work; a client must not read it
without the flag, and reads a missing route as a host too old to answer.
It answers 200 with the SDK's `SessionRecovery` for a session the catalog,
the live coordinator or any backend knows; the
[integration contract](integration-contract/wire.md#session-recovery-additive-964)
holds the field semantics. Every response is `Cache-Control: no-store`. The
common authentication guard answers first; the handler re-checks the
principal after its one asynchronous step (looking the session up in the
backends when the catalog does not know it; the first backend that replays
any history settles it, and each gets three seconds) and answers a revoked or expired
one with the guard's 401 `{ error: "Authentication required", authRequired:
true }`, disclosing nothing about the session. An unknown session is 404
`{ error: "SESSION_NOT_FOUND", message }`. A storage failure, or a backend
that failed or timed out when none had the session, is 500 `{ error: "SESSION_RECOVERY_FAILED", message }`, never a successful
`unknown`.

<a id="explicit-chat-deletion-additive-3230"></a>

## Explicit chat deletion (additive, #3230)

**POST /api/chat-deletions** deletes the authenticated owner's own chat's local
history under the [approved policy](decisions/chat-history-deletion.md). It is
mounted, and `server_hello.capabilities.chatDeletion: true` is sent, only by a
host whose catalog can retire chats. The body is the SDK's `ChatDeletionRequest`:
`operationId` (a client-minted key, at most 2048 characters), `target` naming
exactly one of `{ sessionId }` or `{ historyOwnerId }`, and `expected: { backendId,
generation }`, what the caller reviewed (a dialogue page's `generation`, or 1 for a
chat with no host-retained dialogue). Any other shape is 400
`{ error: "INVALID_CHAT_DELETION", message }`. Every response is
`Cache-Control: no-store`.

Before anything is retired, a refusal is `{ error: "CHAT_DELETION_REFUSED",
reason, message }`: 403 `unauthorized` (not a usable owner principal: agents,
ambient callers without an owner mapping and revoked principals), 404
`unavailable` (absent, foreign, already retired under another key, or with no
recorded owner; the same answer whichever), 409 `stale` (the backend or
generation differs from `expected`), 409 `unsupported` (the chat's backend does
not advertise and implement native removal) or 409 `busy` (a running or starting
turn, queued follow-ups or unsettled live-conversation work; stop or finish it
first). A chat's recorded owner is its dialogue owner, its voice conversation's
principal or, since #3337 (additive), the authenticated principal whose typed
request created its backend session. A typed chat whose session already existed
before that binding (or that the host first saw on a resume) has no recorded
owner and stays `unavailable`; none is backfilled. Otherwise the chat is
retired and the answer is 200 with the SDK's
`ChatDeletionReceipt`: `operationId`, the terminal `generation`, the overall
`status`, each selected store's outcome (`native` for a backend session,
`dialogue`, `tasks`, `projections`, `drafts`) and `retained`, which always lists
`independent_content`, `effects_and_audit`, `provider_copies`, `backups` and
`offline_devices`. `status` is `removed` only when every selected store confirmed
removal; `pending`, `partial` and `unknown` say cleanup is not confirmed, and
repeating the same `operationId` retries it. A host restart also resumes it.
The handler re-checks the principal after its asynchronous steps and answers a
revoked one with the guard's 401, disclosing nothing. A storage failure before a
receipt exists is 500 `{ error: "CHAT_DELETION_FAILED", message }`, never a
reported deletion. Receipts and errors carry no chat text, title, raw path or
free-form failure. No success claims secure erasure, provider forgetting or an
undone effect, and an older backup can restore deleted text.

**GET /api/chat-deletions/:operationId** (additive, #3455) reads one operation's
outcome without re-admitting it, so a client that lost a POST's reply can ask
what happened. It only reads: it never admits a deletion, retries or resumes
cleanup, and it adds no authority. For the authenticated caller it answers 200
with the current `ChatDeletionReceipt` when a retirement is recorded under that
`operationId` for that principal; `status` and `stores` reflect the latest
recorded cleanup, so a read after a restart or a retry shows progress. Every
other case is 404 with the SDK's `ChatDeletionNotAdmitted`, `{ error:
"CHAT_DELETION_NOT_ADMITTED", reason: "not_admitted", message }`, byte-identical
whether the operation is unknown, another principal's, a refused attempt (refusals
are not recorded) or asked by a principal that cannot own one (an agent, or an
ambient caller without an owner mapping). It never echoes a title, session id,
history owner id or backend. `not_admitted` means nothing was retired under
that operation at the moment of the read: a request still in transit can be
admitted afterwards, and `chat_retired` then follows as usual. The read waits
for committed catalog writes. An `operationId` longer than 2048 characters is
400 `{ error: "INVALID_CHAT_DELETION", message }`; unauthenticated is 401; a
principal revoked between the lookup and the response gets the guard's 401, not
the receipt; a storage failure is 500 `{ error: "CHAT_DELETION_FAILED", message }`,
which reports neither outcome. Every response is `Cache-Control: no-store`. A
host without the route answers its ordinary not-found, which carries no
`reason`, so a client can tell an older host from `not_admitted`.

Draft routes refuse a draft bound to a deleted chat with 410
`{ error: "DRAFT_CHAT_RETIRED", message }`, list omits it, and `GET` answers 404.

## Imported track UI transport (#526)

The paired UI uses authenticated `POST /api/track-upload` multipart intake and
`GET /api/tracks?path=<staged reference>` to validate originals and resolve track
blocks. These are internal HTTP transports under the selection policy; published
SDK file-reference frames, `show_block` and kit props retain their ordinary
contracts. The [imported-track behavior](integration-contract/package-api.md#imported-track-files-in-chat-additive)
describes validation, limits, outcomes and static export. They do not file
knowledge-base content or narrow existing generic `/api/share` intake.

## Interactive HTML preview (additive, #1084)

`GET /api/files/html?path=…` is protected and serves an `.html`/`.htm` file
(extension matched case-insensitively, on the requested path and on the file
it resolves to) under the same path, auth and 10,485,760-byte rules as
`GET /api/files/content?raw=1`. Missing `path` is 400 `missing_path`; another
extension, or a symlink to a non-HTML file, is 400 `not_html`; path errors,
missing and oversized files answer as on the raw route. It is internal UI
transport, but its headers are a security property and are pinned by tests:

- `Content-Type: text/html; charset=utf-8`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`,
  `Cache-Control: private, max-age=0, must-revalidate`.
- `Content-Security-Policy: sandbox allow-scripts; default-src 'none';
  script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';
  img-src data: blob:; font-src data:; media-src data: blob:;
  connect-src 'none'; form-action 'none'; frame-ancestors 'self'`.
- `X-Frame-Options: SAMEORIGIN` on a successful response only. Every other
  response, including this route's errors, keeps `DENY` and
  `frame-ancestors 'none'`.

The `sandbox` directive gives the document an opaque origin whether it is
framed or opened as a top-level tab, so its script cannot read the app's DOM,
cookies or storage. `connect-src 'none'` blocks fetch, XHR, WebSocket and
beacons in the browser, in every auth mode: the missing `SameSite=Strict`
cookie is a further barrier only in `AUTH_MODE=password`. Popups, form
submission, downloads and navigation of the embedding app are not granted.

Accepted residual risks (maintainer ruling on #1084): a document may navigate
itself to any URL, carrying what it can read (its own file and anything typed
into it), and a tab shows the untrusted content under the app's host. Channels
Chrome does not let a CSP govern, such as WebRTC and DNS prefetch, can carry the
same data. The
real-Chrome test `packages/ui-react/tests/html-preview-runtime.test.ts`
asserts the isolation and both accepted behaviours. In a split topology, where
the client is served from another origin, `frame-ancestors 'self'` refuses the
preview frame; the new-tab link is not subject to framing rules.

## Untrusted file marks (internal, #2673)

The four `/api/files/untrusted` operations are protected, internal UI
transport: their payloads carry no independent-client guarantee, but their
authority and disclosure rules are security properties and are pinned by
`packages/ui-server/tests/untrusted-marks.test.ts`.

- A mark is a host record in the UI database keyed by the normalized
  brain-relative path, never a `brain.db` row or frontmatter key, so it
  survives a restart and `brain index --force`. A moved or deleted file keeps
  its old-path record; nothing follows a rename.
- `PUT` with JSON `{ path }` needs the read access `GET /api/files/content`
  already grants and a regular file at the path: a missing path or directory
  is 404 `not_found`, invalid path syntax 400 `invalid_path`. It answers
  `{ status: "marked" | "already_marked", mark }`. Marking grants nothing else.
- `DELETE ?path=` is the human owner's alone (an `owner` or `ambient`
  principal, the storage routes' rule); any other principal gets 403
  `owner_required`. It clears present and retained missing records and answers
  `{ status: "cleared" | "already_cleared" }`. It never removes a session's
  recorded taint.
- `GET ?path=` answers `{ path, marked: false, canClear }` or
  `{ path, marked: true, markedAt, missing, markedBy?, canClear }`. A reader
  asking about a path with no readable file gets 404 `not_found`, whether or
  not a record is retained there.
- `GET /list` answers `{ marks, canClear }`, missing records first and then
  newest first. The owner sees every record; any other principal sees only
  records whose file it can currently read. Only the owner's rows and details
  carry `markedBy: { label, you }`; other principals' responses omit the field.

## Selectable dictation providers

`GET /api/voice/providers` returns `VoiceProvidersResponse`: `providers[]`
contains `{ id, label, destination?, capabilities }`; `dictation` contains
`{ saved, savedUsable, host, effective, source, smart, revision }`. Ids absent
from selection are `null`, `savedUsable` is false when nothing is saved, and
`source` is `saved | host | only | none | unavailable`. Discovery is authenticated,
`no-store`, and never mints credentials or probes providers. Labels default to
ids; saved-audio support comes from the optional provider method.

The registered set is fixed at construction. The saved choice wins if registered;
if removed, it blocks dictation without fallback. With no saved choice, use the
host default, otherwise the sole registered provider, otherwise none. Multiple
providers without a default require a deliberate choice. `/voice/capabilities`
keeps its response shape and reports this effective provider.

`GET /api/voice/dictation/settings` returns `DictationSettings`
`{ defaultProvider: string | null, smart: boolean, revision: string }` and a quoted
revision `ETag`. Defaults are `{ defaultProvider: null, smart: true, revision: "0" }`.
Corrupt/invalid operational KV `voice.dictation` rows use those defaults; storage
uses a numeric revision. `PUT` accepts `{ defaultProvider, smart? }` (`smart`
defaults true); `null` clears the saved choice. Send `If-Match: "<revision>"`
(the unquoted revision is also accepted). Only human `owner`/`ambient` principals
may write; others receive 403 `{ error: "owner_required" }`. Unknown providers
return 400 `speech_provider_unknown`, invalid bodies 400 `dictation_settings_invalid`,
missing If-Match 428 `dictation_settings_stale`, and stale writes 409
`dictation_settings_stale` with `current`. A successful write returns 200 with the
new settings/revision and ETag. Reads and writes are `no-store`; neither mints a
session, changes a running take, nor touches conversation settings or history.

`POST /api/voice/session` resolves a supplied `providerId` exactly, before minting,
regardless of current defaults. It snapshots identity/capabilities for the response.
`smart` overrides the saved mode for this request; only a provider declaring
`smartTranscription` receives `mode: "smart" | "verbatim"`. Omitted mode uses the
saved switch (initially true). A failed exact mint returns generic 500
`{ error: "Voice session failed" }` without provider diagnostics or credentials.
Bodyless legacy requests retain their previous response/error shape.

## Saved-audio transcription

The protected `GET /api/voice/capabilities` returns `VoiceCapabilitiesResponse`
(`{ providerId, capabilities }`) with `savedAudio` derived from the optional
provider method. It calls neither a provider nor `createSession`. Unavailable
selection gives the existing 500 `{ error }` response. Responses are `no-store`.

`GET`, `PUT` and `DELETE /api/voice/recordings/:recordingId/transcription`
require a recording UUID and a currently usable account principal. Owner
logins and admitted ambient accounts are allowed; agents/system principals
receive 403 `owner_required`. A different proxy account receives 404
`transcription_not_found` for a known id on every method; unauthenticated
requests receive 401. Authority is rechecked after the body and after provider
completion. The account identity is the same host/root key as `/api/vpn-check`,
never a browser-supplied key or the transient login id.

`GET` returns 200 `RecordingTranscription`, or 404 when no receipt exists.
`PUT` takes raw audio with `Content-Type` (`audio/webm`, `audio/ogg`, `audio/mp4`,
optionally `codecs=opus`) and lowercase 64-digit `Content-SHA256`. The server
computes SHA-256 itself. Empty bytes or an invalid/mismatching hash produce 400;
unsupported media gives 415. A streamed or declared body above **10,041,155
bytes** gives 413 even without an honest Content-Length. This is a ten-minute
byte budget, not a duration proof. The cap is `ceil(52783 / 3.154 * 600)`:
the highest byte rate from six additional V1 `track-ended` runs (three each,
Chromium 153/Firefox 155, pinned Playwright 1.63.0, 2026-10-08). Firefox's
highest run had 52,783 bytes over 3,154 decoded milliseconds. Other browser
boundaries remain unmeasured; this receipt is not physical-device coverage.

The [saved-audio integration contract](integration-contract/package-api.md#saved-audio-transcription-additive-1021)
specifies the receipt fields, errors, retry decision and permanent retention.
`PUT` responds 200 with the stored receipt, including provider failures; a
failed plain replay gives 409. `?retry=<failed attemptId>` is the only retry
request, with at most three user retries and no automatic provider calls.
`Speech-Provider: <id>` binds upload admission to exactly the disclosed provider,
before reading the audio and before claiming a receipt. An unknown id returns
409 `speech_provider_unavailable`; a streaming-only provider returns 501
`saved_audio_unsupported`. Neither claims or dispatches. Without this header,
legacy uploads resolve the effective provider at request admission. A retry
naming a different provider returns 409 `transcription_provider_mismatch` with
its original receipt and never dispatches. Plain repeats, tombstones, unknown
outcomes and the retry ceiling retain their existing semantics.
`DELETE ?disposition=accepted|discarded` returns 200 with a `consumed` receipt;
an invalid disposition gives 400. It removes text, retains the immutable id
and hash, and inserts a hashless tombstone if no upload has claimed yet.

## Human-started hygiene review (additive, #1027)

`GET /api/hygiene/review` reads durable review state and its pending Action.
`POST /api/hygiene/review` accepts `{ operation: "start" | "pause" | "resume" | "refresh" }`.
Refresh reads the current canonical finding through read-only targeted CLI selection.
A new fingerprint atomically replaces the card and retains a `superseded` receipt
on the terminal old card. Position/counters and Markdown remain unchanged; old
preview/confirmation requests refuse. Missing/changed findings remain pending
with stale evidence, and unavailable checks remain refused. An unchanged fingerprint
returns the same card. Refresh preserves Pause and cannot re-admit a cap-retired card;
use Resume. Full [refresh semantics](integration-contract/package-api.md#human-started-hygiene-review-additive-1027)
bind independent clients.

`GET /api/hygiene/review` and the `POST` command response add
`privateDetailAccess: { itemId }` only when this caller may read the pending
card's private managed-worktree details. `GET /api/hygiene/review/details/:itemId`
returns those recorded facts to the owner principal and 403 to every other
principal; it is `no-store`, reads only recorded facts and changes nothing. See
[the owner-only details](integration-contract/package-api.md#owner-only-private-worktree-details-additive-0440-2734).

`POST /api/hygiene/review/preview` accepts a stored `itemId`, `optionId`,
`expectedVersion`, bounded handler `input` and an optional `requestId`, which
the response echoes. A media preview runs one scan per server: the same
principal's newer preview aborts the older one, and another principal's gets
the `preview-busy` refusal in a 200 body. Owner/ambient operation authority
is rechecked against the durable principal. These routes run only deterministic
CLI operations; confirmation uses the existing `inbox_resolve` WebSocket path.
See [the wire shapes and error codes](integration-contract/package-api.md#human-started-hygiene-review-additive-1027).

## Local roadblock report (internal, #1672)

**GET /api/governance/roadblocks** is authenticated, read-only and `no-store`.
Every authenticated principal has the same read access as session history.
Its optional `hoursBack`, `limit` and `remedy` parameters and JSON result match the
[`query_activity` roadblocks scope](integration-contract/mcp.md#chat-ui-in-process-tools-mcp__brain-ui__).
The endpoint rejects duplicate, empty, fractional or out-of-range parameters
with 400, refuses unauthenticated requests with 401, and returns a named 500
error if storage cannot be read. Its window includes events whose recorded
`at` is between now minus `hoursBack` and now, both endpoints inclusive;
future events are excluded. Each ranking is limited after aggregating the
whole window. Malformed or unsupported-version episodes are counted as
unavailable rather than exposed or silently counted as known waste.

This is a host-local aggregate over the durable governance store; neither
workers nor the brain CLI open that store. Detail pruning does not remove
session-retained roadblocks. Session deletion and unbound-event retention
still apply. It returns normalized signatures, counts and example turn ids,
without raw failure inputs or resolving-path payloads, and sends no external
telemetry. Use `hoursBack=168` for a week of retained turns.

## Governance events (additive, #1651)

**GET /api/governance/events** is protected and read-only. It returns the
machine-readable records the host keeps of every sandbox or governance
intervention in a turn: promotions, policy blocks and confirmations, read-only
refusals, provider-mask refusals, quarantines, budget and scope limits, egress denials, `strict`
fallbacks, revert conflicts, outward actions, taint, unavailable providers,
worker resource limits and
classified roadblocks ([decision](decisions/governed-writable-workers.md#roadblocks-and-governance-events-tracked-not-noise)).
Nothing renders them to the user. They live in the server's own database, never
in `brain.db` or the brain, and are kept with the session's catalog row rather
than with the pruned Activity span detail: pruning span detail leaves them, and
deleting a session deletes them. An event whose turn never named a session (a
new conversation refused before it started, a crash before `session_info`) has
`sessionId: null` and is kept for 90 days, except `taint` and
`taint_exposure`: unresolved safety evidence has no time-based eviction. A
content-free once-only turn/session binding survives catalog removal and
refuses contradictory binding or late writes under a retired session identity.
Explicit chat retirement retains governance under its existing independent
audit owner; it does not claim those audit records were erased.

Query parameters, each optional and combined with AND: `session` (one session
id), `turn` (one turn id), `kind` (repeatable or comma-separated kinds from the
table below; an unknown kind is 400), `after` (an event id; only later events
are returned) and `limit` (1–500, default 100). The answer is 200
`{ events, nextAfter }`, ordered by `id`, with `Cache-Control: no-store`.
`nextAfter` is the last event's `id` when the page is full, so more may follow,
and `null` otherwise. A malformed parameter is 400 `{ error }`; a storage
failure is 500 `{ error }`.

Each event is `{ id, sessionId, turnId, at, kind, schemaVersion, actor, model,
profile, payload }`:

- `id` is a positive integer, increasing in write order.
- `sessionId` and `turnId` name the session and turn the event belongs to, or
  are `null`. An event written before its session had a catalog row gains the
  `sessionId` when the turn's `session_info` arrives. For `revert_conflict`,
  `turnId` is the reverted turn.
- `at` is epoch milliseconds.
- `actor` is who caused it: `interactive`, `voice` or `autonomous` for a turn
  of that posture; `user` for a person acting outside a turn, such as a revert;
  `server` for the server acting on its own, such as boot reconciliation; and
  `external` for a change made outside any turn or server path.
- `model` is the turn's model id and `profile` its worker profile
  (`governed`, `strict` or `restricted`); either is `null` when it does not
  apply.
- `payload` is an object whose fields depend on `kind` and `schemaVersion`.

The server validates every payload against its kind's schema when it is
written, so a stored record always matched its version. A payload change that
is not purely additive bumps the kind's `schemaVersion`; stored events keep the
version they were written with and are returned as stored. Clients must ignore
unknown kinds and unknown payload fields, and should read a payload only for a
`schemaVersion` they know. Until a release emits a kind, its version 1 payload
may still change.

Collection metadata on new tool/proxy taint rows is a strict optional object:
`{ id, epochId, operationId, signalId, exposureId, detector, exposure, provenance, admission? }`.
IDs are host-minted opaque ASCII `[A-Za-z0-9_-]`, 1–128 bytes;
`operationId` may be null. The detector names follow the version 1 inventory in
[the reviewed plan](plans/reviewable-session-safety.md#detector-contract-and-coverage).
`exposure` is `open`, `finalized` or `interrupted_unknown`. Verified proxy
provenance is `{kind: web_origin, origin: {scheme, host, port}, verifiedBy:
host_transport}` or `{kind: tunnel_authority, authority: {host, port}, verifiedBy:
host_proxy}`; unverified tool/repository provenance is `null`. Admission records
`{trusted: false, policyHash: <SHA-256>|null, trustRevision: "0"}`. Source trust
is disabled. A separate terminal event records host-proven delivery completion;
a display frame or opaque tunnel close cannot establish it.

The host's durable projection includes all unresolved identities and explicit
coverage/failure facts, independently of this paginated governance history.
Legacy/no-row and unsupported histories are restricted. Collector metadata alone
never proves complete coverage: a new host-bound session needs every mandatory
versioned acknowledgement. Old rows remain readable as stored. No safety query,
review/clearing endpoint or mutation capability is enabled by these additions.
Provider dispatch refuses unsettled or failed input recording at the host relay,
including when a runtime continues after a hook failure.

### Governance event kinds

Counts and byte sizes are non-negative integers. Amounts are non-negative
finite numbers. A policy `rule` is `{ list, index, pattern, reason? }`: the
policy list that matched, the entry's position in it, its pattern and its
reason. `policyHash` is the governing policy's hash, or `null` under the
built-in defaults. `source` on a limit is `policy` or `default`. Tool inputs
are capped at 8192 characters, and `inputTruncated` says whether the recorded
`input` was cut. Before an `input` is stored, anything in it shaped like a
credential is replaced with `[redacted]`. Like session history, events can be
read by any authenticated principal.

| Kind | Version | Fields | Meaning |
| --- | --- | --- | --- |
| `safety_admission_expired` | 1 | `toolUseId`, `evidenceRevision`, `trustRevision`, `authorityEpoch`, `reason` | A waiting or claimed safety-bound approval was withdrawn before dispatch. The server commits this terminal fact before settling the backend wait or publishing the coordinator's `expired` result. Revisions describe the card's original host snapshot; `reason` is `safety_changed`, `turn_ended` or `grant_storage_failed`. Storage failure stops the turn with an explicit failed terminal outcome, without claiming durable withdrawal. This grants no replay and changes no historical approval. |
| `egress_connection` | 1 | `connectionId` (optional), `host`, `port`, `method`, `path` (optional), `bytes`, `accounting`, `durationMs`, `outcome`, `inference` (optional), `provider` (optional, #3246), `reason` (optional) | A completed, denied, failed or cancelled proxy connection. HTTP has a path and conservative wire accounting; opaque CONNECT has no path or plaintext claim. Only the concrete inference relay sets `inference: true`, and only a validated provider-relay operation sets `provider: true`; a record never carries both. Neither relay's record makes its host a contacted one for a tainted session's worker traffic. Headers, query strings and content are absent. |
| `steering_change` | 1 | `path`, `sequence`, `beforeHash`, `afterHash`, `taintSourceEventId`, `overlappingTurnIds`, `tainted` (optional) | One observed steering change, attributed to its turn. Hashes identify retained regular-file versions or are `null`; the source is the current unresolved taint event or `null`. New observations may carry `tainted: true` for effective restriction, including unknown coverage without an attributable source. Historical rows retain their original attribution. Shared windows remain shared, not exclusive writer claims. |
| `policy_change` | 1 | `requestId`, `baseHash`, `proposedHash`, `sections`, `outcome` | Explicit user-approved policy publication. Actor is `user`; outcome is `updated`; hashes identify the exact reviewed and written bytes. |
| `scratch_overage` | 1 | `bytes`, `pinnedFiles`, `pinnedBytes`, `overageBytes` | Scratch remains above its cap after a prune that preserved retained links. Counts are remaining bytes and pinned files/bytes; `overageBytes` is the excess. A background pass has actor `server` and no session or turn; unbound retention applies. |
| `promotion` | 1 | `source`, `destination`, `bytes`, `originalLink`, `rewrittenLink` | A linked turn-temp file was copied into `.brain/scratch/turns/<turnId>/` and its link rewritten. `destination` is brain-relative. |
| `promotion_refused` | 1 | `source`, `originalLink`, `reason`, `bytes`, `limitBytes` | A linked turn-temp file was not copied and its link was left unchanged. `reason` is `file_too_large`, `turn_too_large`, `not_regular_file`, `symlink`, `multiple_links`, `missing`, `io_error` or `scratch_unavailable` (`.brain/scratch/` was not usable for the turn); `bytes` and `limitBytes` may be `null`. |
| `turn_temp_purge` | 1 | `truncated`, `all`, `force`, `paths`, `removedEntries`, `freedBytes`, `skippedLinked`, `skippedOther`, `usedBytes`, `limitBytes` | The agent purged its turn temp with the `turn_temp` tool (#1703). `truncated` states whether the bounded walk stopped early, leaving paths for another call. `all` is a purge of everything rather than of the named `paths` (the first 50, as the agent wrote them; empty with `all`); `force` removed named files the answer links. `skippedLinked` names the linked files kept for promotion (the first 50), `skippedOther` counts paths not removed for another reason (outside turn temp, missing, unreadable), and `usedBytes` and `limitBytes` are the turn temp's use and allowance after the purge. |
| `policy_block` | 1 | `tool`, `input`, `inputTruncated`, `rule`, `policyHash` | A tool call refused by a `commands.deny` rule. |
| `policy_confirm` | 1 | `tool`, `input`, `inputTruncated`, `rule`, `decision`, `policyHash` | A tool call that matched a `commands.confirm` rule. `decision` is `approved`, `declined`, `timed_out` or `cancelled`. |
| `read_only_refusal` | 1 | `path`, `protection`, `code`, `tool`, `alternative` | A write refused because the path is protected or the profile is read-only. `protection` is `tier_a`, `tier_b`, `policy_protect`, `strict_profile` or `restricted_profile`; `code` is `EROFS`, `EACCES`, `EBUSY` or `null`; `alternative` is the allowed route the refusal named. |
| `provider_mask_refusal` | 1 | `tool`, `path`, `rule`, `policyHash` | A host bridge tool refused a path that the turn's provider folder masks hide: a document read (`brain_read_base`), an application or share completion, an image mask, an inbox addition or a policy proposal. `tool` is the tool as the agent called it, `path` the brain-relative path it named, and `rule` the `providers` entry whose selector maps onto the masked folder (`list` is `providers`; `pattern` is the folder path selector, or `type <name>` for a type translated onto the folder). One event per refused call; nothing was read or written ([decision](decisions/governed-writable-workers.md#data-to-provider-routing-g2)). |
| `quarantine` | 1 | `path`, `tier`, `entry`, `bytes`, `trigger`, `objectId` | A protected file that appeared during a turn was moved into the journal quarantine. `tier` is `A` or `B`; `entry` is `file`, `directory`, `symlink` or `other`; `trigger` is `turn_end` or `boot_recovery`; `objectId` names the quarantined copy. |
| `quarantine_reconciliation` | 1 | `trigger`, `reconciledTurnIds`, `quarantined`, `masked` | One reconciliation pass. `trigger` is `boot_recovery` or `launch`; `masked` lists the paths a launching worker saw masked. |
| `budget_warning` | 1 | `scope`, `unit`, `limit`, `observed`, `source` | A warn limit was crossed. `scope` is `turn`, `session` or `day`; `unit` is `usd` or `tokens`. |
| `state_room_warning` | 1 | `usedBytes`, `allowanceBytes`, `observedAt` | A resumed conversation's measured state reached its existing 75% warning threshold. The numbers and Unix-millisecond timestamp are the same observation sent with its result and history. One quiet event per session, backend and allowance; it does not change admission or start a continuation. |
| `budget_block` | 1 | `scope`, `unit`, `limit`, `observed`, `source`, `stage` | A block limit was reached. `stage` is `admission`, `mid_turn` or `sdk_backstop`. |
| `scope_cap` | 1 | `cap`, `limit`, `observed`, `overshoot`, `frozen`, `outcome`, `source` | A per-turn cap was reached. `cap` is `files_changed`, `minutes`, `tool_calls`, `free_space_floor` or `turn_bytes`; `overshoot` is how far past the cap the turn went, in the cap's unit; `outcome` is `paused`, `continued`, `stopped`, `voice_stopped` or `turn_ended`. `paused` records the confirmed freeze before the user decides; retained turn scope receipts record its eventual decision or interruption. A free-space overshoot is the measured deficit below its floor. |
| `egress_denial` | 1 | `host`, `port`, `method`, `reason`, `bytes` | The egress proxy refused a connection. `method` is set for plain HTTP; `reason` is `denied_host`, `not_allowlisted`, `byte_cap` or `taint_allowlist`; `taint_allowlist` includes a tainted destination the user declined (#3430). |
| `strict_fallback` | 1 | `path`, `reason` | A turn ran under `strict` instead of `governed` because a protected path is a `symlink`, a `hardlink` or a `mount_point`. |
| `revert_conflict` | 1 | `conflicts`, `restored` | A revert skipped paths that changed after the reverted turn. Each conflict is `{ path, state }`, with `state` one of `changed`, `deleted`, `created` or `type_changed`; `restored` counts the paths it did restore. |
| `outward_action` | 1 | `tool`, `input`, `inputTruncated`, `action`, `target`, `historyRewrite`, `tainted`, `decision`, `rule` | An action outside the brain in the user's name, allowed or not. `action` is `git_push`, `gh_write`, `mcp_tool`, `http_write`, `outward_host_connect` or `compute_run` (a hosted external compute job start, #3108, its `target` the instance id); `decision` is `policy_allowed`, `approved`, `declined` or `refused`; `rule` is the matching `outward.allow` rule or `null`. |
| `taint` | 1 | `source`, `tool`, `detail`, `occurrence` (optional) | Each independent observed untrusted-input signal, including later signals while already restricted. A host identity deduplicates only exact delivery retries; changed-body reuse refuses. `legacy_unknown` denotes unknown search-result provenance. `source` is `web_fetch`, `web_search`, `staged_share`, `chat_attachment`, `workspace_read`, `mcp_document`, `user_marked`, `egress_connection`, `fetching_command`, `unclassified_command`, additively since #3162 `apify_result` (Apify catalog text or Actor results returned to a turn; `tool` names the `brain_apify_*` operation), or `compute_output` (a collected external compute job's output, #3108). Additively since #3685, Pi's host-owned `get_search_content` records `web_fetch` and `source_check` records `web_search`. |
| `taint_exposure` | 1 | `occurrenceId`, `state` | A separate terminal observation for an open occurrence: `finalized` only after a completed bounded HTTP response, otherwise `interrupted_unknown`. Opaque CONNECT closure never establishes source finalization. This observation authorizes no safe verdict. |
| `provider_unavailable` | 1 | `provider`, `capability`, `command`, `degradedTo` | A worker command needed a provider whose key the host withheld from the worker. Recorded from the token the CLI prints ([CLI contract](integration-contract/cli.md#withheld-provider-keys-additive-0440-1666)), one event per distinct token in a tool result and at most 20 per turn. `capability` is `embeddings`, `completions`, `reranking` or `image`; `command` is the shell command, or the tool's name for any other tool; `degradedTo` names the fallback used (`keyword_search`, `keyword_index`, `lifecycle_order`) or is `null`. The token is text in tool output, so the event is a diagnostic, not proof. |
| `resource_limit` | 1 | `limits`, `fatal` | A worker hit a resource limit. Each limit is `{ limit, source, value, events }`: `limit` is `processes`, `memory`, `pids`, `file_size`, `data`, `cpu` or `open_files`; `source` is `rlimit` or `cgroup`; `value` is the configured limit; `events` counts the hits the source reported, or is `null`. `fatal` says whether the worker died of it. |
| `roadblock` | 1 | `category`, `family`, `signature`, `failures`, `resolution`, `remedy`, `waste`, `eventIds` | One classified roadblock episode, written when its turn ends ([classification](decisions/governed-writable-workers.md#roadblocks)). An episode opens at a failed step and closes at the next successful call of the same `family`, or at turn end. `family` is the tool family: `shell:<program>` (with the subcommand for multi-command programs, such as `shell:git push`), `file_write`, `file_read`, `search`, `web`, `brain_write`, `subagent`, `mcp:<server>:<tool>` or `tool:<name>`; a governance event with no call has `budget`, `scope`, `network`, `policy` or `outward`. `category` is `tool_error`, `shell_nonzero`, `fs_denied`, `permission_denied`, `policy_block`, `budget`, `scope_cap`, `network_refused` or `retry`. It is `retry` when the episode repeated a near-identical failed input, and otherwise the first failure's category. `signature` is the grouping key `<family>\|<target>\|<category> <detail>` of the first failure, for example `file_write\|.brain/*\|fs_denied EROFS .brain/*`. The target is the command's program and, for multi-command programs, its subcommand (`<script>` for a program run by path); the directory a path sits in, by its last name, when that is one of the brain's structural or write areas (`<dir>` otherwise); or a URL's scheme (`https-url`). A signature therefore never carries file names, arguments, hosts, user-chosen directory names or absolute roots. The detail after the category is the error code and target area, `exit <code>`, or the deciding rule or limit, so equal signatures mean the same roadblock. Each failure is `{ toolCallId, signature, category }`, where `toolCallId` is `null` for a governance event with no call. `resolution` is `{ toolCallId, signature }` or `null`. `remedy` is `guidance` when a call the turn could already make resolved the episode. It is `abandoned` for exactly one unresolved failure with no retry followed by an eligible later success; repeated unresolved failures or turn-temp workarounds remain `capability`. `waste` is `{ tokens, costUsd, ms }`, measured from the first failed call's start to the resolving call's start; unresolved waste stops at the first successful call starting strictly after the last failure was known, otherwise at turn end. That accounting boundary does not create semantic resolution. Usage is sampled at that boundary; final usage cannot fill an earlier bound. Unknown tokens or cost are `null`, never 0. `eventIds` names the governance events the episode drew on. |

## Policy proposal receipts (additive, #1662)

`GET /api/policy-proposals/:turnId/:requestId` reads the existing request for
its authenticated principal. Optional `session` must match its bound session.
It returns `PolicyChangeReview`: request/turn/path, state, quoted rationale,
exact nullable `baseHash`, `proposedHash`, frontmatter/body diffs, `bodyChanged`,
changed section names, message and validation warnings. It is never cached.
Missing or other-account receipts return 404; absent/revoked authentication
returns 401. Invalid identities return 400. There is no HTTP approval or write.

States are pending, writing, updated, declined, stale, invalid, refused and
unknown. Stale and failed revalidation consume the approval and write nothing;
a new proposal is required. A lost completion receipt remains unknown.
Check again reads this same request, never repeats the write. Receipts survive
runtime tool output and are joined to the original tool slot in kept history.

`GET /api/agent-policy` returns `AgentPolicyRead`: policy path, hash/source,
validation errors/warnings, interactive/voice policy minimums, protected paths
and nullable `workerLimits` (the recorded worker-host status's enforced/absent
resource facts). It uses the same `GovernedTurns.facts` reader/cache as admission.
It returns 503 when shared facts are unavailable or changed during the read.
It does not treat parsed cost/scope/network policy values as already enforced,
and it does not imply a running turn changed its frozen policy.


### Shared-window conflict choices

The retained journal details may add `conflict: { versions, latest }` to a
changed path. Each link names an existing after-observation by turn and sequence;
it never names an arbitrary object hash. Two distinct observed versions within
one overlapping window are required. Merely sharing a single observation does
not identify conflicting writers.

The existing authenticated user history POST accepts `action: "keep_version"`
or `"keep_both"`, with `path`, selected `version`, reviewed latest `expected`,
and `otherVersion` for keep both. Each reference is
`{ turnId, sequence, side: "after" }` from that same path and original turn.
Malformed references return 400; unavailable/expired or changed selection
returns 409; the raw file is compared again at application. Receipt `resolution`
records the explicit selection; generated numbered siblings appear in its paths.
These actions reuse the existing queue, identity-bound readback, partial
receipts, journal and user Undo. No additional endpoint, automatic merge or
agent permission is introduced. The reader calls versions observed, never
exclusive "mine" or "theirs" ownership.

## Storage inventory

The server uses the installed `@schlessera/brain/storage` metadata reader. It
never executes Git, the brain CLI, repository configuration, hooks or filters
for inspection. Only fixed Git administrative location markers and approved
host roots participate in discovery.

These six operations require a current `owner` or `ambient` principal. Agent,
delegated and restricted access is refused (403); unauthenticated/revoked access
is refused (401 by normal authentication). Authorization is checked again at
coordinator access and after asynchronous inspection. Responses are private,
no-store. Mutations retain the existing origin and JSON body protections.

`GET /api/storage` returns SDK `StorageStatus` version 1 without starting work:
state, active scan ID, nullable latest/previous observations, last failure and
limits. `POST /api/storage/scans` accepts only `{}` and returns 202 with status.
It coalesces one scan per app instance; a new scan is limited to once every five
seconds. Roots, credentials and scan budgets are never request parameters.
`DELETE /api/storage/scans/:id` returns 202 while cancellation is being reaped;
an inactive identity returns 409. Initiator revocation cancels its scan.

`GET /api/storage/scans/:id/entries` accepts optional `rootId`, `parentId`
(empty means root rows), `owner=all|brain|app|operator`, `type=pdf`, nonnegative
integer `largerThan`, `search`, `sort=name|size`, `metric=allocated|logical`,
`direction=asc|desc` and opaque `cursor`. Search matches case-insensitive entry
names and admits at most 128 UTF-8 bytes with no control characters. Ordering
applies to all matches before paging; unknown byte values sort last. Explicit
size ordering defaults descending, name ordering ascending; absent presentation
parameters retain the original root/path order. PDF matching is filename based and
case insensitive; byte thresholds are strictly greater than. A page has at most
200 entries, a next cursor, stale flag, match count and object-union subtotals.
Cursors bind the scan and filters and expire after 60 seconds; changed/expired
cursors return 409, malformed cursors/filters 400. Unknown/evicted scans return
404. Cache retains at most two observations and 96 MiB serialized data, each
at most 48 MiB, for at most ten minutes. One scan admits at most 100,000 entries,
32 roots and 35 seconds of collection; child cancellation is awaited. Kernel
uninterruptible I/O cannot have a hard wall-clock completion guarantee.

`GET /api/storage/scans/:id/tree` accepts `parentId` (a root or directory ID;
absent/empty selects all roots), `owner`, `search`, `sort`, `metric`, `direction`
and `cursor`. It projects the retained scan without filesystem reads, returning
SDK `StorageTreePage`: parent, breadcrumb names/IDs, at most 200 immediate child
nodes, full match count and subtotals. Search matches immediate child names;
default ordering is descending allocated size. A node's `totals` contains its
subtree object union; `area` assigns each object to one matching sibling in stable
root/path order. Alias names remain visible without inflating the displayed area.
The page's `totals` union covers all matching nodes, including later pages.
An explicit, non-actionable `metadata` node accounts for the current directory's
own allocation; file roots retain file identity. Partial/unknown owners remain
partial/unknown even with no matching rows. Tree cursors also bind the operation
and cannot be reused for flat entries. Projection has a three-second checked
CPU deadline over the bounded cached scan; incomplete topology, an unavailable
parent or an out-of-view parent returns 503 rather than omitting descendant bytes.

The server resolves the installed host core package’s public metadata entry
outside the brain, with explicit roots and no inherited secrets. It never
launches the brain repository’s selected executable on the host.
Missing/incompatible inventory support produces partial/unavailable evidence
rather than falling back to CLI execution or internal imports. Metadata workers
inspect only exact configured stores, reject redirects below roots and mount crossings, and
never read attachment/database/backup contents for sizing. Backend setup is not
triggered by inventory. Explicit host backup/Git roots are described in server
configuration; no remote or host-wide filesystem discovery is performed.

Root IDs, object IDs and versions are opaque per app lifetime. Absolute paths,
configuration contents and credentials are excluded. All/Brain/App/Operator
are overlapping ownership views over an object union, never additive totals.
Filesystem identity reconciles shared capacities; unsupported equivalence stays
unknown. Capacity rows are never summed. `measured` and `other` remain null
because shared extents do not establish exclusive attribution. Statfs caller
availability is not quota headroom. Native retained stores and private temporary
usage remain explicit unknown rows where their owners cannot provide a safe
measurement. Limits, permissions, unsupported metadata and live changes preserve
partialness; unknown values never become zero or a logical-size fallback.

`GET /api/storage/scans/:id/entries/:entryId/references` inspects a retained
canonical file observation through the supported core query API. One inspection
per app runs at a time, with a five-second cancellation deadline and 1 MiB output
cap. The result is SDK `StorageReferenceEvidence`: up to 200 indexed source paths
and index timestamps, truncation, observation time, and explicit unchecked scope.
Index timestamps do not prove current source freshness. Unavailable index support
returns unavailable evidence; an empty observed list never proves no references.
No file body is read for inventory, type filtering or this index inspection.

Inventory endpoints do not authorize deletion, expiry, maintenance or recovery. The complete
Storage pane is delivered separately with its approved removal journey.

## Storage maintenance (additive, #2011)

These four operations require the same current human-owner authority as Storage
inventory. GETs and cancellation additionally bind receipts to their initiating
principal. Authorization is checked at admission, after waiting for owner locks,
before worker launch and before output publication. Responses are private,
no-store; origin and JSON protections remain in force.

`GET /api/storage/maintenance` returns `{operations, limits}`. Each row has a fixed
`id`, label, owner, scope, effect, availability/reason, headroom disclosure and
nullable latest receipt. The only operation IDs are `pack-git`, `prune-scratch`
and `cleanup-staging`. These delegate respectively to core's existing
non-destructive packing, pin-refreshed scratch pruning, and the inbox's settled
staging cleanup. They do not run the general inbox drain or retention tick.

`POST /api/storage/maintenance` accepts only `{id, operation}` in at most 4096
bytes. IDs contain 16–96 ASCII letters, digits, `_` or `-`. It returns 202 with
the durable receipt. Repeating the same identity/principal/operation reads that
receipt; mismatched reuse is 409. Only one admitted Storage operation per brain
runs across database connections. Another identity while one is active returns
409. Requests cannot choose roots, executables, commands or retention policy.

`GET /api/storage/maintenance/:id` returns the original receipt; missing or
other-principal receipts return 404. `DELETE` on the same path returns 202 with
that receipt and requests cancellation. Cancellation stops further admission and
interrupts the bounded worker; it does not promise rollback of committed effects.
Current inbox item acknowledgement can finish before later items stop.

SDK `StorageMaintenanceReceipt` contains identity, operation/owner/scope,
request/start/completion timestamps, state, reason, headroom, nullable before/after
observations and owner outcome. States are `waiting`, `running`, `complete`,
`partial`, `refused`, `cancelled` and `unknown`. Interrupted started work remains
unknown unless the owner supplies a durable item outcome; readback never blindly
re-dispatches it. Failed refresh suspends scratch deletion; retained pins and
pinned overage survive. Live, unacknowledged or recovery-gated staging remains
with its existing owner. There is no new cleanup/expiry schedule.

Before/after observations separately retain affected stores and capacities,
coverage and basis. They explicitly permit concurrent writers. File counts and
packed-object counts are never converted into reclaimed bytes. Unknown headroom
is null; old/new Git packs may coexist and required temporary bytes are workload
dependent. Existing worker admission controls its temporary space. A known zero
capacity refuses packing, and receipt admission failure starts no owner action.
No other recovery store is purged to make room.

The worker has a five-minute deadline and a combined 1 MiB output ceiling;
termination awaits its existing cleanup. Kernel uninterruptible I/O cannot carry
a hard completion guarantee. Each staging pass considers at most 200 eligible
rows. Receipts reserve at most 64 KiB each, with bounded item detail and explicit
truncation; the per-brain admission ceiling is 1024 receipts. Reaching it refuses
new IDs with 503 and retains all existing receipts. This is a resource admission
bound, not a new retention expiry. Lost completion persistence retains intent and
readback describes uncertainty. Invalid input is 400, oversized bodies 413,
non-JSON input 415, and unavailable owners/admission 503 or a refused receipt.

Packing requires content core 0.44.0 or newer. Older installations produce
an explicit refusal; the ordinary server CLI minimum is also 0.44.0. Hosted CLI
operations use only the qualified credential-free maintenance worker; unsupported
hosts do not fall back to executing repository code on the host.

## Recoverable attachment removal (additive, #2012)

The seven `/api/storage/removals` operations require current owner/ambient human
access and return private, no-store responses. Missing authentication is 401;
delegated callers are 403. Receipts belong to their initiating principal and an
unknown or another principal's identity returns 404. Origin protections apply
to writes; JSON is mandatory for POST. No agent tool gains deletion authority.

GET returns SDK `StorageRemovalCapability`: `available`, `reason`, fixed limits
and `latest` receipt or null. Unsupported native recovery/worker hosts report
unavailable. POST `/reviews` accepts exactly `{id, paths}` and POST
`/undo-reviews` exactly `{id, sourceId, paths}`. IDs use 16–96 ASCII letters,
digits, `_` or `-`; at most 32 distinct canonical relative paths, 4096 bytes per
path, 32 components, 64 MiB per file and 128 MiB of eligible file bytes are
admitted. Review bodies are bounded to 140,000 bytes. Paths do not choose roots,
executables, commands, sidecars or a wider scope. One review per coordinator
runs at a time, with a 60-second deadline and a ten-minute confirmation window.

POST `/inspection` accepts exactly `{paths}` under the same owner, path, worker,
writer-gate, deadline and response bounds. It returns `StorageRemovalInspection`:
current `observedAt`, `files`, `complete`, `unchecked` and `selectedFileBytes`.
It neither allocates a durable receipt nor exposes an identity or fingerprint
that can be confirmed. Inspecting files therefore cannot consume the operation
receipt budget. Selection still requires a fresh durable review before removal.

Review returns a durable `StorageRemovalReceipt` in `review` state. Its review
contains the identity, action, optional source identity, opaque fingerprint,
observation/expiry times, selected logical file bytes, unchecked scopes and
per-file eligibility/reason, raw hash/size, Git state, current reference evidence
and recovery state. File bytes are not promised freed space. Originals are
`requires-retention` until execution actually retains them; Undo reviews say
`retained` only for an available original. Excluded targets remain visible.

Eligibility is limited to ordinary single-link non-executable attachments with
supported media, PDF, office/archive or ebook suffixes. Hidden paths, policies,
scripts, workspaces, configured other-owner stores, symlinks, hard links and
nested mounts remain ineligible. Unknown protection or current recovery coverage
refuses effects. Ordinary journal exclusions are preserved, including ignored
files. Filename eligibility does not establish document validity or safe preview.

The consequence worker scans at most 10,000 directory entries, 2000 Markdown
files, 8 MiB of Markdown overall and 512 KiB per file; it records up to 200
reference sources per selected file. Git subprocesses have two-second/1 MiB
bounds; the enclosing credential-free worker has a 30-second/256 KiB output
bound. It does not initialize brain config and discards every output, including
incidental Git writes. Current parsed Markdown references are independent of
index freshness. Retained conversations, external consumers, hidden/symlinked
content, other workspaces and unsupported link syntax remain unchecked. Incomplete
local evidence is ineligible; absence of observed links never proves no consumers.

POST at `/api/storage/removals` accepts `{id, fingerprint}` in at most 4096 bytes
and returns 202. It confirms exactly that review; mismatched or expired reviews
are 409. Repeating an admitted identity reads its receipt without repeating any
file effect. Removal and Undo serialize across processes through the existing
exclusive writer gate and brain/Git locks. Active turns finish before validation;
nested shared maintenance can still finish while removal waits. Current
principal authority, selected versions, topology, protection, ordinary retention
coverage and consequences are rechecked after admission and before effects.
Unknown external writers outside the managed admission system are not coordinated
by these locks; this is not an arbitrary filesystem cleanup service.

Verified before-bytes use the existing charged native journal/CAS. The original
and durable item intent precede unlink; admission, quota or ENOSPC refusal leaves
the source intact. No new ignore override, retention policy, Git-history removal,
reference rewriting, sidecar cascade, commit or push is introduced. Undo gets a
new review/identity and uses retained bytes only while their owner still provides
them. It checks the reviewed parent chain and creates only an absent destination;
a replacement is never overwritten. A failed copy removes only its own incomplete
inode, preserving the retained original.

GET `/:id` returns the original receipt. DELETE `/:id` requests cancellation and
returns 202; later items stop while the current critical acknowledgement finishes.
Receipts distinguish `not-started`, `applying`, `removed`, `restored`, `changed`,
`protected`, `failed` and `unknown` items. Operation states are `review`, `waiting`,
`running`, `complete`, `partial`, `refused`, `cancelled` and `unknown`. A killed
owner or lost acknowledgement remains explicit uncertainty, never inferred
success or a replay. Confirmed successes survive mixed batches. `undoAvailable`
and `undoReason` are recomputed from the original's current retention ownership;
expired or unavailable detail visibly removes the Undo offer.

Before/after observations separately record current content, journal, Git,
operational database and volume availability, with timestamp, basis, coverage and
concurrent-writer qualification. `index` is separately `not-requested`, `complete`
or `unavailable`; refresh publication is restricted to the fixed disposable
`brain.db` files, so configuration code cannot publish changes to unselected
content through this refresh. Commit/sync remain `not-requested`, Git history unchanged by
this operation and backups unmeasured. Deletion can initially increase allocation.

The operation's queue and effects have a five-minute cancellation deadline;
index refresh and after-measurement each have an independent 36-second bound.
Individual raw hashes have a 15-second deadline. Kernel uninterruptible I/O cannot
guarantee a hard return time. Public receipt and private version metadata each
reserve 256 KiB through the existing journal allocation owner. The per-brain
admission ceiling is 128 identities; reaching it refuses new reviews with 503 and
retains existing receipts. This is an admission bound, not a new retention expiry.
Invalid requests are 400, oversized bodies 413, wrong content type 415, contention
409 and unavailable evaluation/recovery/admission 503 or an explicit refused/failed
receipt. The Storage pane is delivered by its complete UI issue.

## Storage history and pressure guidance

`GET /api/storage/history` and `GET /api/storage/guidance` require the same
current human-owner authority as inventory. They accept no body or options,
use `Cache-Control: private, no-store`, and never collect filesystem inventory.
Unauthenticated callers receive 401; delegated principals receive 403; an
unavailable operational read returns 503. Unknown evidence is a nullable or
explicit unavailable field in a successful response, never a zero.

History returns SDK `StorageHistoryResponse`, version 1: state, pause reason,
pending status, last actual observation time, serialized payload bytes, limits
and at most 186 named observations. Each observation identifies its UTC tier,
actual start/end, source, collector version, opaque scope, basis, coverage and
gap/reason. Its at most four capacities carry nullable total/used/free/available,
three owner attribution views and a separately deduplicated union. History has
no paths, filenames, content, credentials or persistent display names. The
private compact encoding is not a wire contract. The 256 KiB ceiling applies
to that canonical persisted payload; named HTTP expansion and SQLite pages/WAL
are separate charges. Limits are 64 six-hour, 90 daily and 32 Monday-weekly slots.

Guidance returns SDK `StorageGuidanceResponse`, version 1: current/unknown/
unavailable state, highest retained severity, pause/pending status, last actual
observation time, scope-limit flag, up to four capacity pressure records and
untracked current inventory IDs. Each pressure record retains independent
capacity, forecast and owner-refusal causes, recovery time and opaque episode.
Current authorized inventory supplies optional store display labels. Its
nullable evidence identifies observed rate windows and short/long conditional
capacity scenarios; unavailable scenarios carry a reason, never a guessed
number. `non-depleting` does not mean unlimited capacity. Unknown state can
retain Low/Critical severity until the cause-specific recovery rules are met.
Older retained complete observations keep their own timestamps even when newer
partial evidence changes pressure.

Notification status uses existing browser-managed permission. It includes
strict local 22–08 quiet hours, up to 100 subscription zone/quiet summaries and
200 episode receipts, with separate truncation flags. It exposes neither
endpoints nor credentials. Receipts distinguish pending, sending, accepted,
known failure, unknown and suppressed. Accepted means transport submission;
unknown is terminal for automatic retry. Three attempts per episode/subscription
are the maximum, with one/five-minute delays only after known non-delivery.
Restored episodes never regain notification authority. See
[Storage history](storage-history.md) for sampling, recovery and physical costs.

### Session safety sidecars

`GET /api/sessions/:id/safety?limit=50&cursor=...` is an authenticated,
read-only view of host evidence. `limit` is an integer 1–100; cursor is absent
on the first page and opaque on subsequent pages. The query is at most 8192
bytes. A successful `SafetyPage` has `version: 1`, canonical `identity`,
`snapshotId`, input `cursor` (null initially), decimal-string `highWater`,
`projection`, up to 100 immutable records, `nextCursor`, `snapshotComplete`
and `detailPruned`. Responses are `Cache-Control: no-store` and at most 262144
UTF-8 bytes. No request invokes a verdict, policy writer, backend turn or
provider transcript write.

Optional `entries=1` includes the host-owned `entry:{kind:"tool",toolUseId}`
only where recorded. The same choice is required on every cursor page; its
subscription inherits it. No other `entries` value is accepted. The default
response retains the original strict version-1 record shape. Correlation
requires both the exact host turn and tool identity; opaque network input and
unknown legacy attribution remain separate named turn events. Minimal entry
identity survives detail pruning; retirement removes it with the evidence.

The exact live principal must own the retained history. There is no equivalence
between separate owner logins, delegated credentials or ambient identities.
The existing native-history and dialogue APIs keep their visibility rules.
Unknown/unowned legacy safety collections return explicit unavailable; known
legacy collection gaps never imply normal. Revoked/expired callers receive
401, malformed queries 400, expired/generation-changed or membership-gap cursors 409, capacity
503, and absent/retired/unavailable evidence 404. Safety refusals carry
`{version:1,reason}` without records; pre-handler auth keeps its existing error
envelope. An older host's absent route means unavailable, never normal.

Each cursor is an unguessable server-side position bound to this host process,
principal, exact target, canonical generation, snapshot, high-water and last
sequence. Its lifetime is five minutes; restart invalidates it. Every page
retains the first page's aggregate and high-water despite later verdicts or
input. Adoption that changes pre-watermark collection membership invalidates
the snapshot with `gap`, including at final delivery after an awaited read;
the client obtains a fresh snapshot. Newly pending input or a local recording
loss also fences final delivery of an older unqualified view, even when the
durable failure notice rolls back without advancing the evidence revision.
Fresh reads expose the restrictive local overlay. Detail pruning invalidates earlier cursors; a fresh snapshot returns
explicit bounded stubs retaining occurrence IDs. The final page means that
snapshot has been assembled, separately from detector completeness. Read
[revisioned delivery](integration-contract/wire.md#session-safety-history-additive-3604)
for reconnect, subscription and client rules.

### Individual safety review

`POST /api/sessions/:id/safety/reviews/prepare` prepares exactly one finalized
occurrence. `POST /api/sessions/:id/safety/reviews/:requestId/commit` commits or
reads back that host-issued handle. Both accept only this strict JSON body:

```json
{
  "version": 1,
  "session": {
    "sessionId": "ithaca",
    "historyOwnerId": "voyage",
    "historyGeneration": "1"
  },
  "occurrenceId": "harbour-notice",
  "expectedEvidenceRevision": "12",
  "verdict": "safe"
}
```

The path and body session must agree. IDs are 1–128 ASCII letters, digits,
underscore or hyphen; revisions are canonical unsigned 64-bit decimal strings.
Bodies are at most 16384 UTF-8 bytes. Query parameters, additional fields,
caller principals/channels, ranges, arrays and standing rules are refused.
An arbitrary caller-generated request ID never prepares a mutation.

Only a live password-mode owner authenticated by password or passkey may
mutate. A signed delegated cookie remains insufficient. Proxy, tailscale and
local/no-auth identities remain read-only. These browser operations require
`application/json` and a present exact matching HTTP(S) `Origin`; fetch metadata
does not override a missing or foreign Origin. The host stamps the reviewer
and channel and binds the prepared body to the served database, principal,
authentication epoch, exact session generation and occurrence. The brain key
uses the existing host-seeded canonical-root partition identity, so two roots
sharing a UI database cannot commit or replay one another's prepared handles.
Live authority
is checked inside the acquired FULL writer transaction after queue/lock waits,
including for receipt replay, and again at response delivery. Retirement and
revocation take precedence over retry readback.

Success is `200` with `{version:1,receipt,currentProjection}`. `receipt` is the
immutable `SafetyReviewReceipt`: `version`, nullable `requestId`/`operationId`,
exact `session`/`occurrenceId`, `stage: prepared|verdict_committed|refused`,
`verdict: unresolved|committed`, nullable historical `projection` and nullable
`reason`. Refused receipts carry no historical normal projection.
`currentProjection` is a separate fresh aggregate, including local pending
input and recorder failure. For example, retrying A's committed receipt after
B and C arrive returns A's original fact alongside two unresolved occurrences;
it never rewrites that fact or clears B/C. The expected evidence revision is
the global history/review revision, separate from scoped admission revisions.

Nonfinalized, already-resolved, stale, conflicting or expired handles return
`409`; unknown/foreign/retired targets return non-disclosing `404`; authority
refusals return `403`, capacity or recording-failure receipts `503`. Refusals
include bounded `{code,reason,retryable:false}` beside the receipt response;
before a receipt exists only that error envelope is returned. Oversized bodies
return `413`, malformed bodies `400`, and non-JSON media types `415`. The
existing auth middleware retains its unauthenticated/expired-cookie `401`
envelope. Every route response is `Cache-Control: no-store`.

Handles expire after 900000 ms; terminal receipts retain their original result
for 86400000 ms after completion. Existing per-principal/brain request and
prepaid verdict bounds apply. The transport additionally allows at most 32
in-flight service requests per principal and 256 per brain. Canonical history
membership includes durably adopted provisional collections, with the same
principal, generation, finalized-exposure and permanent retirement fences in
the writer and SQLite trigger. Resolving a known event cannot repair unknown
detector coverage, recording loss or another unresolved event. No model/voice
tool, WS mutation frame, Settings rule or provider transcript edit is added.


The authenticated status response also includes `journalCleanup` (#3815):
current retained-checkpoint counts and bytes, plus `lastFailure`, a durable
historical cause even when cleanup failed before the first turn. The historical
record survives successful cleanup; current retained charges are reported
separately. It is never part of public `/health`.
