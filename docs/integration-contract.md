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

## The Start card's persona choice (additive, 0.45.0, #3698)

In `@schlessera/brain-ui-react`, the conversation client's state adds
`personaChoice: ConversationPersonaRef | null`, and the client adds
`choosePersona(ref | null)`: the persona this entry's Start sends as
`personaRef` instead of the saved one, including the one-time
`{ id: "standard", revision: "builtin" }` and `voice: "default"` choices.
It saves nothing and is cleared on Enter and Leave. A first Start the host
refused, which opened nothing, may choose a service or persona again; a
`CONVERSATION_PERSONA_CHANGED` refusal clears the choice. No wire or HTTP
shape changes. See
[the package API](integration-contract/package-api.md#start-card-persona-choice-3698).
This ships in a minor.

## Host-owned web tools for Pi (additive, 0.45.0, #3685)

Pi's ordinary governed and strict interactive sessions gain four
host-executed bridge tools: `web_search`, `fetch_content`,
`get_search_content` and `source_check`. Their parameters are the pinned
upstream pi-web-access tools, narrowed: no field chooses an endpoint, proxy,
command, local path or credential, and `provider` is limited to the curated
catalog and to the subset the host admits. Deferred workflows (answer mode,
summaries, curator review, video) and the excluded credential modes answer
`unsupported`. Each result is one JSON envelope. A `responseId` is a host
handle scoped to the calling principal and session. No autonomous roster lists
the tools, and a host without a web executor refuses them before they run. The
SDK gains the tool contracts, `WebToolEnvelope`, `parseWebToolInput`,
`handleWebTool` and `BackendBridge.webAccess`. See
[the MCP component](integration-contract/mcp.md#host-owned-web-tools-additive-0450-3685)
and [the package component](integration-contract/package-api.md#host-owned-web-tools-additive-0450-3685).
This ships in a minor.

## Host web executor for Pi (additive, 0.45.0, #3686)

The four web tools now run on a host executor: the pinned upstream
`pi-web-access` 0.41.0 in a trusted Pi session, one child process per
principal's session, with provider configuration and keys on the host only.
Their names, inputs and envelopes are unchanged. `GET /api/web-search` gains
two fields. `unavailable` lists the features the host web tools do not
offer, each `{ id, label, kind }` with `kind` either `deferred` or
`excluded`. Each provider gains `keyIsCommand`, true when its stored key is a
`!command` credential, which the host never runs. Such a key no longer counts
as a credential, so it cannot enable a provider. `buildSystemPromptAppend`
accepts `webTools: true`, which adds the brief's line on what the web tools
do not offer. This ships in a minor.

## Retained barge-in and conversation end (additive, 0.45.0, #3729)

`DialogueEvidence` gains `voice_interruption`, written when the host forwards
a provider `interrupted` event (with its `outputId` when the provider named
one), and `voice_end`, written when the operator's final stop ends a
conversation (`startedAt`/`endedAt`, host clock milliseconds). Both are display
evidence on the existing dialogue write path and never enter provider history.
The React client draws the cut-off tag and the end divider only from them, so a
live chat and the same chat reloaded show the same marks. An earlier-minor
client refuses a page that carries the new kinds. See
[wire](integration-contract/wire.md#retained-barge-in-and-conversation-end-additive-0450-3729)
and [the package API](integration-contract/package-api.md#retained-dialogue-data-3177).
This ships in a minor; no breaking ruling is required.

## Live-conversation personas (additive, 0.45.0, #3617)

A persona is authored Markdown at `_voice/personas/<id>.md` in the brain: a
name, one voice per live service and plain-text speaking-style instructions.
Core excludes `_voice` from the content index by default
([configuration](configuration.md#exclude)). New owner-only routes read and
write personas with sha-256 revisions, and `GET/PUT /api/settings/voice`
carries the selection (`voice.live.persona`, its own revision) in the server
settings store, never in `brain.db`. `LiveConversationProvider` gains optional
`voices`, `defaultVoice` and `personaInstructionBytes`, mirrored on
`ConversationProfile` outside the disclosure a Start must echo;
`LiveConversationOpenOptions.persona` carries the persona frozen at Start.
`server_hello.livePersona` and the new `live_persona` frame describe the
selected persona to human sessions; `conversation_start.personaRef` echoes it,
with `voice: "default"` as the explicit one-time stale-voice override. A
conversation that sends no persona keeps exact current behaviour. See
[wire](integration-contract/wire.md#live-conversation-personas-additive-0450-3617),
[HTTP](integration-contract/http.md#live-conversation-personas-additive-0450-3617)
and [the package API](integration-contract/package-api.md#live-conversation-personas-additive-0450-3617).
This ships in a minor; no breaking ruling is required.

## Choosing the dictation provider in the app (additive, 0.45.0, #3709)

`openSettings("voice")` opens a new Settings › Voice pane, which holds the
brain-wide dictation default. `RecordingStore.transcribe` accepts an optional
provider id, sent as `Speech-Provider`; a retry refused for naming another
provider applies the returned receipt and rejects; a pre-claim refusal
carries the server's code as `code`. The kit `Composer` adds
`micTip?: boolean` and `micUnavailable?: string`. Existing calls behave as before, and no HTTP or protocol
shape changes. See
[the package API](integration-contract/package-api.md#dictation-speech-integration-and-conformance).
This ships in a minor.

## Choosing the live-conversation service (additive, 0.45.0, #3616)

`CreateAppOptions` adds `conversationProviders?: LiveConversationProvider[]` and
`defaultConversationProviderId?: string`; `conversationProvider` keeps meaning a
list of one, and both together, duplicate ids or an unregistered default fail
startup. `server_hello` adds `conversationProfiles` and `liveDefault`, and keeps
`conversationProfile` only while a service is effective (R1). A new
`live_settings` frame follows a save, `conversation_start` accepts an optional
`providerId` that must equal the disclosed one, and `conversation_opened` adds
`providerSource`. `GET`/`PUT /api/settings/voice`, shared with the persona
selection (#3617), add the top-level `defaultProvider`/`revision` pair for the
brain-wide default, each group with its own revision, and the route's writes
gain a new owner-only guard. The SDK exports `LiveDefault`,
`LiveProviderSource`, `ServerLiveSettings`, `VoiceLiveSettings`,
`VoiceLiveSettingsUpdate` and their schemas; the kit adds `LiveServiceSettings`.
In `@schlessera/brain-ui-react`, the conversation client's state adds
`conversationProfiles`, `liveDefault` and `serviceChoice`, the client adds
`chooseService(providerId | null)` for a one-time pick before Start, and the
REST client adds `liveSettings()` and `saveLiveSettings()`.
Single-provider hosts and existing clients keep their behaviour. See
[wire](integration-contract/wire.md#live-service-selection-additive-3616),
[HTTP](integration-contract/http.md#live-conversation-service-default-additive-3616)
and [the package API](integration-contract/package-api.md#live-service-registration-additive-3616).
This ships in a minor.

## Bounded multi-read (additive, 0.45.0, #3642)

A new read tool, `brain_read_many`, on the MCP server and the pi backend, and a
new command, `brain read-many --json`, all over one core operation. One call
reads up to 20 documents or sections and keeps its whole JSON answer within
`max_total_chars` (default 24,000, 2,000 to 40,000) and each item within
`max_item_chars` (default 8,000), counted as UTF-16 units of the serialized
JSON. Each item is `full`, `outline`, `partial`, `duplicate` or `error`, carries
its file's `sha256`, and says how to continue; invalid input is refused, never
clamped. `brain_read`, `brain_read_base` and every other tool and envelope are
unchanged. See [the MCP component](integration-contract/mcp.md#bounded-multi-read-additive-0450-3642)
and [the CLI component](integration-contract/cli.md). This ships in a minor; no
breaking ruling is required.

## Setup timeouts name their step (additive, 0.45.0, #3664)

A separate-UID worker launch that misses its identity readiness deadline still
refuses with `errorClass: "worker_host_unsupported"` and the requirement
`worker_identity_setup_timed_out`. That requirement now always carries a
parenthetical detail, which it never had before. The detail names the
supervisor's last recorded setup step, for example
`(step: launch-sent, ms: 312, sinceSpawnMs: 340)`. The steps are `started`,
`listening`, `launch-sent`, `launch-acked`, `status-read` and `mounts-acked`.
`step: none` means no step was recorded, and `step: refused (…)` means the record
was not read. Any launch stderr follows after `; `, within the existing 400-byte
detail. Requirement text is descriptive and other requirements already carry
such a detail, so no field, class or meaning changes. See
[wire](integration-contract/wire.md) and [the worker-host status](integration-contract/http.md).
This ships in a minor.

## Observed live content map (additive, 0.45.0, #3630)

`ConversationOrientation.knowledge[].topic` additionally accepts `content_map`:
an observed, explicitly partial map of existing root/top-level directory index
leads, never runtime taxonomy or instruction authority. Both first-party
profiles disclose this transfer at Start. Existing policy-held root anchoring,
authorization, whole-policy omission and startup byte ceilings apply. There is
no new frame, provider seam, automatic task or repository-config execution.
See [the package API](integration-contract/package-api.md#observed-live-content-map-additive-0450-3630),
[the disclosure amendment](integration-contract/wire.md#observed-content-map-disclosure-additive-3630)
and [source mapping and bounds](live-conversation-guidance.md). This ships in a minor.

## Refusals say why (additive, #3431)

A relayed provider request refused by the CLI provider relay keeps its `403`
and `error.type`, and the body gains `error.reason`: the turn egress proxy's
cause (`denied_host`, `not_allowlisted`, `byte_cap`, `taint_allowlist` or
`outward_not_approved`) for a request the proxy refused, otherwise the relay's
own refusal reason. `error.message` then states that cause in words. A proxy
refusal of worker HTTP or CONNECT traffic now carries a status text and body
naming its cause; neither is a contract shape. No governance event or reason
changes. See [the CLI component](integration-contract/cli.md#provider-relay-additive-0440-1673).
This ships in a minor; no breaking ruling is required.

## Tainted destinations ask (additive, #3430)

In a tainted interactive session behind the turn egress proxy, a connection to
a host outside the session's taint allow-list and contacted hosts raises the
existing tool-permission request (`toolName: "Network"`, `kind: "command"`)
instead of being refused at once. An allow admits that host for the rest of
the session. The request shape, the governance event kinds and the
`egress_denial` reasons are unchanged; `egress_connection` gains the `reason`
value `taint_not_approved` for a declined card. Voice and
autonomous turns keep refusing without a request. See the
[governance events component](integration-contract/http.md#tainted-destinations-ask-additive-3430)
and the [decision](decisions/governed-writable-workers.md#tainted-destinations-ask).

## Shell taint behind the egress proxy (breaking before 1.0, #3429)

On a turn whose worker runs behind the turn egress proxy
(`runtime.workerHost.governed.egress.active`), the `taint` governance event no
longer records `source: "fetching_command"` or `"unclassified_command"`. The
proxy's `egress_connection` taint, recorded at the first admitted connection
other than the inference relay, is the shell signal there. Every other source
keeps its meaning, and a turn without the proxy keeps the shell classifier.
Consumers must not expect a shell command alone to taint a proxied session; a
shell read of an untrusted file without a connection does not taint it. No
payload shape or kind changes. See the
[governance events component](integration-contract/http.md#shell-taint-behind-the-egress-proxy-breaking-3429)
and the [decision](decisions/governed-writable-workers.md#shell-classifier-off-behind-the-proxy).
This is a pre-1.0 breaking minor under the maintainer ruling recorded on #3429.

## Composer file attachments (additive, 0.45.0, #3153)

A host advertising `capabilities.composerFiles` stores composer originals
through `POST /api/drafts/:draftId/files` and reads them back through
`GET /api/attachments/:fileId`. Drafts bind them with `fileIds` and an
`outgoing` snapshot, and `chat_message.attachmentRefs` sends them. The agent
gets each original's read-only path in a quoted `<brain-attachments>` block;
contents are never injected. Every field is new and optional, and the existing
draft, share and track shapes keep their meaning. `maxDraftBytes` now bounds
text and legacy images only, as the maintainer's envelope ruling on #3153
directs. The new environment input is `BRAIN_UI_ATTACHMENT_POOL_BYTES`. See
[the wire component](integration-contract/wire.md#composer-file-attachments-additive-0450-3153),
[the HTTP API](http-api.md#composer-file-attachments-additive-0450-3153) and
[package API](integration-contract/package-api.md#composer-file-attachments-additive-0450-3153).
On such a host the React package uploads images as originals too and sends
each frame with `ChatImageAttachment.fileId` naming its original (#3155); a
legacy draft image and a host without the flag keep the inline-only path.

## Outgoing snapshot list (additive, 0.45.0, #3588)

A draft keeps up to 10 outgoing snapshots per chat instead of #3153's one
slot: `Draft.snapshots?` and `DraftSaveRequest.snapshots?`, each snapshot
`{ snapshotId, requestId, text, fileIds, state: "held" | "returned" |
"dispatched", createdAt }`, and `SessionDraftLimits.maxOutgoingSnapshots`.
The save that creates one is refused with the new 409 `DRAFT_OUTGOING_FULL`
when the chat is full; a delete that would drop a held or unconfirmed one is
the new 409 `DRAFT_OUTGOING_PENDING`. `Draft.outgoing` and the single-slot
write keep their shape and meaning for one held or unconfirmed send. The save
body bound rises from 512 KiB to 4,390,912 bytes to carry ten snapshot texts.
See [the wire component](integration-contract/wire.md#composer-file-attachments-additive-0450-3153)
and [the HTTP API](http-api.md#outgoing-snapshot-list-additive-0450-3588).

## Reading composer attachments on demand (additive, 0.45.0, #3154)

Both first-party backends gain one host-executed bridge tool, `read_attachment`
(`mcp__brain-ui__read_attachment` on Claude, the plain name on pi), in every
interactive session's fixed roster whether or not the session has
attachments. It reads one original that a message of the calling session was
sent: PDF text by page, at most 20 pages per call, or a text file by byte
range, at most 65,536 bytes per call and 262,144 per turn, with a `next`
cursor for the rest. Its result names its outcome (`read`, `partial`,
`no_text`, `encrypted`, `malformed`, `failed`, `unavailable`, `changed` or
`refused`) and exactly what it covers; contents are quoted as data. New
messages' `<brain-attachments>` block names the tool; messages recorded before
it keep their wording and still replay. The SDK gains the tool contract,
`AttachmentReadResult`, `handleReadAttachment`, `formatAttachmentRead` and
`BackendBridge.readAttachment`. Nothing else changes; a host without composer
files answers `unavailable`. See
[the MCP component](integration-contract/mcp.md#read_attachment-additive-0450-3154)
and [the package component](integration-contract/package-api.md#reading-composer-attachments-additive-0450-3154).
This ships in a minor.

## Attachment reads for sent rows (additive, 0.45.0, #3589)

A host with composer files advertises `server_hello.capabilities.attachmentReads`.
`GET /api/sessions/:id/attachment-reads` returns the recorded `read_attachment`
calls of the originals a session's messages name, as `{ fileId, turnId,
outcome, scope, at }` and never their text, under the session's existing
authorization. A read recorded during a live turn reaches the connections that
declared the same flag as one new `attachment_read` frame. `ServerMessage`
gains that variant; a client without the flag never receives it. Nothing of
either reaches a provider. See [the wire component](integration-contract/wire.md#attachment-reads-additive-0450-3589)
and [the HTTP API](http-api.md#attachment-reads-additive-0450-3589). This
ships in a minor. The SDK's `BrainUiClient` now declares the flag in its
`client_hello`, and the React package shows the records on sent rows (#3155).

## Outgoing snapshot bubbles (additive, 0.45.0, #3155)

`@schlessera/brain-ui-react` keeps each send as a durable outgoing snapshot
on a host with #3588's list, and draws held, returned and unconfirmed ones as
bubbles in the transcript. `BrainUiConnection.drafts` gains
`resendSnapshot(requestId)` and `sendPaused(draftId, snapshotId)`.
`@schlessera/brain-ui-kit`'s `StatusIndicatorProps` gains optional
`announce`; `false` drops the indicator's own live region. The `chat_message`
frame and every host route keep their shapes. See
[the wire component](integration-contract/wire.md#composer-file-attachments-additive-0450-3153)
and [the package component](integration-contract/package-api.md#outgoing-snapshot-bubbles-additive-0450-3155).
This ships in a minor.

## Composer draft indicator (additive, 0.45.0, #3155)

`@schlessera/brain-ui-kit`'s `ComposerProps` gains optional `status`, a
compact status beside the attach trigger. `@schlessera/brain-ui-react`'s
composer passes its draft indicator there, in place of the save line under
the field. `BrainUiConnection.drafts` gains `checkSave(draftId)`, a read-only
Check again for a draft save whose answer was lost. Every route and wire
frame keeps its shape. See
[the package component](integration-contract/package-api.md#composer-draft-indicator-additive-0450-3155).
This ships in a minor.

## Reading a chat deletion's outcome (additive, #3455)

`GET /api/chat-deletions/:operationId` ([HTTP](http-api.md#explicit-chat-deletion-additive-3230))
lets an owner who lost a deletion's reply read its current `ChatDeletionReceipt`
without re-admitting it. It only reads and adds no authority. Every miss is one
content-free 404 `ChatDeletionNotAdmitted` (`reason: "not_admitted"`): an
unknown operation, another principal's, a refused attempt, or a caller that cannot
own one. The SDK exports that type
([package API](integration-contract/package-api.md#reading-a-chat-deletions-outcome-additive-3455)).
`POST /api/chat-deletions` and the receipt are unchanged. This ships in a minor.

## Hosted external compute (additive, 0.45.0, #3108)

A hosted chat turn reaches external compute through six host-executed bridge
tools, `brain_compute_health` through `brain_compute_collect`
(`mcp__brain-ui__brain_compute_*` on Claude, plain names on pi), in every
interactive session's fixed roster. Their inputs and envelopes are those of
#3107's MCP tools; the host binds the caller, the turn's frozen policy, the
per-use approval card, the budget reservation and the credentials, and a
collect names no host path. Claude sessions disallow the in-worker
`mcp__brain__brain_compute_*` tools. `brain config check --json` gains a
`compute` summary. Activity gains the `compute` span origin, sent only to
clients declaring `capabilities.activityCompute`; governance events gain the
outward action `compute_run` and the taint source `compute_output`;
`/api/status` gains `runtime.compute`. The SDK gains the compute tool
contracts, `handleComputeTool` and `BackendBridge.compute`, and the server the
settings `BRAIN_UI_COMPUTE_KEYS` and `BRAIN_UI_COMPUTE_STATE_DIR`. Nothing
changes for a host or brain that does not configure compute. See
[the MCP component](integration-contract/mcp.md#external-compute-bridge-tools-additive-0450-3108),
[the package component](integration-contract/package-api.md#hosted-external-compute-additive-0450-3108),
[the wire component](integration-contract/wire.md#hosted-external-compute-additive-0450-3108),
[the HTTP component](integration-contract/http.md#governance-events-additive-1651)
and [the CLI component](integration-contract/cli.md). This ships in a minor;
no breaking ruling is required.

## External compute CLI and MCP tools (additive, 0.45.0, #3107)

`brain compute` gains the verbs `health`, `plan`, `run`, `status`, `cancel`,
`collect`, `abandon` and `reconcile`, and `brain mcp` six tools,
`brain_compute_health`, `brain_compute_plan`, `brain_compute_run`,
`brain_compute_status`, `brain_compute_cancel` and `brain_compute_collect`,
registered after the eight document tools whether or not `compute` is
configured. Both surfaces call one core operation set and print the same
envelopes: `{ ok: true, ... }`, or `{ ok: false, error: { code, message } }`
with the external-compute refusal codes and nothing allocated. A compute tool
whose operation throws returns a fixed tool error text and logs the details
on the server's stderr. A refusal exits
`1`, a `run` whose job ended with its cleanup not confirmed exits `2`, one
whose job ended other than `succeeded` exits `3`, and a second SIGINT or
SIGTERM leaves an attached run with `130` or `143`. The
`ComputeRunRequest` of the internal service gains an optional `retain`, which
may only narrow the instance's `retainOnRelease` (`retain: true` elsewhere is
`policy_denied`), and a retained job holds a concurrency slot until its
retention ends. A new
core skill, `external-compute`, is emitted by `brain skills sync`. Nothing
changes for existing commands, tools or envelopes, and a brain without
`compute` gets refusals only. See [the CLI component](integration-contract/cli.md#external-compute-additive-0450-3107)
and [the MCP component](integration-contract/mcp.md#external-compute-tools-additive-0450-3107).
This ships in a minor; no breaking ruling is required.

## Boat external compute provider (additive, 0.45.0, #3106)

The new lockstep package `@schlessera/brain-compute-boat` ships the `boat`
built-in: `computeProvider`, `defaultKeyEnv`, `BOAT_CAPABILITIES`,
`boatOptionsSchema`, `BoatOptions` and `BOAT_MACHINES`. Core declares it as an
optional peer and imports it only when a `compute.providers` instance names
`boat`; without it the instance stays `provider_unavailable`. Such an instance
reads `BRAIN_COMPUTE_BOAT_API_KEY` unless it names `apiKeyEnv`, and accepts
the options `machine`, `from`, `environment` and `org`. Nothing changes for a
brain that does not name `boat`. No CLI word, MCP tool or JSON shape is added.
See [the package component](integration-contract/package-api.md#boat-compute-provider-additive-3106)
and [configuration](configuration.md#boat). This ships in a minor; no breaking
ruling is required.

## External compute provider seam (additive, 0.45.0, #3105)

`ComputeProvider` becomes the thirteenth `@experimental` extension seam,
exported from `@schlessera/brain` with `defineComputeProvider` and the types it
is made of; `@schlessera/brain/testing` adds its provider and lifecycle
conformance suites. `brain.config` gains the optional `compute.providers` key,
and core reads two new optional environment inputs, `BRAIN_COMPUTE_STATE_DIR`
and `XDG_STATE_HOME`. Nothing changes for a brain without `compute`: no
provider, no network access, and compute operations refuse with
`compute_disabled`. No CLI word, MCP tool or JSON shape is added yet.
See [the package component](integration-contract/package-api.md#external-compute-seam-additive-3105)
and [the decision](decisions/external-compute.md). This ships in a minor; no
breaking ruling is required.

## Strictest path containment answers (breaking before 1.0, 0.45.0, #3422)

`safeResolve` and `resolveWritable` from `@schlessera/brain/module` now return
`null` in these cases:

- an absolute path, even inside the root;
- any `..` segment;
- `:` or `\` in a segment;
- a dangling symlink;
- a path any existing component of which leaves the root.

The CLI is not affected for paths inside the brain. Before calling them, it
converts an absolute path argument inside the brain (`--out`, document paths
and the other CLI path flags) to a brain-relative path, through the additive
`brainRelativeArgument` export. An absolute argument outside the brain is still
refused, and so is one through a symlink that leaves it. The maintainer rulings
are recorded [on the issue](https://github.com/schlessera/brain-kit/issues/3422#issuecomment-6599244174)
and, for the CLI, [on the PR](https://github.com/schlessera/brain-kit/pull/3465#issuecomment-6602766385). See [the package API component](integration-contract/package-api.md#strictest-path-containment-answers-breaking-before-10-0450-3422).
This ships in the 0.45.0 minor with the `breaking` label and a changeset that
names the break.

## Provider-relay requests and session taint (breaking before 1.0, #3246)

Under the [maintainer's option C](https://github.com/schlessera/brain-kit/issues/3246),
a validated request through the brain CLI's provider relay no longer taints a
governed session (G6), and a tainted session no longer narrows it with
`taint.egress.allow`. So `brain_context` reranking and WebFetch work in either
order. Before, whichever came first tainted the session, and the other then
failed with `taint_allowlist`. Reranking degraded with a `provider_unavailable`
event.

This changes documented taint-policy semantics. No configuration or wire
shape changes. A relayed request still records its own `egress_connection`,
never with `inference: true`. That record gains one additive field: the
optional `provider: true` literal, mirroring `inference: true` and set only
by a validated provider-relay operation
([governance events](http-api.md#governance-events-additive-1651)). A later turn excludes
those records when it rebuilds the session's contacted hosts, so a provider
request never lets worker `CONNECT` reach the provider's host after taint, in
the same turn or a later one. Records written before this field stay
unmarked. The relayed request is still refused by the
ordinary egress deny or allowlist rules, an unlisted origin, recipient or
route, the byte ceilings, budget stops and cancellation. Worker HTTP and
`CONNECT` traffic cannot claim the exemption, even to a provider's host, and
the operation grants that traffic no contacted host.

**Migration.** After untrusted input, taint alone no longer keeps content
from a session's approved providers. To fence a provider, use `egress.deny`,
an `allowlist` egress mode, or the exact origins in
`BRAIN_UI_CLI_PROVIDER_ORIGINS`. There is no new opt-out field. See
[the G6 ruling](decisions/governed-writable-workers.md#untrusted-input-g6) and
[supported inputs](supported-inputs.md).

## Module state area (additive, 0.45.0, #3380)

A module keeps durable state in `<brain>/.brain-ui/modules/<module-name>/`,
gitignored by the area's own `.gitignore`. Module commands get it as the new
optional `CommandContext.stateDir()`, and `@schlessera/brain/module` exports
`MODULE_STATE_DIR`, `moduleStatePath`, `moduleStateDir` and
`ModuleStateError`. A scheduled module job in a maintenance worker writes it
through the worker's data root, and output staging publishes it back after
each run. A module command's `EROFS` outside the brain now exits 2 with a
message naming the host execution boundary and the state area. See
[the package API component](integration-contract/package-api.md#module-state-area).

## Module discovery outcome at crontab emission (additive, 0.45.0, #3381)

`brain-ui-cron crontab` retries a failed module discovery a bounded number of
times, names each failed attempt's cause on stderr, and records the final
outcome as a finished `modules` job: one `cron_runs` row, so authenticated
`GET /api/status` lists it under `cronJobs`, and one `cron` root span in
Activity. A skipped module cron is an `error` whose reason starts
`module cron skipped:`; a successful discovery is a `success`. The crontab's
bytes do not change. See [wire semantics](integration-contract/wire.md#module-discovery-outcome-additive-0450-3381).
This ships in a minor; no breaking ruling is required.

## Turn timeouts and runtime stop notices (additive, 0.45.0, #3356)

A turn the host's hard elapsed-time limit ended stays `outcome: "cancelled"`,
and now says why: `result.outcomeDetail: "host_timeout"`
(`HOST_TIMEOUT_OUTCOME_DETAIL`), with `detail: "Turn timed out"` on its
`status: cancelled`. A replayed assistant message gains
`SessionHistoryMessage.runtimeNotice`, the agent runtime's own stop notice,
whose text is no longer replayed as the agent's `content`. No existing field
changes meaning; the limit and its configuration are unchanged. See
[wire](integration-contract/wire.md#turn-stops-additive-in-0450). The SDK
exports `HOST_TIMEOUT_OUTCOME_DETAIL` and `RuntimeNotice`; `@schlessera/brain-ui-react`
adds the optional `ChatMessage.runtimeNotice`/`runtimeNoticeLive`,
`AskUserExchange.endedBy`, `AnswerDelivery.sentAsMessage` and the `TurnNotice`
type. This ships in a minor; no breaking ruling is required.

## Apify settings, policy edits and spend for the owner (additive, 0.45.0, #3163)

Internal `GET /api/apify` ([inventory](http-api.md)) keeps every field it had
and adds two: `policy`, the effective `apify` block with each grant's
`active`, `expired` or `other_account` status and the policy's content hash,
and `spend`, this brain's ledger read (`absent`, `read` or `unavailable`, never
zero for an unread ledger), today's account-wide and brain scopes and the runs
whose charges are not final. `?session=&turn=` adds that turn's scope and
`?refresh=1` re-verifies the token and settles open runs first. Two internal
owner routes edit the policy from Settings through the existing policy-change
review: `POST /api/apify/policy` turns one change (`enabled`, `discovery`,
`actors` or `remove_grant`) against a named base hash into a pending
`PolicyChangeReview` of the complete proposed `governance.md` and writes
nothing; `POST /api/apify/policy/:turnId/:requestId` is the proposing owner's
one answer. Only an approval lets the existing policy writer publish, inside a
user journal window; a repeated or late answer returns the recorded receipt.
Agents get 403 on all four routes, no route accepts or returns a token, and the
shapes are typed as `ApifySettingsRead` and its parts in
`@schlessera/brain-ui-sdk/protocol`. It ships in a minor; no breaking ruling is
required.

## Apify enablement and host-owned authentication (additive, 0.45.0, #3159)

The governance policy accepts an optional strict `apify` block whose only field
is `enabled` (default `false`); `brain policy check --json` reports the resolved
`effective.apify` ([supported inputs](supported-inputs.md#governance-policy),
[CLI envelope](integration-contract/cli.md#governance-policy-check-additive-1650)).
The server reads `APIFY_TOKEN` as a host-only secret: no subprocess audience,
operator extra or per-spawn name admits it. While the policy leaves Apify
disabled the server contacts no Apify endpoint. When enabled it binds the
account `GET /v2/users/me` reports on the fixed API origin, sends the token
only as a bearer header, refuses redirects, and requires an owner to confirm a
token's different account. Internal `GET /api/apify` and `POST /api/apify/account`
([inventory](http-api.md)) report `disabled`, `authentication_required`,
`configured` or `unavailable` to live human owners and never return a token.
This adds no CLI command, MCP tool, wire frame or Actor execution; those follow
the [Apify contract](decisions/apify-capability.md). It ships in a minor; no
breaking ruling is required.

## Apify discovery and concrete Actor consent (additive, 0.45.0, #3160)

This is a pre-1.0 breaking minor under the maintainer ruling on #3580:
legacy exact-build grants stop authorizing runs, and profile/content restrictions
no longer gate Actor execution. Reapprove each Actor using the new Actor card.

The current [Actor approval decision](decisions/apify-actor-approval.md)
(#3580) revises the original #3160/#3161 qualification and consent model.
`apify.discovery` and `apify.actors` remain independent `deny`/`ask`/`allow`
modes. Discovery permission never authorizes a run. `actors: deny` refuses;
otherwise every Actor needs its own once/always/deny decision. Always is
scoped to brain, principal, bound Apify account and immutable Actor id,
across sessions, builds and inputs. Historical `actor_grants` policy entries
remain valid data but are not silently widened into Actor approvals.

Each proposal still binds the account generation, principal, session, turn,
policy, resolved build, schema/pricing fingerprints, input and cap. Those
facts are revalidated before dispatch, including after an approval. Each
proposal admits at most once. Generic tool grants authorize no Actor. The
`actor` approval kind carries the persistent choice separately from generic
tool permissions; discovery/inspection use per-use `command` cards.
Voice, autonomous and surfaceless calls cannot obtain a new approval.

## Apify spending limits and the run ledger (revised, #3580)

The strict `apify.limits` object retains
`{ run_usd, turn_usd, session_usd, day_usd, max_runs_per_turn, max_requests_per_turn, max_concurrent_runs, max_runtime_seconds, max_result_items, max_result_bytes, max_retention_seconds }`.
Absent limits admit no spending. Account-wide day and concurrency limits
span Actors, brains and principals using the same ledger. Turn/session/day
admission also counts inference. Every admitted run reserves its cap plus
estimated lifecycle requests, transfer and storage atomically before the
single start request. Estimates do not guarantee a final invoice; independently
billed platform activity can exceed estimates. Independent Console/other-app
activity is not attributed to these turns.

Actors no longer require a qualified profile or host-proven remote collection
methods. Input JSON objects pass through unchanged after credential-extraction
scanning; the host does not impose Actor schema field or output content
allowlists. Results remain paginated through the validated run's dataset,
under opaque session handles and request/retention limits. Legacy result
item/byte policy fields remain parseable but do not truncate Actor content.

Catalog-only API/transfer estimates also count in the shared ledger and
overall turn/session/day budgets before requests, even without an Actor run.

The ledger stays private operational state outside the brain. Unknown start
outcomes keep the reservation and are never automatically retried. Authenticated
`usageTotalUsd` supplies observed run cost when present; event counts/prices
are a fallback. Terminal cost reports remain provisional until observed again
at least ten seconds after first completion. Missing or unpriced reports
retain liability. Late observed amounts can raise liability; an abort never
zeroes a charge. The [CLI component](integration-contract/cli.md#actor-approval-revision-3580)
records current operation shapes and accounting coverage.

## Apify liability in the global turn budgets (additive, 0.45.0, #3307)

On a host that wires the Apify ledger into its turn budgets, each
`TurnBudgetReceipt` scope counts the Apify liability the ledger holds for that
turn, its conversation and this brain's UTC day once, as USD in `costUsd`,
and reports it in a new optional `apifyUsd`. Admission, mid-turn stops, the
relay's refusals and the SDK backstop all read the same total. `TurnBudgetCoverage`
gains two values: one naming the Apify runs this host admitted, and one saying
Apify accounting was unavailable, so Apify spend is not counted (never zero).
A host without the ledger keeps the existing value. Apify admission reads
inference without its own liability, so neither side counts it twice. See
[the wire component](integration-contract/wire.md#completed-inference-usage-and-budgets-additive-1669).
It ships in a minor; no breaking ruling is required, under the same reading as
#1673's coverage change.

## Apify operations through the CLI, MCP and both chat backends (additive, 0.45.0, #3162)

Ten fixed operations reach Apify, each with one strict input schema shared
by every front door: `discover`, `inspect`, `prepare`, `run`, `status`,
`results`, `abort`, `availability`, `approvals` and `revoke`. `brain apify <operation> --json`
([CLI component](integration-contract/cli.md#apify-operations-additive-0450-3162)),
the core MCP server's `brain_apify_<operation>` tools and both first-party
backends' bridge tools of the same names
([MCP component](integration-contract/mcp.md#apify-tools-additive-0450-3162))
validate the same input and call the same consent, reservation and request
functions, so no transport has a second consent, account or billing path.
Each returns one envelope, `{ ok: true, operation, data }` or
`{ ok: false, operation, error: { code, reason, message } }`. `code` is one of
the contract's `provider_disabled`, `authentication_required`,
`policy_denied`, `approval_required`, `proposal_stale`, `actor_unsupported`,
`budget_exceeded`, `accounting_unavailable`, `result_expired`,
`remote_outcome_unknown` and `upstream_incompatible`, or one of two additive
codes: `provider_unavailable` (the Apify API could not be reached or verified;
nothing was admitted) and `invalid_input` (the operation's own checks refused
the input before anything was sent). Messages are fixed text; no token or
upstream text reaches an envelope.

Candidate, proposal, run and cursor references are opaque and bound to their
brain, principal and session; a proposal also to its turn. Discovered Actor
schemas are data: choosing an Actor never adds or removes a tool, and the
roster is fixed for a session. `data` is the model view only: candidate
summaries and inspected facts (both marked `untrusted: true`), a proposal and
its review, a run's lifecycle state, one bounded page of results, an abort
outcome. Accounting stays with the host.

Both backends forward to the host, which builds each call's context from the
authenticated turn and holds the credential and the ledger. The tools are in
every interactive session's fixed roster and auto-allowed: the host asks per
exact use. Voice, no-grant-surface and restricted autonomous turns keep their
existing memberships: their rosters or availability checks refuse the tools,
and the host refuses a non-interactive turn with `policy_denied`. Inference spend reaches admission without Apify's own liability, and the
host's turn budgets count that liability from the same ledger (#3307); a run
is therefore refused as `accounting_unavailable` (`session_unbound`) until the
conversation is named, so its liability can be attributed. A
cancelled, timed-out or budget-stopped turn aborts the runs it started. The
first untrusted Apify text in a session records its taint with the new source
`apify_result` ([governance events](http-api.md)).

A standalone `brain apify` or `brain mcp` process uses its own `APIFY_TOKEN`
and the shared ledger named by the new `BRAIN_APIFY_LEDGER`
([supported inputs](supported-inputs.md)); the server opens the same variable,
defaulting to `DB_PATH.apify-ledger.sqlite`. Without the ledger every
standalone operation refuses as `accounting_unavailable`. Nobody can be asked
there: a run needs a remembered Actor approval for its principal, else `approval_required`. Neither
variable reaches any worker. This adds no wire frame or HTTP route. It ships
in a minor; no breaking ruling is required.

## Explicit local chat deletion (additive, #3230)

An authenticated owner can delete its own chat's local history with
`POST /api/chat-deletions` ([HTTP](http-api.md#explicit-chat-deletion-additive-3230)),
on a host that sends `server_hello.capabilities.chatDeletion: true`. The answer
is a content-free `ChatDeletionReceipt` with per-store outcomes and the always
retained categories. Capable clients of the same owner receive the new
`chat_retired` frame ([wire](integration-contract/wire.md#explicit-chat-deletion-additive-3230)).
A deleted chat is absent from `GET /api/sessions`, `GET /api/sessions/:id`
(404 `SESSION_NOT_FOUND`), recovery, resume and live startup; draft routes add
410 `DRAFT_CHAT_RETIRED`. The SDK exports the request, receipt, frame, capability
and schema ([package API](integration-contract/package-api.md#explicit-chat-deletion-additive-3230)).
No existing field, frame or route changes meaning for an undeleted chat. This
ships in a minor; the [approved policy](decisions/chat-history-deletion.md) is the
explicit retention exception, and no breaking ruling is required.

## Typed chat owner bindings (additive, #3337)

A typed chat whose backend session an authenticated request created now records
that principal as its owner, so `POST /api/chat-deletions` accepts it from that
owner ([HTTP](http-api.md#explicit-chat-deletion-additive-3230)). Chats created
before the binding still refuse as `unavailable`. Foreign callers get the same
answer as for a chat that does not exist. The session catalog's
`persistSessionStub` gains an optional `ownerPrincipalId`
([package API](integration-contract/package-api.md#typed-chat-owner-bindings-additive-3337)).
No request, receipt, frame or field shape changes, and paging and retention of
undeleted chats are unchanged. This ships in a minor.

## Native history removal (additive, #3229)

`BackendCapabilities.historyRemoval?` and the optional
`AgentBackend.removeSessionHistory?()` let a host remove one explicitly retired
chat's locally owned native history, with content-free `removed`, `partial`
and `unknown` outcomes. A backend that does not advertise and implement both is
unsupported, and deletion refuses before retirement. The first-party Claude and
Pi backends implement it. No wire frame, HTTP route, CLI `--json` shape or MCP
tool changes; the deletion endpoint is not part of this change. See
[the package component](integration-contract/package-api.md#native-history-removal-additive-3229).
This ships in a minor; no breaking ruling is required.

## Maintenance worker output allowance (additive, 0.45.0, #3357)

A maintenance worker's launcher may declare its output stage's size and setting
in `BRAIN_WORKER_OUTPUT_ALLOWANCE`. A `brain maintain` git step that runs out of
space then names that limit, its bytes, the setting and the starting headroom;
without it, the same refusal names the headroom alone. No JSON shape changes.
See [the CLI component](integration-contract/cli.md#maintenance-worker-output-allowance-additive-0450-3357).
This ships in a minor; no breaking ruling is required.

## Agent runner unavailable in maintenance workers (additive, 0.45.0, #3243)

A credential-free maintenance worker's launcher sets
`BRAIN_AGENT_RUNNER_UNAVAILABLE=1`. Bare `brain sync` there hands nothing to
an agent: it reports the existing `agent.reason` `no-runner`, keeps `run`'s
exit code, and names the manual resolution on stderr. No JSON shape changes.
A failed `claude` runner's error now keeps its stderr beside its result text.
See [the CLI component](integration-contract/cli.md#agent-runner-unavailable-in-a-maintenance-worker-additive-0450-3243).
This ships in a minor; no breaking ruling is required.

## Bounded storage failure settlement (additive, #3185)

The server exports `StorageSettlementIndeterminate` for bounded caller waits
whose real cleanup remains owned; app close monitors native storage requests
throughout its cleanup FIFO while preserving CLI grace/protected writers and
Activity's genuine failure identity.
The additive `DIALOGUE_INDETERMINATE` diagnostic stops the failed live epoch
without claiming a timed-out write was saved, unsaved or cancelled. No frame
shape changes. See [package lifecycle](integration-contract/package-api.md#indeterminate-storage-settlement-3185),
[wire semantics](integration-contract/wire.md) and
[writer ownership](decisions/sqlite-write-worker.md#bounded-caller-waits-retain-real-cleanup-ownership-3185).
This ships in a minor; no new breaking ruling is required.

## Existing-chat live context and Start admission (breaking before 1.0, 0.44.0, #3178)

The parent-directed [privacy correction](https://github.com/schlessera/brain-kit/issues/3178#issuecomment-6536350935)
requires explicit Start before any vendor startup or history transfer. Optional
`server_hello.conversationProfile` exposes known provider/capability/disclosure
metadata without opening a provider. Start echoes it in
`conversation_start.disclosed`; missing/mismatched echoes refuse before recovery,
takeover or history reads. This intentionally breaks undisclosed legacy starts
in a pre-1.0 minor; a new client cannot offer voice on a host without the profile.
It is not backward-compatible admission. Enter and Cancel stay local.

`LiveConversationOpenOptions.history` and its exported historical-data types
carry an optional authorized, frozen chat snapshot, separately from native
same-conversation resync. `LiveConversationSession.historyCoverage` and
`conversation_opened.historyCoverage` optionally report the actual startup
selection's `state` (`complete`, `bounded`, `partial`, `unavailable`) and
`tailOmitted`, plus, additively (#3699), `includedMessages`: the number of
prior chat and spoken messages actually sent. This is data receipt/selection evidence, never a guarantee of
semantic recall. See the [package API](integration-contract/package-api.md#existing-chat-live-context-3178)
and [wire behavior](integration-contract/wire.md#existing-chat-live-context-3178).

Additive (#3623): optional startup brain orientation, selected configured
backend guidance and exact contextual task progress are inventoried in the
[package API](integration-contract/package-api.md#live-brain-orientation-and-task-status-additive-3623).
First-party disclosure now names the extra startup source categories under
the existing exact Start echo; no new frame or permission grant is added.
See [source selection and behavior](live-conversation-guidance.md) and the
[wire amendment](integration-contract/wire.md#live-orientation-disclosure-and-progress-additive-3623).

## Continuous conversation (breaking, #3053)

The October 29 [maintainer policy](decisions/live-conversation.md#continuous-conversation-and-audible-recovery--2026-10-29)
replaces the documented capture-off/explicit-Resume behavior for routine
interruption and recoverable lifecycle transitions. Manual Mute/Leave, scope,
authentication and genuine failure fences remain. Output cut/recovery is separate
from microphone intent and host-work cancellation. This is a pre-1.0 breaking
minor; consumers must no longer interpret Stop reply or reconnect as microphone
revocation. No frame shape changes. See the [client contract](integration-contract/wire.md#shipped-conversation-client-960)
for bounded recovery, delayed-output limitations and remaining qualification.

## Live task policy parity (breaking, #3070/#3071)

Live-conversation host work now uses the same ordinary backend/session/principal
policy as typed work, including session preference, permitted writes, screen
confirmation cards and supported recovery. It no longer implicitly requests the
narrower voice allowlist or no-grant surface. Speech cannot grant permission.
Explicit restricted backend requests retain their enforcement or safe refusal.
This is a pre-1.0 breaking minor under the
[maintainer ruling](https://github.com/schlessera/brain-kit/issues/3070#issuecomment-6457436905);
see [wire execution](integration-contract/wire.md#live-conversation-additive-957).
Automatic task admission/native binding and Gemini continuity remain separate
#3070/#3064 work; this slice does not claim that end-to-end experience.

## Content CLI minimum correction (patch, #1623)

ui-server requires a content CLI of at least 0.41.0, the first release containing
all commands and flags its existing features invoke. A detected CLI below 0.41.0
refuses startup with the required version and an instruction to update the
content repository's `@schlessera/brain` pin and lockfile before deploying the
server. The existing unknown-version policy and stricter host minimum
composition remain as specified in [runtime requirements](decisions/runtime-requirements.md).

This is a patch compatibility correction to the existing version gate: the
previous 0.33.0 floor admitted combinations that could not execute the shipped
hygiene review. The exported `MIN_BRAIN_CLI_VERSION` value reflects that
correction; no CLI, MCP or HTTP field, input shape or interpretation changes. It is neither an
additive contract feature nor a breaking field/meaning change under the rules
above: the newly refused combination already lacked required capabilities. The
server's command/flag inventory checks its floor against recorded CLI availability
versions.

## Retained scratch links (additive, 0.42.0, #1656)

Scratch prune accepts pin snapshots and reports pinned files and remaining overage,
as specified in the [CLI contract](integration-contract/cli.md). ui-server now
requires a content CLI of at least 0.42.0 for `scratch prune --pins-file`.
This supersedes the 0.41.0 floor above for the new server; earlier hygiene
commands retain their original availability versions.

## Index directory (breaking, 0.44.0, #1668)

The disposable index moves from `<brain>/brain.db` into its own directory:
`<brain>/.brain-index/brain.db`, with every SQLite sidecar (`-wal`, `-shm`,
`-journal`) and the `index --embeddings` lock database beside it. A direct SQL
reader opens the new path; the [index read contract](integration-contract/frontmatter.md#braindb-direct-sql-reads)
states it. The schema, `schema_version` and every CLI, MCP and HTTP shape are
unchanged; no `--json` field carries the path.

The maintainer ruled this layout on #1668 (option B, 2026-10-22): a directory can
be retained and replaced as a whole inside a worker's mount namespace, where a
file mask over a root-level `brain.db` detaches when another writer unlinks or
renames it. Under the binding rule that `brain.db` is disposable, an existing
brain migrates by rebuilding, never by moving: the first writable command
creates `.brain-index/` and `brain index` fills it. The old root-level files are
ignored. `brain doctor` reports them as `legacy-index` and `--fix` deletes
them; ui-server deletes them at boot and starts one index run. The 0.44.0
release raises ui-server's content CLI floor to 0.44.0, superseding the 0.42.0
floor above: an older CLI would keep writing the root-level index the server no
longer reads. The template ignores `.brain-index/`; its existing unanchored
`brain.db*` line already matches the new files.

## Deferred application indexing (breaking, 0.44.0, #2835)

A hosted application (`brain_add`, `brain_update`, `brain_archive`,
`write_file`, `edit_file`, `apply_staged_changes`) no longer re-indexes the brain
before it returns. Its Markdown commits durably as before; the result reports
`indexed: false` with the additive `indexStatus: "pending"`, and `indexed: true`
only ever means a completed update. Changed paths are batched into one targeted
update, in the isolated maintenance worker, at the next index-dependent read or
turn end; every such reader, including pi's in-worker search and the host's
HTTP index routes, waits for it, and a failed update refuses the read rather
than serve a stale index. The [application contract](integration-contract/mcp.md),
[HTTP routes](integration-contract/http.md#index-reads-wait-for-applications-2835)
and [package API](integration-contract/package-api.md) state the lifecycle.

This is breaking: the value of `indexed` on a successful application changes
from `true` to `false` while its update is queued. The maintainer ruled it on
#2835 (2026-10-24, options A and C combined, with the pending result and
deferred failure delivery separately approved). `brain add --json` in the
standalone CLI keeps its synchronous `indexed` meaning.

## Metadata-only index history (breaking, 0.44.0, #2873)

The turn journal records the brain's disposable index family
(`.brain-index/brain.db`, its SQLite sidecars, the embeddings lock database
`.brain-index/brain.db.embedding-lock.db` and its sidecars, and an index
publication copy) by path, size and change stamp only. Its versions carry the additive
`JournalVersion.metadataOnly: true` and `stamp`, and no content hash; they
cannot be previewed, downloaded or restored, and history revert excludes them
as `metadata_only`. Earlier retained index versions are presented the same way.
All other paths keep their retained bytes. The
[HTTP contract](integration-contract/http.md#metadata-only-index-history-breaking-2873)
states the presentation and the
[turn scope counter](integration-contract/wire.md#turn-scope-additive-1670) its
accounting.

This is breaking: index versions were byte-retained and restorable before. The
maintainer ruled it on #2873 (2026-10-25, option B), and on its confirmation
(#2903) added the embeddings lock to the family and had the bytes earlier
releases retained for these versions purged: the first journal open after the
upgrade rewrites those versions to metadata-only entries and removes their
objects, except an object another record also names. Their history rows
stay.

## Provider folder turns (additive, 0.44.0, #1668)

A governance policy's `providers` rules now take effect in hosted interactive,
voice and autonomous turns (autonomous from #2691), as specified under
[supported inputs](supported-inputs.md#governance-policy). Every literal
`folder/**` root is masked, `.git` is hidden, and the turn gets a private
filtered `.brain-index/`. A rule that also selects a document type, a
non-literal glob or a single path refuses turn admission by name. Since #2694
(additive, 0.44.0) a `folder/**/*` path and a document type that maps exactly
onto folders are masked the same way; every other such selector still refuses,
naming why ([which selectors](supported-inputs.md#governance-policy)). Since
#2700 (additive, 0.44.0) admission also refuses, naming them, regular files
outside the masked folders that are hardlinks to files inside them. No schema,
CLI `--json` shape, MCP tool or HTTP route changes; `brain index` without
`--embeddings` now runs where only `.brain-index/` is writable.

Additive (#2690): host bridge tools refuse a masked path for such a turn.
`brain_read_base`, share completion, image masks, `inbox_add` and policy proposals fail with
an error whose message starts `provider_masked:`; the application tools return
`{ ok: false, code: "provider_masked" }` with no change. Each refused call
records one `provider_mask_refusal` [governance event](integration-contract/http.md#governance-events-additive-1651)
(`tool`, `path`, `rule`, `policyHash`).

Additive (#2698): for such a turn `query_activity` (every scope), `inbox_list`
and `inbox_get` are refused whole, before any record is read, with an error
whose message starts `provider_masked: <tool> is unavailable to this turn`.
The activity record and inbox items keep free text from earlier runs that may
quote a masked document. The tools stay registered with the same names and
schemas; a turn without masked folders and the owner's UI read them as before.
No governance event is recorded for these refusals.

Additive (#2741, maintainer ruling C): an autonomous turn whose provider rules
mask a folder starts only when host provenance shows every item and checkpoint
of its origin thread was written without those folders: a person's arrival
through the authenticated share or queue route (bound to the staged bytes
intake read), server-composed text, or an autonomous run that masked them, as
its budget reservation records. Otherwise it refuses before its prompt is
built or any provider is reached, with an error whose message starts
`provider_masked: inbox thread <id> is unavailable to this autonomous turn`;
the run's activity record keeps that reason as its failure reason. Its
`inbox_list` and `inbox_get` revalidate the same evidence and the policy hash
in the read's transaction and refuse with the same message otherwise. Legacy
threads, items a conversation added through `inbox_add` without a
qualifying lineage (below), and any thread changed incompatibly or under a
changed policy are refused, not assumed compatible. Refused work stays stored and queued (retried with backoff, then
dead-lettered as any failed attempt), never completed, rewritten or moved to
another provider. Tool names, schemas and refusal codes are unchanged; turns
without masked folders are unaffected.

Additive (#2816): an item a hosted conversation adds through `inbox_add`
qualifies when that conversation's born-masked lineage (#2726) hid every
folder the autonomous turn masks, from every one of its turns up to the one
that added it, as the host recorded it. Items from a pre-policy, legacy,
record-less conversation, or one whose lineage an unmasked or allowed-route
turn narrowed so it no longer covers those folders, are still refused with
the same message. Tool names, schemas,
refusal codes and the `inbox_add` result are unchanged.

## Protected taxonomy code (breaking, 0.44.0, #2699)

A `types:` provider selector now translates only from a taxonomy read where
the brain shows nothing but the policy's protected paths, as specified under
[supported inputs](supported-inputs.md#governance-policy). A configuration
whose taxonomy loads a helper, local module, CLI script or other file outside
those paths, a policy releasing `brain.config.ts`, `brain.config.json`,
`package.json`, `bun.lock` or `node_modules`, a brain whose only CLI is its
own fallback script, a taxonomy that changes when only the protected paths
are visible, a protected name that an unreconciled governed turn created, and
a brain path that is not canonical now refuse every type selector with
`ProviderPolicyRefusedError` in hosted and autonomous turns. Each refusal
names the reason. Adding the files the configuration loads or reads to the
policy's `protect` list restores translation, except for the fallback
script, which needs the packaged CLI. This is breaking: such configurations
translated before. The
maintainer ruled it on #2699 (2026-10-24, option B, restriction approved). The
internal `WorkerProviderMasks` gains optional `visible`. No schema, CLI
`--json` shape, MCP tool or HTTP route changes.

## Separate-UID provider folder turns (additive, 0.44.0, #2696)

The host identity helper protocol (`--brain-worker-identity-v1`) gains a
`view` operation and an optional `view` launch field, specified with the
[host protocol](hosting/agent-workers.md#separate-worker-identity). The
server uses them to qualify a separate-UID governed worker's mounted provider
folders and private index before its payload starts. Other launches do not
send the field. A helper without the operation refuses provider-folder turns
before payload start, as before; nothing else changes.

## Allowed provider recipients (additive, 0.44.0, #2695)

A hosted turn whose recipient a `providers` rule allows now sees that rule's
folders, as specified under
[supported inputs](supported-inputs.md#governance-policy). The recipient is
named only from the exact origin the turn's host inference relay forwards to:
a built-in vendor origin, or one the new server variable
`BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS` (`name=origin[,origin];name=origin`)
names. Every other turn keeps the masks. A conversation that showed folders to
one recipient refuses a later turn, or a handoff, whose recipient may not see
them, with `ProviderRecipientRefusedError`. The optional
[`AgentBackend.inferenceOrigin`](integration-contract/package-api.md#inference-recipient-origin-additive-2695)
supplies the origin. No schema, CLI `--json` shape, MCP tool or HTTP route
changes.

## Provider-denied auto-memory and continuation (availability, 0.44.0, #2726)

A hosted interactive or voice turn whose admitted masks hide at least one
provider folder no longer receives the brain project's saved Claude
auto-memory (`memory/`), and saves no note to it, new or replacing. It
continues an existing conversation, or the source of a handoff, only when the
server's lineage proves every folder it masks was masked from every turn of
that conversation since it began; a fresh conversation born under the masks
qualifies, and its later turns narrow what it qualifies for. Every other
continuation is refused before any history is copied or sent, in the existing
turn error envelope. Unless the earlier `ProviderRecipientRefusedError` (#2695)
applies first, the refusal is `ProviderContinuationRefusedError`; its message
starts `This turn cannot start: the governance policy's provider rules
hide` and ends with `Start a new conversation; the saved one is kept
unchanged.` A `handoff_prepare` for such a chat fails in the existing
`handoff_draft` envelope, as it does whenever the policy has a type selector. Saved memory and transcripts stay byte-identical.
The lineage is host-internal (migration 064); no schema, CLI `--json` shape,
MCP tool, wire frame or HTTP route changes. This is a maintainer-ruled
availability reduction for provider-denied turns, recorded in the
[G2 decision](decisions/governed-writable-workers.md#data-to-provider-routing-g2).

## Generated-text cache directory (breaking, 0.44.0, #2725)

The two committed generated-text caches move from the brain root into one
directory: `.context-cache.jsonl` becomes `.brain-cache/contexts.jsonl` and
`.asset-cache.jsonl` becomes `.brain-cache/assets.jsonl`. Their line format,
key rules and append-only semantics are unchanged, as specified under
[committed sidecars](integration-contract/frontmatter.md); no CLI `--json`
shape, MCP tool, wire frame or HTTP route changes. `brain doctor` gains the
additive `legacy-caches` check.

The maintainer ruled this layout on #2692 (option B, 2026-10-23, deferred until
allowed routes existed; #2695 delivered them). Like the index directory above,
a directory can be retained and masked whole inside a worker's mount
namespace, where a file mask over a root-level cache detaches when another
writer renames or unlinks it. The caches hold paid enrichment, so an existing
clone migrates by moving lines, never by regenerating them:

- **Reads** union the new file with a root-level legacy file not yet moved,
  so nothing is lost before the move and a read-only brain still sees every
  entry.
- **The move.** Every index run that writes or prunes the caches, and `brain
  doctor --fix`, first moves each legacy root-level file: the new file becomes
  the sorted union of both files' distinct lines (a key both hold resolves as a
  union merge of them would, first line in sorted order), then the legacy file
  is deleted. The new file is published whole by rename, and the legacy file
  is deleted only once every line it holds is in the new one, so an
  interrupted move leaves both intact and the next run finishes it; a file
  that cannot be read is never deleted. Repeating it changes nothing. A brain
  the run cannot write is left as it is. ui-server starts one index run at boot
  when a legacy file is present.
- **Committed paths and union attributes.** The move deletes the legacy
  tracked paths and adds the new ones; `brain sync` commits both as derived
  caches. The template's `.gitattributes` carries `merge=union` for the two new
  paths, and `brain doctor --fix` (`cache-merge`) appends them to a brain that
  lacks them. Existing `merge=union` lines for the legacy names are kept: an
  older clone still writes those names. `brain sync pull` unions a legacy
  file it merges in (including a modify/delete conflict against the move),
  and when the commits it brought in touched a legacy name it moves that file
  into `.brain-cache/` in the same pull, before any later step can stop.
- **Hosted turns.** Every governed writer retains `.brain-cache/` beside
  `.brain-index/` while provider folders exist, and the host creates it before
  admission. A turn that masks any provider folder sees it as an empty
  read-only folder; a turn allowed every provider folder sees the real one. A
  legacy root-level cache keeps its `/dev/null` file mask on every turn under a
  provider rule, allowed or denied, for as long as a clone can hold one. No
  index run from 0.44.0 on writes the legacy names; the only release code that
  writes one is `brain sync pull`'s union, which the same pull then moves, so a
  hosted sync never publishes one into the live brain. ui-server's 0.44.0
  content CLI floor (see the index directory above) keeps an older CLI from
  writing them there.

## Authoritative surfaces

- [Package API and extensions](integration-contract/package-api.md).
- [CLI](integration-contract/cli.md).
- [Diagram spec v1, check, export/build, hygiene, geometry and additive positional families](integration-contract/diagrams.md).
- [Governance policy check](integration-contract/cli.md#governance-policy-check-additive-1650)
  and [governance policy schema v1](supported-inputs.md#governance-policy) are
  additive supported inputs and output in 0.42.0 (#1650).
- [Frontmatter, files and index reads](integration-contract/frontmatter.md).
- [MCP tools](integration-contract/mcp.md).
- [HTTP routes](integration-contract/http.md).
- [Wire protocol](integration-contract/wire.md).

## Original section map

Presentation-only split from `1a8ba321e7f578baebb55f13532e773c543cf793`.
Every original heading below points to its unchanged section. The introductory
policy stays here; rules, examples, amendments and evidence move with their sections.
Original fragment identities remain available at this entry point.

<a id="package-entry-points"></a>

- [Package entry points](integration-contract/package-api.md#package-entry-points) (original line 23).

<a id="explicit-autonomous-backend-turns-675"></a>

- [Explicit autonomous backend turns (#675)](integration-contract/package-api.md#explicit-autonomous-backend-turns-675) (original line 174).

<a id="autonomous-admission-configuration-additive-678"></a>

- [Autonomous admission configuration (additive, #678)](integration-contract/package-api.md#autonomous-admission-configuration-additive-678) (original line 200).

<a id="restricted-autonomous-containment-additive-676"></a>

- [Restricted autonomous containment (additive, #676)](integration-contract/package-api.md#restricted-autonomous-containment-additive-676) (original line 219).

<a id="interactive-priority-and-cooperative-autonomous-yield-additive-687"></a>

- [Interactive priority and cooperative autonomous yield (additive, #687)](integration-contract/package-api.md#interactive-priority-and-cooperative-autonomous-yield-additive-687) (original line 242).

<a id="operational-recovery-command-additive-686"></a>

- [Operational recovery command (additive, #686)](integration-contract/cli.md#operational-recovery-command-additive-686) (original line 277).

<a id="rail-acts-and-all-commands-additive-944"></a>

- [Rail acts and All commands (additive, #944)](integration-contract/package-api.md#rail-acts-and-all-commands-additive-944) (original line 336).

<a id="working-sessions-and-the-shared-composer-row-additive-949"></a>

- [Working sessions and the shared composer row (additive, #949)](integration-contract/package-api.md#working-sessions-and-the-shared-composer-row-additive-949) (original line 349).

<a id="runtime-approval-composition-additive-1141"></a>

- [Runtime approval composition (additive, #1141)](integration-contract/package-api.md#runtime-approval-composition-additive-1141) (original line 367).

<a id="search-result-cards-additive-1138"></a>

- [Search result cards (additive, #1138)](integration-contract/package-api.md#search-result-cards-additive-1138) (original line 379).

<a id="streaming-waiting-status-approved-pre-10-break-1144"></a>

- [Streaming waiting status (approved pre-1.0 break, #1144)](integration-contract/package-api.md#streaming-waiting-status-approved-pre-10-break-1144) (original line 397).

<a id="exec-wrapper-in-app-configuration-additive-1363"></a>

- [Exec wrapper in app configuration (additive, #1363)](integration-contract/package-api.md#exec-wrapper-in-app-configuration-additive-1363) (original line 410).
- [Backend host exec configuration (additive, #1429)](integration-contract/package-api.md#backend-host-exec-configuration-additive-1429).

<a id="logo-assets-additive-1424-1425"></a>

- [Logo assets (additive, #1424, #1425)](integration-contract/package-api.md#logo-assets-additive-1424-1425) (original line 424).

<a id="logo-in-the-empty-state-additive-1426"></a>

- [Logo in the empty state (additive, #1426)](integration-contract/package-api.md#logo-in-the-empty-state-additive-1426) (original line 453).

<a id="turn-temp-promotion-additive-1655"></a>

- [Turn-temp promotion (additive, #1655)](integration-contract/package-api.md#turn-temp-promotion-additive-1655).

<a id="consumers"></a>

- [Consumers](integration-contract/package-api.md#consumers) (original line 460).

<a id="model-reranker-activation"></a>

- [Model reranker activation](integration-contract/package-api.md#model-reranker-activation) (original line 468).

<a id="travel-ownership-and-canonical-content"></a>

- [Travel ownership and canonical content](integration-contract/frontmatter.md#travel-ownership-and-canonical-content) (original line 498).

<a id="travel-photo-copies"></a>

- [Travel photo copies](integration-contract/frontmatter.md#travel-photo-copies) (original line 543).

<a id="travel-registries"></a>

- [Travel registries](integration-contract/frontmatter.md#travel-registries) (original line 601).

<a id="asynchronous-ui-startup"></a>

- [Asynchronous UI startup](integration-contract/package-api.md#asynchronous-ui-startup) (original line 622).

<a id="html-renderer-budgets"></a>

- [HTML renderer budgets](integration-contract/package-api.md#html-renderer-budgets) (original line 672).

<a id="cli-conventions"></a>

- [CLI conventions](integration-contract/cli.md#cli-conventions) (original line 716).

<a id="stable---json-shapes"></a>

- [Stable --json shapes](integration-contract/cli.md#stable---json-shapes) (original line 732).

<a id="auditissue"></a>

- [AuditIssue](integration-contract/cli.md#auditissue) (original line 813).

<a id="brain-eval---json"></a>

- [brain eval --json](integration-contract/cli.md#brain-eval---json) (original line 886).

<a id="brain-index-counters"></a>

- [brain index counters](integration-contract/cli.md#brain-index-counters) (original line 1064).

<a id="embedding-eligibility-and-coverage-semantics"></a>

- [Embedding eligibility and coverage semantics](integration-contract/cli.md#embedding-eligibility-and-coverage-semantics) (original line 1168).

<a id="recorded-corpus-trend-verdicts-additive-in-0400"></a>

- [Recorded corpus trend verdicts (additive in 0.40.0)](integration-contract/cli.md#recorded-corpus-trend-verdicts-additive-in-0400) (original line 1197).

<a id="stats-history-additive-in-0400"></a>

- [Stats history (additive in 0.40.0)](integration-contract/cli.md#stats-history-additive-in-0400) (original line 1263).

<a id="browser-scraping-navigation-policy"></a>

- [Browser scraping navigation policy](integration-contract/package-api.md#browser-scraping-navigation-policy) (original line 1396).

<a id="mcp-server-stdio-brain-mcp-or-srcmcp-serverts"></a>

- [MCP server (stdio, brain mcp or src/mcp-server.ts)](integration-contract/mcp.md#mcp-server-stdio-brain-mcp-or-srcmcp-serverts) (original line 1435).

<a id="hosted-authoritative-application-tools"></a>

- [Hosted authoritative application tools](integration-contract/mcp.md#hosted-authoritative-application-tools) (original line 1488).

<a id="hosted-png-mask-application-additive-1037"></a>

- [Hosted PNG mask application (additive, #1037)](integration-contract/mcp.md#hosted-png-mask-application-additive-1037) (original line 1560).

<a id="chat-ui-in-process-tools-mcp__brain-ui__"></a>

- [Chat-UI in-process tools (mcp__brain-ui__*)](integration-contract/mcp.md#chat-ui-in-process-tools-mcp__brain-ui__) (original line 1594).

<a id="tool-component-contracts"></a>

- [Tool component contracts](integration-contract/mcp.md#tool-component-contracts) (original line 1621).

<a id="ask_user_form-additive-in-0400"></a>

- [ask_user_form (additive in 0.40.0)](integration-contract/mcp.md#ask_user_form-additive-in-0400) (original line 1637).

<a id="ask_user_rank-additive-in-0400"></a>

- [ask_user_rank (additive in 0.40.0)](integration-contract/mcp.md#ask_user_rank-additive-in-0400) (original line 1694).

<a id="ask_user_list-additive-in-0400"></a>

- [ask_user_list (additive in 0.40.0)](integration-contract/mcp.md#ask_user_list-additive-in-0400) (original line 1726).

<a id="ui-server-http-routes"></a>

- [ui-server HTTP routes](integration-contract/http.md#ui-server-http-routes) (original line 1943).

<a id="degraded-backend-availability-and-unknown-expiry-additive-3817"></a>

- [Degraded backend availability and unknown expiry (additive, #3817)](integration-contract/http.md#degraded-backend-availability-and-unknown-expiry-additive-3817).

<a id="published-react-health-and-sync-helpers-breaking-health-correction"></a>

- [Published React health and sync helpers (breaking health correction)](integration-contract/http.md#published-react-health-and-sync-helpers-breaking-health-correction) (original line 1964).

<a id="typed-status-software-identity-additive-598"></a>

- [Typed status software identity (additive, #598)](integration-contract/http.md#typed-status-software-identity-additive-598) (original line 1986).

<a id="worker-host-status-additive-1632"></a>

- [Worker host status (additive, #1632)](integration-contract/http.md#worker-host-status-additive-1632).

- [Interactive main-model identity (additive, #2037)](integration-contract/package-api.md#interactive-main-model-identity-additive-2037).

<a id="governance-events-additive-1651"></a>

- [Governance events (additive, #1651)](integration-contract/http.md#governance-events-additive-1651).

<a id="root-server-warning-additive-1638"></a>

- [Root server warning (additive, #1638)](integration-contract/http.md#root-server-warning-additive-1638).

<a id="governed-availability-additive-1648"></a>

- [Governed availability and host execution (additive, #1648)](integration-contract/http.md#governed-availability-additive-1648).

<a id="internal-queue-poke-additive"></a>

- [Internal Queue poke (additive)](integration-contract/http.md#internal-queue-poke-additive) (original line 1998).

<a id="interactive-html-preview-additive-1084"></a>

- [Interactive HTML preview (additive, #1084)](integration-contract/http.md#interactive-html-preview-additive-1084) (original line 2010).

<a id="account-partition-key-additive-1014"></a>

- [Account partition key (additive, #1014)](integration-contract/http.md#account-partition-key-additive-1014) (original line 2027).

<a id="corpus-stats-history-get-apibrainstatshistory-additive-in-0400"></a>

- [Corpus stats history (GET /api/brain/stats/history, additive in 0.40.0)](integration-contract/http.md#corpus-stats-history-get-apibrainstatshistory-additive-in-0400) (original line 2060).

<a id="runtime-stats-get-apiactivitystats-additive-in-0370"></a>

- [Runtime stats (GET /api/activity/stats, additive in 0.37.0)](integration-contract/http.md#runtime-stats-get-apiactivitystats-additive-in-0370) (original line 2068).

<a id="content-index-query-api"></a>

- [Content-index query API](integration-contract/package-api.md#content-index-query-api) (original line 2146).

<a id="ui-server-optional-core-peer-breaking-host-migration-697"></a>

- [UI server optional core peer (breaking host migration, #697)](integration-contract/package-api.md#ui-server-optional-core-peer-breaking-host-migration-697) (original line 2188).

<a id="braindb-direct-sql-reads"></a>

- [brain.db (direct SQL reads)](integration-contract/frontmatter.md#braindb-direct-sql-reads) (original line 2249).

<a id="revision-negotiation"></a>

- [Revision negotiation](integration-contract/wire.md#revision-negotiation) (original line 2335).

<a id="server--client-frames"></a>

- [Server → client frames](integration-contract/wire.md#server--client-frames) (original line 2380).

<a id="durable-queue-and-actions-additive"></a>

- [Durable Queue and Actions (additive)](integration-contract/wire.md#durable-queue-and-actions-additive) (original line 2399).

<a id="action-notices-additive-683"></a>

- [Action notices (additive, #683)](integration-contract/wire.md#action-notices-additive-683) (original line 2533).

<a id="activity-stream-rev-3-additive"></a>

- [Activity stream (rev 3, additive)](integration-contract/wire.md#activity-stream-rev-3-additive) (original line 2583).

<a id="classified-blocks-rev-4-additive"></a>

- [Classified blocks (rev 4, additive)](integration-contract/wire.md#classified-blocks-rev-4-additive) (original line 2653).

<a id="promoted-links-additive-1698"></a>

- [Promoted links (additive, #1698)](integration-contract/wire.md#promoted-links-additive-1698).

<a id="per-message-reasoning-effort-additive-543"></a>

- [Per-message reasoning effort (additive, #543)](integration-contract/wire.md#per-message-reasoning-effort-additive-543) (original line 2689).

<a id="message-source-additive-in-0390"></a>

- [Message source (additive in 0.39.0)](integration-contract/wire.md#message-source-additive-in-0390) (original line 2741).

<a id="local-exchanges-additive-in-0400"></a>

- [Local exchanges (additive in 0.40.0)](integration-contract/wire.md#local-exchanges-additive-in-0400) (original line 2762).

<a id="turn-failures-additive-in-0400"></a>

- [Turn failures (additive in 0.40.0)](integration-contract/wire.md#turn-failures-additive-in-0400) (original line 2803).

<a id="manual-retry-receipts-additive-in-0400"></a>

- [Manual retry receipts (additive in 0.40.0)](integration-contract/wire.md#manual-retry-receipts-additive-in-0400) (original line 2880).

<a id="cross-backend-handoff-additive-61"></a>

- [Session handoff (additive, #61, #1621)](integration-contract/wire.md#cross-backend-handoff-additive-61) (original line 2919).

<a id="unavailable-profiles-additive-1044"></a>

- [Unavailable profiles (additive, #1044)](integration-contract/wire.md#unavailable-profiles-additive-1044) (original line 2991).

<a id="tool-resolution-receipts-additive-957"></a>

- [Tool resolution receipts (additive, #957)](integration-contract/wire.md#tool-resolution-receipts-additive-957) (original line 3020).

<a id="live-conversation-additive-957"></a>

- [Live conversation (additive, #957)](integration-contract/wire.md#live-conversation-additive-957) (original line 3055).

<a id="interactive-answer-receipts-breaking-910"></a>

- [Interactive answer receipts (breaking, #910)](integration-contract/wire.md#interactive-answer-receipts-breaking-910) (original line 3243).

<a id="session-drafts-additive-979"></a>

- [Session drafts (additive, #979)](integration-contract/wire.md#session-drafts-additive-979) (original line 3345).

<a id="session-recovery-additive-964"></a>

- [Session recovery (additive, #964)](integration-contract/wire.md#session-recovery-additive-964) (original line 3414).

<a id="pending-follow-ups-additive-1002"></a>

- [Pending follow-ups (additive, #1002)](integration-contract/wire.md#pending-follow-ups-additive-1002) (original line 3507).

<a id="pill-labels-additive-1004"></a>

- [Pill labels (additive, #1004)](integration-contract/wire.md#pill-labels-additive-1004) (original line 3552).

<a id="file-layer-contracts"></a>

- [File-layer contracts](integration-contract/frontmatter.md#file-layer-contracts) (original line 3618).

<a id="extension-interfaces"></a>

- [Extension interfaces](integration-contract/package-api.md#extension-interfaces) (original line 3718).

<a id="dictation-speech-integration-and-conformance"></a>

- [Dictation speech integration and conformance](integration-contract/package-api.md#dictation-speech-integration-and-conformance) (original line 3755).

<a id="saved-audio-transcription-additive-1021"></a>

- [Saved-audio transcription (additive, #1021)](integration-contract/package-api.md#saved-audio-transcription-additive-1021) (original line 3800).

<a id="siteadapter-conformance-and-migration"></a>

- [SiteAdapter conformance and migration](integration-contract/package-api.md#siteadapter-conformance-and-migration) (original line 3907).

<a id="agentbackend-conformance-baseline"></a>

- [AgentBackend conformance baseline](integration-contract/package-api.md#agentbackend-conformance-baseline) (original line 3946).

<a id="hygiene-review-data-additive-1024"></a>

- [Hygiene review data (additive, #1024)](integration-contract/package-api.md#hygiene-review-data-additive-1024) (original line 4011).

<a id="hygiene-selection-additive-1026"></a>

- [Hygiene selection (additive, #1026)](integration-contract/package-api.md#hygiene-selection-additive-1026) (original line 4038).

<a id="module-hygiene-context-breaking-699"></a>

- [Module hygiene context (breaking, #699)](integration-contract/package-api.md#module-hygiene-context-breaking-699) (original line 4126).

<a id="module-dormancy-additive-527"></a>

- [Module dormancy (additive, #527)](integration-contract/package-api.md#module-dormancy-additive-527) (original line 4154).

<a id="module-settings-additive-528"></a>

- [Module settings (additive, #528)](integration-contract/package-api.md#module-settings-additive-528) (original line 4198).

<a id="module-tools"></a>

- [Module tools](integration-contract/mcp.md#module-tools) (original line 4278).

<a id="first-party-module-tools"></a>

- [First-party module tools](integration-contract/mcp.md#first-party-module-tools) (original line 4354).

<a id="guarantees-consumers-may-rely-on"></a>

- [Guarantees consumers may rely on](integration-contract/package-api.md#guarantees-consumers-may-rely-on) (original line 4381).

<a id="recommended-consumer-hygiene"></a>

- [Recommended consumer hygiene](integration-contract/package-api.md#recommended-consumer-hygiene) (original line 4406).

<a id="configuration-exclusions"></a>

- [Configuration exclusions](integration-contract/package-api.md#configuration-exclusions) (original line 4412).

<a id="backend-confirmation-pattern-initialization"></a>

- [Backend confirmation-pattern initialization](integration-contract/package-api.md#backend-confirmation-pattern-initialization) (original line 4427).

<a id="nullable-asset-enrichment"></a>

- [Nullable asset enrichment](integration-contract/package-api.md#nullable-asset-enrichment) (original line 4443).

<a id="backend-authoring-permission-toolkit"></a>

- [Backend-authoring permission toolkit](integration-contract/package-api.md#backend-authoring-permission-toolkit) (original line 4472).

<a id="durable-share-and-cli-intake-additive-679"></a>

- [Durable share and CLI intake (additive, #679)](integration-contract/cli.md#durable-share-and-cli-intake-additive-679) (original line 4528).

<a id="shared-geo-library-additive-525"></a>

- [Shared geo library (additive, #525)](integration-contract/package-api.md#shared-geo-library-additive-525) (original line 4575).

<a id="shared-geo-configuration-and-server-geocoding"></a>

- [Shared geo configuration and server geocoding](integration-contract/package-api.md#shared-geo-configuration-and-server-geocoding) (original line 4648).

<a id="shared-routing-results"></a>

- [Shared routing results](integration-contract/package-api.md#shared-routing-results) (original line 4687).

<a id="shared-overpass-poi-results"></a>

- [Shared Overpass POI results](integration-contract/package-api.md#shared-overpass-poi-results) (original line 4719).

<a id="shared-background-geometry-and-sdk-adapters"></a>

- [Shared background geometry and SDK adapters](integration-contract/package-api.md#shared-background-geometry-and-sdk-adapters) (original line 4757).

<a id="canonical-consumer-configuration"></a>

- [Canonical consumer configuration](integration-contract/package-api.md#canonical-consumer-configuration) (original line 4797).

<a id="local-vector-static-maps"></a>

- [Local vector static maps](integration-contract/package-api.md#local-vector-static-maps) (original line 4823).

<a id="geo-cli-envelopes"></a>

- [Geo CLI envelopes](integration-contract/package-api.md#geo-cli-envelopes) (original line 4872).

<a id="imported-track-files-in-chat-additive"></a>

- [Imported track files in chat (additive)](integration-contract/package-api.md#imported-track-files-in-chat-additive) (original line 4916).

<a id="pi-native-endpoint-routing-breaking-routing-migration-762"></a>

- [Pi native endpoint routing (breaking routing migration, #762)](integration-contract/package-api.md#pi-native-endpoint-routing-breaking-routing-migration-762) (original line 5043).

<a id="scheduled-tasks-additive-914"></a>

- [Scheduled tasks (additive, #914)](integration-contract/package-api.md#scheduled-tasks-additive-914) (original line 5074).

<a id="scheduled-task-contract-preparation-913"></a>

- [Scheduled-task contract preparation (#913)](integration-contract/package-api.md#scheduled-task-contract-preparation-913) (original line 5186).

<a id="shared-definition-and-response-types"></a>

- [Shared definition and response types](integration-contract/package-api.md#shared-definition-and-response-types) (original line 5199).

<a id="approval-endpoints-and-receipts"></a>

- [Approval, endpoints and receipts](integration-contract/package-api.md#approval-endpoints-and-receipts) (original line 5366).

<a id="cli-and-tool-mapping"></a>

- [CLI and tool mapping](integration-contract/package-api.md#cli-and-tool-mapping) (original line 5427).

<a id="activity-notification-and-recovery-compatibility"></a>

- [Activity, notification and recovery compatibility](integration-contract/package-api.md#activity-notification-and-recovery-compatibility) (original line 5679).

<a id="video-watching-opt-in-module"></a>

- [Video watching (opt-in module)](integration-contract/package-api.md#video-watching-opt-in-module) (original line 5700).

<a id="bounded-hygiene-repair-operations-additive-1025"></a>

- [Bounded hygiene repair operations (additive, #1025)](integration-contract/package-api.md#bounded-hygiene-repair-operations-additive-1025) (original line 5723).

<a id="human-started-hygiene-review-additive-1027"></a>

- [Human-started hygiene review (additive, #1027)](integration-contract/package-api.md#human-started-hygiene-review-additive-1027) (original line 5795).

## Per-turn prompt-cache diagnostics (additive, #2050)

Activity run detail and runtime stats gain [cache diagnostics](integration-contract/http.md#prompt-cache-diagnostics-additive-2050).
The backend side channel gains hash-only assembled-prefix and first-main-request
receipts, documented in the [package API](integration-contract/package-api.md#prompt-cache-diagnostic-events-additive-2050).

### Static content exports

`brain render` replaces configured active module fences having a static entry with its scriptless, resource-free output, always with `theme: "print"`, including HTML. Browser-only entries remain code. Failure or unsafe static output retains the original fence and adds a fence-named string to the existing `warnings` envelope. Local markdown SVG images are embedded only after brain containment and static-resource validation.

`POST /api/render` applies the same print conversion using trusted build-bundled static registrations filtered by active configured module declarations; content-repository export specifiers are metadata and never imported by the server. Browser-only entries must already have been prepared by the client. Diagnostics use the URI-encoded JSON `X-Brain-Render-Warnings` header (at most 3500 encoded characters, messages truncated to 200 characters), with `X-Brain-Render-Warnings-Truncated: true` when findings were omitted. The binary response and request schema are unchanged.

- [Content renderer bootstrap declarations (additive, #2087)](integration-contract/http.md#content-renderer-bootstrap-declarations-additive-2087).
- [Deployment renderer registration (additive, #2087)](integration-contract/package-api.md#deployment-renderer-registration-additive-2087).


## External persisted Claude memory history (additive, #1658)

External native-memory saves join the existing retained steering history and
authenticated recovery routes with an explicit logical scope, described in
[the HTTP contract](integration-contract/http.md#persisted-claude-auto-memory-history-additive-1658).
The host-only copy-out callback is described in
[the package API](integration-contract/package-api.md#native-persisted-claude-memory-observation-additive-1658).

## Managed reference worktree history (additive, #2430)

Intentional edits to managed reference worktrees join the existing retained
journal with an explicit logical scope and path, described in
[the HTTP contract](integration-contract/http.md#managed-reference-worktree-history-additive-2430).

## Reference pool storage (additive, #2428)

The host-only `brain-native-store` configuration gains an optional separate
reference pool volume, and the launcher gains a deterministic `pool`
status/recovery/release projection, described in
[the package API](integration-contract/package-api.md#reference-pool-storage-additive-2428).

## Reference-source grants (additive, #2429)

Owner-managed grant records are the only authority for private reference
acquisition. Three password-owner routes under `/api/auth/principals/:id/`
create, list and revoke them, described in
[the HTTP contract](integration-contract/http.md#reference-source-grants-additive-2429).

## Reference publication (additive, #2429)

The native manager client and lease owner gain `poolPublish`/`poolUnpublish`/`poolWithdraw`,
which publish sealed reference roots into per-domain view directories, and
`NativePoolRecord` gains `view`; described in
[the package API](integration-contract/package-api.md#reference-publication-additive-2429).

## Reference source acquisition (additive, #2429)

`ServerConfig` gains optional `referenceSource` clocks and admission, resolved
from three documented environment inputs; described in
[the package API](integration-contract/package-api.md#reference-source-acquisition-additive-2429).

## Managed worktree storage (additive, #2430)

The native manager client and lease owner gain worktree checkpoints, deltas and
fixed-reader checkpoint reads, plus access generations that move a writable
worktree into or out of one worker-bound directory; `NativePoolRecord` gains
the `checkpoint` purpose and `access`. Described in
[the package API](integration-contract/package-api.md#managed-worktree-storage-additive-2430).

## Diff-assisted propagation freshness review (additive, 0.45.0, #3452)

Optional canonical `hygiene.propagation` configuration authorizes bounded JEV
currency review with source diffs, user-selected confidence floors and veto-only
cross-checks. Automation is off by default; opted-in review defaults to the
balanced profile (0.7 floor with both cross-checks). Separate Markdown judgment receipts can
suppress a propagation finding without changing content-edit dates; all changed
or unavailable evidence returns to review. `brain hygiene propagation --json`
adds inspectable dry-run/judgment/sensitivity output, and enabled reconciliation
adds an optional `propagation` report. Scope/reference frontmatter and rule scope
are additive inputs. See [CLI](integration-contract/cli.md#propagation-freshness-additive-0450-3452),
[file semantics](integration-contract/frontmatter.md#propagation-freshness-additive-0450-3452)
and [configuration](configuration.md#hygienepropagation). Hosted scheduling has
a separate operator opt-in; existing interactive hygiene stays credential-free.
This ships in a minor; existing dates, CLI fields and provider activation retain
their meaning. No breaking ruling is required.

## Managed worktree hygiene review (additive, #2431)

The human-started hygiene review (`/api/hygiene/review`) also selects host-only
`managed-worktree` findings, with a `delete-worktree` repair revalidated by the
worktree service before it removes anything; described in
[the package API](integration-contract/package-api.md#managed-worktree-findings-in-the-review-additive-0440-2431).

## Owner-only private worktree details (additive, 0.44.0, #2734)

The review read gains a per-request `privateDetailAccess`, and
`GET /api/hygiene/review/details/:itemId` returns a private worktree finding's
recorded facts to the owner principal only; `HygieneCard` gains a `details`
slot. Described in
[the package API](integration-contract/package-api.md#owner-only-private-worktree-details-additive-0440-2734).

## Hygiene card caller copy (additive, 0.44.0, #2837)

`HygieneCard` gains optional inert `stateText` and `busyLabel` copy that keeps
every file default when omitted; the hygiene review uses it for managed-worktree
findings. Described in
[the package API](integration-contract/package-api.md#hygiene-card-caller-copy-additive-0440-2837).


## Reference and worktree tools (additive, 0.44.0, #2432)

Both backends gain the bridge tools `reference_source` and `reference_worktree`,
described in
[the MCP contract](integration-contract/mcp.md#reference-source-and-managed-worktree-tools-additive-0440-2432).
Their shared contracts, `BackendBridge.referenceAccess`, the native manager's
`poolView` and the worker's read-only source views are described in
[the package API](integration-contract/package-api.md#reference-and-worktree-tools-additive-0440-2432).

## Durable live dialogue (breaking retention supersession, #3177)

The October 30 maintainer ruling replaces temporary recognition/no-reload
semantics with chat-owned retained text evidence. Draft Discard does not erase
archived discussion. Optional negotiated history paging/provenance fields are
additive; the retention/privacy meaning change is a pre-1.0 breaking minor.
See [durable dialogue](integration-contract/wire.md#durable-live-dialogue-breaking-retention-supersession-3177).
Historical provider input remains separate #3178 work.
