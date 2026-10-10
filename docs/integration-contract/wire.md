# Integration contract — Wire protocol

Authoritative component of the [integration contract](../integration-contract.md).
Its [shared scope and versioning policy](../integration-contract.md) apply to every section below.

<a id="revision-negotiation"></a>

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
See the [wire-protocol decision](../decisions/contract-versioning.md#wire-protocol-classification--2026-09-28).

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

<a id="server--client-frames"></a>

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

<a id="durable-queue-and-actions-additive"></a>

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
| `hygiene` | Finding/fingerprint-bound operation and optional confirmed input/preview; see [human review](package-api.md#human-started-hygiene-review-additive-1027) | v1, human coordinator only |
| `write_policy` | `policy { slug, content }` | Deferred v2 data only |
| `open_session` | `seed { prompt }` | Deferred v2 data only |

`V1ResolutionEffect` and `v1ResolutionEffectSchema` exclude both deferred
kinds. `resolutionEffectSchema` describes all seven kinds as data; it is not
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

Clients send `inbox_resolve { itemId, optionId, reason?, input? }` to select a stored
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
restart. See [the Action engine](../inbox-actions.md) for lifecycle details.
This behavior enables no unattended dispatcher, policy formation or session
creation; the full-v1 containment and system-proof gate remains required.

<a id="action-notices-additive-683"></a>

### Action notices (additive, #683)

Durable waiting decisions reach their recipients under the
[Action notification decision](../decisions/action-notifications.md); the
[inbox notifications guide](../inbox-notifications.md) describes the runtime.

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

<a id="activity-stream-rev-3-additive"></a>

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
([decisions/voice-permission.md](../decisions/voice-permission.md)), so a
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

<a id="classified-blocks-rev-4-additive"></a>

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

<a id="per-message-reasoning-effort-additive-543"></a>

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

<a id="message-source-additive-in-0390"></a>

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

<a id="local-exchanges-additive-in-0400"></a>

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

<a id="turn-failures-additive-in-0400"></a>

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

<a id="manual-retry-receipts-additive-in-0400"></a>

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

<a id="cross-backend-handoff-additive-61"></a>

### Cross-backend handoff (additive, #61)

A session never changes backend. Continuing it on another backend creates a
new linked session seeded with a reviewed summary and brain-file references
([decision](../decisions/session-handoff.md)).

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

<a id="unavailable-profiles-additive-1044"></a>

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
  reason ([decision](../decisions/session-handoff.md#profiles-that-cannot-run)).

<a id="tool-resolution-receipts-additive-957"></a>

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

<a id="live-conversation-additive-957"></a>

### Live conversation (additive, #957)

A separately registered live-conversation provider runs a bidirectional voice
session beside dictation, whose `SpeechProvider`, `AsrClient` and
`/api/voice/session` keep their meaning. The [decision](../decisions/live-conversation.md)
and [specification](../investigations/live-conversation-investigation.md) give the reasoning;
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
ordinary one ([voice posture](../decisions/voice-permission.md#the-voice-posture)).
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

<a id="interactive-answer-receipts-breaking-910"></a>

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
record is [answer-delivery.md](../decisions/answer-delivery.md).

<a id="session-drafts-additive-979"></a>

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
[HTTP API](../http-api.md#session-drafts-additive-979); the SDK publishes the
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

<a id="session-recovery-additive-964"></a>

### Session recovery (additive, #964)

A host that can account for its sessions' work sends
`server_hello.capabilities.sessionRecovery: true`
(`SESSION_RECOVERY_CAPABILITY`). Then `GET /api/sessions/:id/recovery`
answers with a `SessionRecovery` ([HTTP API](../http-api.md#session-recovery-additive-964)),
and its replayed history may carry an optional `SessionHistoryMessage.turnId`.
A client uses neither without the flag: an older host has no route, which a
client reads as `host_too_old`. Unrelated chat, approval and ask flows are
unchanged. The design is D52 §6 in
[decisions/design-kit.md](../decisions/design-kit/sessions-and-drafts.md#6-host-contracts-the-implementations-add).

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

<a id="pending-follow-ups-additive-1002"></a>

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

<a id="pill-labels-additive-1004"></a>

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
