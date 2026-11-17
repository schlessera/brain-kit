# Google Workspace: Gmail, Calendar, Contacts and Tasks

Design for giving a brain governed access to Gmail and Google Calendar first,
then Google Contacts and Google Tasks. Nothing here is built. The open work is
in two epics: [Gmail (#4201)](https://github.com/schlessera/brain-kit/issues/4201),
which also builds the shared foundation, and
[Calendar (#4220)](https://github.com/schlessera/brain-kit/issues/4220), which
depends on it. Contacts and Tasks reuse the same foundation and are
sketched in [later services](#13-later-services-contacts-and-tasks) so the
foundation does not exclude them.

The plan exists because the work spans `brain-common`, `brain-ui-sdk`,
`brain-ui-server`, both backends, `brain-ui-kit`, `brain-ui-react` and the core
CLI. The units have a required order, and an approval layer built on the wrong
effect model would have to be rebuilt for every later service.

## 1. Outcome

A hosted chat turn can search and read your mail, triage it, prepare drafts,
and send a message after you approve it. It can read your calendars, find free
time, create events, and invite people after you approve it. The credential
stays with the host. The worker never holds it, cannot read it and cannot
reach Google as you except through a host tool.

Every operation carries one of three **effect classes**. The governance policy
decides per class, per operation and per entity whether a call is refused,
asked for or admitted:

| Effect class | Meaning | Gmail example | Calendar example |
| --- | --- | --- | --- |
| `read` | Changes nothing at Google. | Search, read a thread | List events, free/busy |
| `reversible` | Changes only your own account, is invisible to anyone else, and brain-kit records an inverse it can execute to restore the prior state. | Create or edit a brain-made draft, archive, label, mark read, star | Create an event without guests on a calendar verified private |
| `irreversible` | Visible to someone else, destroys data brain-kit cannot restore, or anything the classifier does not recognise. | Send, delete a draft, trash (until its inverse is proven) | Invite guests, RSVP, change or cancel an event with guests |

The class belongs to **a call**, not a tool: the same tool can be reversible
for one input and irreversible for another (an event with and without guests).
The host computes it from the validated input and from facts it reads itself,
and it can only escalate, never relax.

Reads come in two **views**, and the difference decides taint (§6):

| View | Carries | Taints |
| --- | --- | --- |
| `structured` | Only host-validated typed values: Google-minted Gmail ids, label ids and the owner's label names, host-minted handles for calendar objects and page cursors, timestamps, counts, size buckets, flags, enums, free/busy intervals. No text a third party wrote. | No |
| `content` | Anything else: subjects, names, addresses, snippets, bodies, event titles, descriptions, locations, attendees. | Yes (`google_result`) |

So a turn can find mail by a query it wrote, get the matching ids, and archive
them, without ever reading text an attacker could have written, and without
the session becoming tainted.

Reversibility decides what *can* be admitted without a card and what the
journal can undo. It never grants authority on its own
([voice-permission.md](../decisions/voice-permission.md): reversibility neither
grants authority nor guarantees every effect can be undone).

## 2. What binds this design

- **Host tools, not a relayed CLI.** The [host GitHub tools
  ruling](../decisions/governed-writable-workers.md) (2026-11-09, #3791) is the
  model: a fixed set of host MCP tools, a dedicated host-only credential with no
  fallback, reads tainting the session before the model sees them, writes
  behind a policy allow-list and one exact-payload card per use, voice never
  approving, autonomous turns with no write surface.
- **G5 and G6.** Mail and calendar effects are outward
  (`MCP tools whose descriptors declare an external effect`, `governed-writable-workers.md:4086-4087`);
  an outward action raises a card unless a rule lists it
  (`An outward action raises the existing approval card`, `governed-writable-workers.md:4090-4091`)
  and is journaled as irreversible
  (`Each outward action is recorded with its attribution`, `governed-writable-workers.md:4103-4104`);
  and a tainted session asks for every outward action even when a rule allows it
  (`every outward action asks, even if`, `governed-writable-workers.md:4318`).
  This plan amends both, narrowly, by the maintainer's 2026-11-17 ruling (§14):
  structured reads do not taint, and own-account reversible Google writes are a
  separate class with their own rules. Everything else applies as written.
- **Operations live once, in common.** The [Apify front-door
  ruling](../decisions/apify-capability.md#front-doors-and-memberships-3162)
  puts operations, codecs and validated shapes in
  `@schlessera/brain-common/internal/apify`, because the UI server reaches core
  only as an optional peer. CLI and hosted bridge validate the same schemas and
  call the same functions. No new package, module, registry, plugin framework
  or daemon.
- **Per-entity approval.** The [Actor-approval
  ruling](../decisions/apify-actor-approval.md) is the precedent for "approve
  once / approve always / deny" scoped to (principal, brain, account, entity),
  kept in trusted host storage, listable and revocable.
- **The roster never depends on configuration.** Host tools are in every
  interactive roster and decide availability at call time
  (`tool list never depends on configuration (provider-history.md)`, `packages/ui-backend-claude/src/sdk-options.ts:52`;
  `Never in an autonomous roster`, `sdk-options.ts:606-611`); provider
  history is append-only ([provider-history.md](../decisions/provider-history.md)).
- **Every bridge tool is always loaded** ([D44](../decisions/design-kit/tool-loading.md)):
  deferral was measured to cost more than it saves.
- **Session-safety coverage** ([session-safety-reviews.md](../decisions/session-safety-reviews.md)):
  coverage is per-epoch detector acknowledgement, and every safety occurrence
  without a verdict restricts (`const aggregate=one`, `packages/ui-server/src/governance/safety-store.ts:477-484`).
  So a structured read records no occurrence: the collector's obligation for
  the call is discharged with nothing to record, as for any result with nothing
  to record. A content read records `google_result` taint (§6).
- **Proportionate containment** ([proportionate-containment.md](../decisions/proportionate-containment.md)).
  A missing or unpinned gog, an unsafe credential home or an incompatible
  version disables the Google tools and says why; it never stops the host.
- **No new seams.** The transport boundary in §8 is internal and unexported. It
  exists for tests and because a second implementation (direct REST) is
  plausible within a year. It is not an extension interface.
- **No agent writes policy** ([policy-write-boundary.md](../decisions/policy-write-boundary.md)).
- **Skills orchestrate, the CLI executes.** In a hosted turn skills use the host
  tools; a worker's `brain google` has no credential. Standalone skills use
  `brain google … --json`.
- **Odysseus is the only fixture world** ([example-corpus.md](../decisions/example-corpus.md)):
  the established cast on `example.com`, the pinned `2026-07-12` date, no real
  data. The live check in §11 prints key paths, never values.

## 3. Architecture

```
                   hosted turn (sandboxed worker)
  ┌───────────────────────────────────────────────────────────┐
  │ model ── brain_google_* (mcp__brain-ui__… / bare on pi)   │
  │          no Google credential, no GOG_* env, no gog home  │
  └───────────────┬───────────────────────────────────────────┘
                  │ worker bridge: { tool, input } only
  ┌───────────────▼───────────────────────────────────────────┐
  │ ui-server  google/host.ts                                 │
  │  1 availability: owner, policy, account, transport pin    │
  │  2 strict input (common schemas)                          │
  │  3 host pre-reads (raw draft, event, calendar ACL, labels)│
  │  4 classify effect (common, pure)                         │
  │  5 decide (common, pure): mode → entities → limits →      │
  │    hidden labels → standing admission → card need →       │
  │    posture → G2 routing                                   │
  │  6 card with the exact payload; re-check after it         │
  │  7 record decision + inverse before execution             │
  │  8 execute through the transport, once, under locks       │
  │  9 provenance: structured (no taint) / google_result      │
  │ 10 project, validate, bound, mark untrusted               │
  └───────────────┬───────────────────────────────────────────┘
                  │ operation + validated input
  ┌───────────────▼───────────────────────────────────────────┐
  │ common  google/transport (gog implementation)             │
  │  pinned binary (exact version + sha256)                   │
  │  argv from typed input; env allow-list; stdin bodies      │
  │  --enable-commands-exact=<op> --readonly --gmail-no-send  │
  │  exit codes → error codes; strict output codecs           │
  └───────────────┬───────────────────────────────────────────┘
                  │ HTTPS from the host process
                  ▼
           Google APIs (Gmail v1, Calendar v3, People v1, Tasks v1)
```

The standalone front door (`brain google … --json`, §10) calls the same
operations and decision function. A terminal has no card, so `ask` refuses
there.

### Where the code lives

| Piece | Location | Notes |
| --- | --- | --- |
| Catalog, input schemas, limits, error codes, effect classifier, address and MIME parsing, structured projections | `packages/common/src/google/` → `@schlessera/brain-common/internal/google-operations` | Pure, like `apify-operations.ts`. |
| Policy block and decision function | `google` key in `packages/common/src/governance-policy.ts`; `packages/common/src/google/decision.ts` | Pure: policy + call + host facts → decision. |
| Transport (gog) | `packages/common/src/google/gog/` → `@schlessera/brain-common/internal/google-gog` | Pin check, runner, argv builders, codecs, schema snapshot. Bun only. |
| Common ledger: remembered approvals, sent digests, standalone inverses | `packages/common/src/google/ledger.ts` | SQLite outside worker mounts and the index, shared by host and standalone processes like the Apify ledger. |
| Session state: allowances, inverses and snapshots, send locks, calendar handles | `packages/ui-server/src/google/` (UI-server database tables) | Scrubbed with the session by chat-history deletion. |
| Result and card payload schemas | `packages/ui-sdk/src/tool-contracts/google.ts` | Content-view strings marked `untrusted`, as in `github.ts`. |
| Host tools | `packages/ui-server/src/google/host.ts` | Mirrors `github/host.ts`. |
| Bridge member and handler | `BackendBridge.google`; `packages/ui-sdk/src/server/bridge-tools/google.ts` | Shared by both backends. |
| Claude / pi registration | `packages/ui-backend-claude/src/google-tools.ts`; `packages/ui-backend-pi/src/bridge-tools.ts` | Every interactive roster; call-time availability. |
| System brief line | `googleToolsLine` in `packages/ui-sdk/src/server/system-prompt.ts` | Fixed text in the retained append. |
| CLI | `packages/core/src/cli/commands/google.ts`, `packages/core/src/lib/google/` | Standalone glue only. |
| Chat components and cards | `packages/ui-kit` (presentational), `packages/ui-react` (integration) | Split as the GitHub components were (#3800 / #3795). |

## 4. Operation catalog

Each operation has an id (`<service>.<verb>`), a tool, a base class, the
escalations that raise it, and the entity an approval attaches to.
"Per-tool approval" in policy and in the ledger is per operation id. Tools
group operations so the roster stays small (nine tools for Gmail and
Calendar); every tool is named `brain_google_<service>_<verb>`, visible as
`mcp__brain-ui__brain_google_*` on Claude and bare on pi. v1 serves exactly one
account.

### Gmail

| Operation | Tool | Base | Escalates to irreversible when | Approval entity |
| --- | --- | --- | --- | --- |
| `gmail.search` | `brain_google_gmail_search` | read | — | — |
| `gmail.thread.get`, `gmail.message.get`, `gmail.draft.get`, `gmail.labels.list` | `brain_google_gmail_read` | read | — | — |
| `gmail.modify` (archive/unarchive, read/unread, star/unstar, add/remove user labels) | `brain_google_gmail_modify` | reversible | a system label other than INBOX, UNREAD, STARRED | the action (`archive`, `label:<id>`, …) |
| `gmail.trash` | `brain_google_gmail_trash` | irreversible | — (reversible only once its inverse is proven, §7) | — |
| `gmail.draft.save` (create, reply, update) | `brain_google_gmail_draft` | reversible | updating a draft brain-kit did not create, or whose current fingerprint differs from brain-kit's last recorded post-write fingerprint | `drafts` |
| `gmail.draft.delete` | `brain_google_gmail_draft` | irreversible | — | — |
| `gmail.draft.send` | `brain_google_gmail_send` | irreversible | — | never remembered (Q2) |

- **Search and read take a view.** `structured` returns thread and message ids
  (Google-minted), label ids and names, internal dates, a size bucket (under
  10 KB, 100 KB, 1 MB, or larger, because the exact size is sender-controlled),
  message counts, unread, starred and has-attachment flags, and an opaque host
  cursor for the next page. `content` adds from, to, cc, subject, snippet and,
  for a read, the text body. The default is `content`; the brief tells the
  model to use `structured` when it only needs to act on what a query matched.
  `gmail.labels.list` is structured: label names count as the owner's
  configuration (ruling 5), capped at Gmail's 225 characters, with control,
  bidirectional and zero-width characters escaped.
- **Modify works on message ids.** The host resolves a thread target to its
  message ids, pre-reads each message's labels under the account's write lock,
  and writes with `gmail batch modify`. That gives an exact inverse and excludes
  mail that arrives after the pre-read. At most 25 ids per call.
- **v1 drafts are plain text, without attachments.** `draft.save` takes a text
  body through stdin. The host composes replies itself, resolving recipients and
  the quoted text from the thread, rather than using gog's `--reply-all` and
  `--quote`, so the card shows the composed result and brain-kit's drafts stay
  text-only. A forward is a new text draft quoting the original text. Incoming
  attachments are metadata only. Every write returns a structured result only
  (ids, fingerprint, counts), never host-quoted text.

**Send is bound to the exact approved bytes.** The model can only send a draft.
The host retrieves the draft's raw RFC 822 message (gog supports raw draft
retrieval since 0.41, #1126) and parses it in common. The card shows everything
that will be sent: From and the send-as identity, To, Cc, Bcc, Reply-To,
Subject, the thread it replies to, and the full text body. The host refuses
(`draft_not_displayable`) a draft with an HTML part, an attachment, a body over
the card's full-display bound, or headers the parser cannot read. Gmail's web
composer always writes an HTML part, so drafts written there are sent from
Gmail in v1. Recipients are checked from the parsed headers, never from model
input. After an unedited allow, the host sends **the bytes the card was built
from** (`gmail send --raw-file -`, with the thread id), records their digest,
and deletes the draft. The ledger refuses a second send of a recorded digest,
so a retry or a failed delete cannot send twice. "Raw sends" stay out of the
model-facing catalog; only this host path uses them.

A draft carries a **send lock** while its card is open: `draft.save` and
`draft.delete` on it refuse (`draft_locked`). The lock belongs to the card,
ends when the card is answered, withdrawn or expires, and is cleared at host
start, when every pending card is withdrawn.

**Never in the catalog:** permanent delete, batch delete, settings (filters,
forwarding, delegates, send-as, vacation and autoreply, IMAP/POP), watch, track,
import, model-facing raw sends, the Discovery passthrough and every other gog
command. Forwarding rules and delegates are exfiltration channels and stay out
of reach whatever the policy says, and the write grant excludes their scopes
(§10). gog itself runs with `--enable-commands-exact=<that one operation>`, so a
bug in argv construction cannot reach another command.

### Calendar

| Operation | Tool | Base | Escalates to irreversible when | Approval entity |
| --- | --- | --- | --- | --- |
| `calendar.calendars.list`, `calendar.events.list`, `.search`, `.get`, `calendar.freebusy` | `brain_google_calendar_read` | read | — | — |
| `calendar.event.create`, `calendar.event.update` | `brain_google_calendar_event` | reversible | the resulting event has any attendee other than the account; the calendar is not verified private; `visibility: public`; a conference link; an attachment; an event type other than `default`; the edit reaches beyond one instance of a recurring series; for an update, the event changed since brain-kit last recorded it | the calendar |
| `calendar.event.delete` | `brain_google_calendar_event` | irreversible | — | — |
| `calendar.event.respond` | `brain_google_calendar_respond` | irreversible | — | — |

- **Views and handles.** `structured` event results carry an opaque host
  handle per event and per calendar (`primary` stays `primary`), start, end,
  all-day and recurrence flags, status, transparency, the account's own
  response status, whether the account organises it, and the attendee count.
  `content` adds title, description, location, organiser and attendees.
  Calendar ids are email addresses, and whoever creates an event, an inviter
  included, can choose its id, so raw ids never appear in a structured result:
  every calendar tool takes and returns handles, which the host maps to real
  ids in a session-keyed table. `calendar.freebusy` is always structured, so
  finding free time never taints.
- **An update is classified on the event it would produce**, with the full
  create list, and always passes an explicit recurrence `--scope`.
- **Private is verified, not declared.** Before a reversible calendar write the
  host reads the calendar's ACL. Only a calendar whose rules name the account
  alone is private; anything else, or a failed ACL read, is shared. The result is
  cached per process for five minutes.
- **Attendees are bare addresses** validated by the address parser; the host
  builds gog's `--attendees` value and never passes its `;optional`,
  `;resource` or `;comment=` modifiers through.
- **Guests escalate whatever the notification choice**, because an event with
  guests appears on their calendars whether or not they are emailed. The card
  shows the notification choice; the default is `none`.
- **After the card**, the host re-reads the event under the account's write lock
  and refuses if its etag changed, for update, delete and respond alike.

## 5. Policy

A new top-level `google` block in `context/policies/governance.md`, beside
`apify`, validated by the same strict schema as the rest of the policy. Absent,
Google is disabled. A malformed block invalidates the policy like any other key,
which keeps the last valid policy in force.

```yaml
google:
  enabled: true
  account: personal            # the gog alias the host uses; "auto" is refused
  services: [gmail, calendar]
  modes:                       # per effect class
    read: allow                # deny | allow
    reversible: ask            # deny | ask | allow
    irreversible: ask          # deny | ask (allow is invalid)
  operations:                  # optional, per operation id
    gmail.draft.delete: deny
    gmail.modify: allow        # applies only while the computed class is reversible
  gmail:
    send_to:                   # every recipient of a send must match one
      - self                   # the account's own addresses, resolved by the host
      - "*@example.com"        # exactly this domain; no subdomains
      - penelope@example.com
    max_recipients: 10
    hidden_labels: []          # label ids whose threads no tool may see or touch
  calendar:
    invite:                    # attendees an invitation may name
      - "*@example.com"
  standalone:
    reversible: deny           # deny | allow: what `brain google` may do without a card
  limits:
    items_per_call: 25         # ids per modify call
    reversible_per_turn: 25    # card-less reversible items per turn before admission becomes ask
```

- **An operation override replaces the class mode for that operation, capped
  by the call's computed class.** With `reversible: ask`, `gmail.modify: allow`
  admits a reversible modify without a card; a modify that escalated to
  irreversible uses `modes.irreversible`, or the override if that is `deny`.
  `irreversible: allow`, and `allow` on an operation whose base class is
  irreversible, are schema errors.
- **An empty allow-list opens nothing.** No `send_to`, no sends; no `invite`, no
  invitations, as with `outward.github.repositories`.
- **Addresses are matched by one strict parser** over parsed headers: an
  RFC 5322 addr-spec per mailbox, display names ignored for matching, group
  syntax, comments and quoted local parts refused, domains compared in
  lower-case ASCII (punycode) with no subdomain match. Anything it cannot parse
  refuses.
- **`self`** resolves from the account's primary address and verified send-as
  aliases, cached per process, so personal addresses stay out of the file.
- **An alias, not an address.** The policy names a gog alias; the address
  behind it lives only in the host's gog home.
- **`hidden_labels` is enforced on results, not on queries.** A thread with any
  message carrying a hidden label is absent from every search and refused by
  every get (`not_found`); modify, trash, reply and quote refuse a hidden message
  or thread as a target. Appending an exclusion to a query is only an
  optimisation: a model query such as `a OR b` would defeat it. This is how an
  owner keeps, say, security mail out of the model provider's reach (Q11).
- **`standalone.reversible`** is separate because a terminal has no session, so
  no taint and no card: an owner who allows card-less archives in hosted turns
  has not thereby allowed a local agent to do them. Default `deny`. It admits
  only where the operation's effective mode is also `allow`, because `ask`
  refuses in a terminal.
- **Search results are filtered on per-thread labels.** gog's search output
  carries each thread's labels, so `hidden_labels` costs no extra read per hit;
  the transport task proves those labels are the union of the thread's message
  labels, or the filter falls back to a capped pre-read.

## 6. Deciding a call

One deterministic procedure per call. The decision function is pure and lives
in common; the host supplies what only it knows.

1. **Availability.** The caller is the brain's owner (Q9); Google is enabled;
   the account is connected for the service; the gog binary passes the pin
   (§8). Otherwise `unavailable` or `policy_denied` with a reason, and nothing is
   sent.
2. **Input.** Strict schema; ids validated by shape (Gmail message, thread,
   draft and label ids, calendar and event ids); addresses parsed; dates parsed;
   the search query a bounded single line; sizes bounded. Otherwise
   `invalid_input`.
3. **Host pre-reads.** What classification needs and the model must not
   supply: the draft's raw message for a send or update, the event for an update
   or delete, the calendar ACL for a reversible calendar write, every modified
   message's labels under the write lock. Each costs about one gog invocation
   (§8).
4. **Effect.** Base class, then escalations.
5. **Mode.** The operation override if there is one, else the class mode,
   capped by the computed class (§5). `deny` refuses before any card and is
   recorded as `refused`.
6. **Entities.** Every send recipient against `gmail.send_to` and
   `max_recipients`; every invitee against `calendar.invite`; every target
   against `hidden_labels`. A miss refuses before any card.
7. **Limits.** Above `items_per_call`, refuse. Above `reversible_per_turn`
   card-less items in the turn, standing admission stops and the call asks.
8. **Standing admission** (reversible only; irreversible calls always ask):
   - in an **untainted** session, policy `allow` or a live remembered approval
     for (principal, brain, account, operation, entity) admits without a card;
   - in a **tainted** session, policy `allow` and remembered approvals do not
     apply (G6). Only a **session allowance** admits: one the owner granted on a
     card in this tainted session ("Allow archive for the rest of this
     session"), for that operation and entity, within the limits and lifetime
     in §7.
   - Either way, a card-less call re-reads the session's effective safety and
     policy under the account's write lock immediately before dispatch, as the
     live-admission rule requires at every last dispatch point (#3602).
9. **Card need and posture.** A call that is not admitted needs a card. An
   interactive turn shows it. Voice cannot grant, so a needed card refuses
   before it is shown, as GitHub writes do (`if (ctx.posture !== "interactive")`, `packages/ui-server/src/github/host.ts:484-487`);
   a call standing admission already admitted, a session allowance included,
   runs in voice too (ruling 6). Autonomous turns refuse (§10).
10. **Routing (G2).** A read or search sends model-chosen text to Google, and a
    card-less write sends model-written text, so both are routed as recipient
    `google`: a conversation that has shown a folder the policy keeps from
    `google`, or whose exposure cannot be judged, sends Google nothing. A write
    whose exact payload is on a card is gated by the card, as GitHub writes are
    (#4029).
11. **Card.** One per call, a new `PermissionRequest` kind `google`: the exact
    payload, the effect class in words, and the taint banner when tainted. Only
    an unedited allow admits, once. A reversible card offers "Allow always for
    <entity>" in an untainted session and "Allow for the rest of this session"
    in a tainted one; an irreversible card offers neither. The `google` kind
    never enters `toolAutoAllow` (`const remembers =`, `packages/ui-server/src/ws/handlers/tool-permission.ts:87-91`
    excludes only `actor`, `command` and `policy` today, so the exclusion is new
    and tested); its standing choices go to the Google ledger, as `actor` goes to
    the Apify ledger. After the card, the host re-checks the turn's authority and
    the session's current effective policy.
12. **Record, then execute.** The decision, and for a reversible call its
    inverse, commit before the transport runs; a recording failure refuses
    (`recording_unavailable`). Writes run under the account's write lock and are
    never retried. A timed-out write answers that it may have happened.
13. **Provenance, then return.** A `content` result records `google_result`
    taint through the host's `untrusted` callback before it returns, as the
    GitHub read tools do (`const githubTools = createGithubToolsHost`, `packages/ui-server/src/app.ts:810-817`):
    a new member of the `taint` source enum (`taint: kind(1`, `packages/ui-server/src/governance/events.ts:223-233`),
    with the read tools listed in the ingestion detector manifest
    (`hostRemotePages`, `packages/ui-server/src/activity/ingestion-taint.ts:137`).
    A failure to record it withholds the result. A `structured` result records
    no safety occurrence; the call's collector obligation is discharged with
    nothing to record. An audit line for every Google call goes to a separate
    governance event that the safety projection never reads.

**What "structured" means, exactly.** A result is structured when the host
built it by projection from the codec output and every value in it passed a
validator from a closed set: a Gmail message, thread, draft or label id
(Google-minted, matching its shape); a host-minted handle (calendar objects,
page cursors); an RFC 3339 timestamp; a non-negative integer; a size bucket; a
boolean; a value from a closed enum (system labels, event status, response
status, transparency); a free/busy interval; or a label name from the account's
label list, length-capped with control, bidirectional and zero-width characters
escaped (ruling 5). A value that fails is dropped, never passed through as text.
Nothing else is structured. An email address is not, because its local part is
attacker-chosen text; nor is a calendar or event id, because a calendar id is an
address and an inviter can choose an event id. Timestamps, counts and whether a
query matched remain low-bandwidth channels a sender can influence. They carry
no instruction a model would follow, and the decision record names them, and
app-created label names, as accepted residual risk.

**What the model gains.** A triage turn can search with a query it wrote
(`category:promotions older_than:30d`), take the structured ids, and archive
them card-lessly under policy `allow`, without tainting. When it must read the
mail to decide, the session becomes tainted, and from then on each reversible
write asks until the owner grants a session allowance on one of those cards.
Irreversible calls ask every time, in every session.

## 7. Approvals, inverses and undo

Four layers; the most restrictive wins.

1. **Policy** (owner-authored Markdown): modes, allow-lists, limits. Settings
   edits it through the existing policy-proposal path, as Apify settings do.
2. **Remembered approvals** (common ledger, untainted sessions only): "Allow
   always" on a reversible card, keyed by (principal, brain, the account's
   host-resolved identity rather than its alias, operation, entity), listed and
   revoked in Settings and with `brain google approvals` / `revoke`. A
   remembered approval never exceeds policy: a later `deny` wins. Re-pointing
   the alias at another account inherits nothing.
3. **Session allowances** (UI-server database, tainted sessions only): "Allow
   for the rest of this session" on a reversible card shown with the taint
   banner, keyed by (session, principal, brain, account identity, operation,
   entity), listed on the session and revocable there. One lasts at most 24
   hours and never past the host process that granted it, admits at most 100
   items in all on top of the per-turn limit, and is void as soon as the policy
   hash changes, the principal loses authority, or the session returns to
   normal policy. It never transfers on handoff, fork or import
   ([session-handoff.md](../decisions/session-handoff.md): remembered grants
   stay on the source). It is never offered for an irreversible operation and
   never granted by voice; once granted on screen it also admits voice turns in
   that session (ruling 6).
4. **Per-use card**: exact payload, one use, unedited allow only.

**Inverses** make `reversible` honest. Every reversible call records its inverse
and a precondition before it runs:

| Operation | Inverse | Precondition | Ships |
| --- | --- | --- | --- |
| Draft create | delete that draft | fingerprint unchanged | with writes |
| Modify | the opposite label delta on exactly the messages that changed | each still carries the post-change labels | with writes |
| Event create | delete that event | etag unchanged | with calendar writes |
| Draft update | restore the previous snapshot | fingerprint equals the post-write fingerprint | with undo |
| Event update | patch back the snapshot fields | etag unchanged | with undo |
| Trash | remove TRASH (`modify`), if proven | still in trash | only after a live proof on a disposable account; until then trash is irreversible |

The journal lists every Google call with its effect class; irreversible calls
are receipts, as GitHub writes are. **Undo** is a separate, last delivery: an
owner action from the journal that runs the recorded inverse through the same
transport, checks its precondition, explains what changed when it fails, and is
recorded itself. Writes do not wait for it.

Snapshots hold mail bodies and event details. Everything keyed by a session
(inverses and their snapshots, session allowances, send locks, calendar
handles) therefore lives in the UI-server database, which
[chat-history deletion](../decisions/chat-history-deletion.md) already scrubs
with the session; G0's decision record names these stores. The common ledger
holds only remembered approvals, sent digests and standalone inverses, and a
standalone inverse holds no body, because standalone writes are limited to
modify and draft create (§10). An inverse expires after seven days (a trash
inverse after 30, when Gmail empties the trash) and is deleted once used.

## 8. Transport: gog, and when to leave it

The first implementation drives [gogcli](https://github.com/openclaw/gogcli)
(`gog`, MIT). The maintainer selected it on 2026-11-17 after the comparison
below, behind a boundary that lets single operations move to direct REST.

### What gog brings

- **Breadth now.** Gmail, Calendar, Contacts (People), Tasks and more behind one
  binary, with OAuth flows (browser, `--manual`, two-step `--remote`), account
  aliases, token refresh and an encrypted file keyring. A direct client builds
  all of that before its first read.
- **Safety switches that compose with ours.** Exact command allow-lists
  (`--enable-commands-exact`); runtime `--readonly`, which blocks mutating
  requests before dispatch and still allows read-only POSTs such as free/busy;
  `--gmail-no-send`; read-only and merged extra scopes at `auth add`;
  `--dry-run`; `--no-input`; a machine contract (`gog schema --json`,
  `schema_version: 1`) with stable exit codes (`0` ok, `3` empty, `4` auth
  required, `5` not found, `6` denied, `7` rate limited, `8` retryable,
  `10` config).
- **Mail plumbing.** Decoded bodies and parsed headers on read; RFC 5322 drafts
  with threading headers from typed flags and stdin bodies; raw draft retrieval
  and raw sends for exact send binding. Brain-kit still owns a strict parser for
  what the send card shows.
- **Calendar semantics.** Time zones, all-day events, RRULEs, `send-updates`,
  free/busy and ACLs, already handled.
- **It matches the instruction and the `gh` pattern**: one external binary the
  host invokes with a credential the worker never sees.

### What it costs

- **Supply chain.** A third-party Go binary holds a refresh token with mail
  scope. The project moves fast (0.37 in August 2026, 0.48.1 on 2026-11-16) and
  changed owner (`steipete/gogcli` to `openclaw/gogcli`). Every upgrade is a
  change to something that can read and send your mail.
- **Output is not a versioned contract.** `schema_version` covers commands and
  flags, not output shapes or defaults. Shapes and behaviour change between
  releases, patch releases included (0.38.1 to 0.38.3). Some commands return
  Gmail's raw payload (`thread get`), others a decoded one (`get`).
- **Latency.** Measured on a development machine: about 2 s wall per read
  invocation (about 0.45 s opening the keyring, the rest token refresh and the
  API call; offline startup is 0.05 s). A search and three thread reads is about
  8 s of tool time. A reversible calendar update is an ACL read (often cached),
  an event read, the update and the post-card re-read, 4–8 s. A modify of
  messages this session has not seen adds one pre-read per thread. There is no
  connection reuse and no in-memory access token across invocations.
- **Coarse errors.** Exit codes; OAuth error bodies are redacted since 0.47.
- **Deployment.** Another pinned binary in every image and on every machine that
  runs the standalone CLI.

### What direct REST would bring, and cost

Direct REST (`fetch` against `gmail.googleapis.com` and the Calendar v3, People
v1 and Tasks v1 endpoints) is how the GitHub host tools and Apify's run
lifecycle work today. It gives exact request bodies; one process with a cached
access token and connection reuse, so latency near one API round trip; precise
status and `Retry-After` handling; request metering; no third-party binary
holding the credential; Google's long-stable `v1`/`v3` shapes instead of a
CLI's; and a smaller attack surface by construction, since only implemented
endpoints exist. An in-app OAuth connect flow for the hosted UI is also more
natural.

It costs implementing and owning OAuth (consent, PKCE, refresh, revocation,
encrypted token storage), RFC 5322 composition and MIME parsing (charsets,
encoded words, quoted-printable, multipart, HTML to text, header injection),
recurrence and time zones, pagination and backoff: all security-sensitive, all
per service. The umbrella client library is not a shortcut (`googleapis`
190.0.0 unpacks to 246 MB); the per-API packages are small (`@googleapis/gmail`
22.1.0 at 1.2 MB, `@googleapis/calendar` 20.2.0 at 0.8 MB,
`google-auth-library` 11.3.4 at 0.8 MB), but a hand-rolled `fetch` client is
the repo's pattern.

A middle option is **gog for auth and token custody only, REST for calls**: the
host asks gog for a short-lived access token and calls the APIs itself. It keeps
gog's OAuth and keyring and gains REST's exactness and latency, at the cost of
owning every codec.

### The selected shape

**gog for every v1 operation, behind an operation-level transport boundary.**
The governance layer never sees argv or gog JSON; it calls
`transport.execute(operation, input)` and receives a validated result or a coded
error. Moving one operation to REST changes nothing above that line. This is the
bounded combination the Apify ruling chose for its own provider: a third-party
transport where it saves work, direct REST where exactness or lifecycle matters.

What ships with v1 to contain the costs:

- **An exact pin.** The host accepts only listed gog versions, each with the
  sha256 of its release binary per platform (starting with 0.48.1). At first use
  it checks that `BRAIN_UI_GOG_PATH` and its directory are owned by root or the
  host user and not writable by anyone else, hashes the binary, runs `gog
  version` and `gog schema --json`, and checks that every catalog command path
  and flag exists. Before each write it re-checks the file's identity (device,
  inode, size, mtime). Anything else answers `unavailable` /
  `transport_incompatible`. The standalone CLI requires an exact listed version
  and reports the checksum result, because package-manager builds do not match
  release checksums.
- **A committed schema snapshot** of the commands and flags the catalog uses, and
  a unit test that every argv builder uses only flags in it. An upgrade
  regenerates it offline, runs the live shape check (§11) and the disposable-
  account write proof, and adds the new version and checksum to the list.
- **Strict codecs** per operation. An unexpected shape is
  `transport_incompatible`, never a guessed field.
- **Sends bound to the approved bytes** (§4).
- **Bounded concurrency** per account (reads 4, writes 1), and structured views
  and rich search results so a model rarely needs a read per hit.

**Move an operation to direct REST when** a gog upgrade breaks a codec twice in a
quarter; measured p95 tool latency for an operation exceeds 5 s in real use; an
upstream advisory or ownership change cannot be contained by the pin; the hosted
connect flow needs an in-app OAuth redirect; or an irreversible path needs
byte-exact binding that its pre-read cannot give (calendar invitations are the
likely case). Modify (pre-read heavy) and token handling are the likely first
moves.

**Rejected for v1:** `gog mcp` as a long-lived sidecar (lower latency, but a
second MCP contract the host must police and a resident process it must
supervise), and REST-only from day one (most of the work before the first read).

### Invocation discipline

```
<BRAIN_UI_GOG_PATH> --no-input --json --color=never
    --account=<alias> --enable-commands-exact=<operation path>
    [--readonly]            # every read
    [--gmail-no-send]       # every operation except the host's send path
    <subcommand> <--flag=value …> [-- <validated positionals>]
```

- Values are single `--flag=value` elements, so a leading `-` is never a flag.
  Values gog splits on commas (labels, attendees) are built from validated lists,
  ids only, never names. Newlines and NUL are refused in every single-line value.
  Positionals are validated ids or the bounded single-line search query, always
  after `--`. Bodies and raw messages go through stdin, never argv.
- A gog command that writes a file is always given a host-chosen output path and
  file name; gog's default output directory is its config directory, which is the
  credential home.
- The environment is an allow-list, never inherited: `GOG_HOME`, `HOME` set to
  the gog home so no ambient config is read, `GOG_KEYRING_BACKEND=file`,
  `GOG_KEYRING_PASSWORD`, `GOG_TIMEZONE`, a minimal `PATH`, `LANG`.
  `GOG_ACCESS_TOKEN` and every other `GOG_*` name in the host environment are
  dropped.
- stdout is capped (8 MiB) and parsed; stderr never reaches the model, only a
  coded error and a scrubbed, truncated host log line.
- Timeouts: reads 30 s, writes 60 s, process-group kill. A read may retry once on
  exit `8`; a write never retries.
- `--wrap-untrusted` is not used. The contract marks untrusted strings itself, and
  the codecs strip gog's markers if a later default adds them.

## 9. What the model and the user see

**Tools.** Nine tools, in every interactive roster on both backends, as the GitHub
tools are: always present, always loaded, deciding availability at call time.
G1b registers the six Gmail tools, the write tools answering `unavailable` until
G2 lands (as the GitHub write tools were declared before they were wired); C1
registers the three Calendar tools. So the roster changes twice, not at every
landing. Sessions retained from before a change see the new tools on their next
turn, as happened when the GitHub tools shipped; their retained append keeps its
earlier bytes. Every interactive session pays the schemas and the brief line from
G1b on, whether or not its brain enables Google, so descriptions stay short and
G1b's landing records the measured schema token cost. The fixed system brief
gains one line naming the tools, saying that `gog`, `curl` and WebFetch cannot act
as the user on Google, that the `structured` view keeps a session untainted, and
that `unavailable` or `policy_denied` is to be reported, not worked around.

**Results.** Structured payloads in `tool-contracts/google.ts`. Content-view
strings are marked `untrusted`. Messages carry from, to, cc, date, subject,
snippet, a text body (HTML converted to text; at most 32 KiB per message and
128 KiB per thread, with `body_truncated` and lengths), label ids and names, and
attachment metadata. Search returns at most 25 threads per page with a page
token. Full bodies beyond the model's cap are available to the owner through a
display-only detail route that never enters the provider history, as the GitHub
detail route does.

**Cards.** The `google` card is an email or event preview, not JSON: the alias and
send-as identity, every recipient with its allow-list match, subject, the full
body, the thread it replies to, the effect in words ("Sends email. It cannot be
unsent."), the taint banner, and the standing choice §6 allows. Bidirectional
and zero-width characters in any shown value are made visible. Its design is its
own `needs: design` task.

**Journal.** Every Google call with its effect class. Irreversible calls sit with
the outward receipts; reversible calls show Undo once undo ships and while the
inverse is live. Session allowances are listed on the session.

**Settings.** A Google panel: transport version and pin result, the connected
account, granted scopes against what the policy needs, remembered approvals with
revoke, and policy edits through policy proposals.

## 10. Postures, front doors and the credential boundary

| Surface | Read | Reversible | Irreversible |
| --- | --- | --- | --- |
| Interactive hosted turn, owner, untainted | policy | policy `allow` or remembered approval; else card | allow-list, card every time |
| Interactive hosted turn, owner, tainted | policy | session allowance; else card | allow-list, card every time |
| Voice posture | policy | only what standing admission already admits | refused |
| Autonomous turn | refused in v1 | refused in v1 | refused |
| Any other principal | refused (Q9) | refused | refused |
| `brain google … --json` (standalone) | policy | modify and draft create, only where `standalone.reversible: allow` and the operation's mode is `allow` | refused |
| Core MCP inside a hosted worker | disallowed | disallowed | disallowed |

Autonomous Google work (scheduled triage that prepares drafts) is a later issue.
Schedule envelopes already bind exact tools, bounds and targets
([scheduled-tasks.md](../decisions/scheduled-tasks.md)), and reversible
operations fit them; irreversible operations stay interactive.

The standalone CLI never prompts on a terminal, matching the Apify standalone
rule. It has no session, so no taint and no remembered approvals: a local
`brain approve` would be one command the local agent could run itself. Core MCP
`brain_google_*` tools are not part of v1; when they come, every hosted session
disallows the in-worker copies, as it does for compute and Apify
(`IN_WORKER_COMPUTE_TOOLS`, `sdk-options.ts:54`).

### Connecting an account

`brain google connect` wraps gog's OAuth flow with flags brain-kit owns:
`--services` limited to what the policy lists, read-only scopes unless `--write`
is given, and for write the narrowest grant. gog's default "full" Gmail grant is
`gmail.modify` plus `gmail.settings.basic` and `gmail.settings.sharing`
(gog v0.48.1 [`internal/googleauth/service.go`](https://github.com/openclaw/gogcli/blob/v0.48.1/internal/googleauth/service.go), lines 134 to 136), which
reaches filters, forwarding and delegates; its Calendar grant is full `calendar`
(line 142). The write connect is therefore `--gmail-scope=readonly` with
`--extra-scopes` naming `gmail.modify`, which gog merges (`mergeScopes`, line
795), and
`calendar.readonly`, `calendar.events` and `calendar.acls.readonly` for
Calendar. `gmail.modify` excludes permanent delete and settings. The ACL scope
is what lets the host verify a private calendar; without it every calendar
write escalates, and `brain google status` says why rather than escalating
silently. Connect verifies the granted scopes and
fails if they are broader; the transport task proves both shapes on a disposable
account. The hosted host is connected by its operator from a shell with `brain
google connect --remote` (gog's two-step print-URL / exchange-code flow), writing
into the host's gog home.

The instance owner brings their own Google Cloud project and **Desktop** OAuth
client. A client whose consent screen is in **Testing** status issues refresh
tokens that expire seven days after consent
([Google Cloud help](https://support.google.com/cloud/answer/15549945)), so the
hosting docs tell the owner to move it to **In production**. Gmail scopes are
restricted scopes; an unverified app shows Google's warning and is limited in
users, which suits a personal instance. A Google Workspace owner can use an
**Internal** client instead. An in-app connect flow is a later issue (Q10).

### Hosted: an enforced boundary

- `BRAIN_UI_GOOGLE_HOME`: the gog home (config and file keyring). Absolute, mode
  0700, owned by the host user, outside the brain root, the database directory,
  every worker mount and every temp area. A violation disables the Google tools
  with a status reason; it never fails the boot.
- `BRAIN_UI_GOOGLE_KEYRING_PASSWORD`: host-only. It, the home and
  `BRAIN_GOOGLE_LEDGER` join the host-only list
  (`HOST_ONLY_SECRET_ENV`, `packages/ui-sdk/src/server/subprocess-env.ts:35`), so
  no audience or operator extra can admit them.
- `BRAIN_UI_GOG_PATH`: the pinned binary, which no worker can write.
- Every `GOG_*` name is stripped from every subprocess audience, so a `GOG_*`
  variable set on the host cannot reach a worker.
- The native proof shows that a real sandboxed worker cannot stat or read the gog
  home, gog's default home under `$HOME`, or the standalone default home; holds no
  `GOG_*`, `BRAIN_UI_GOOGLE_*` or `BRAIN_GOOGLE_*` variable; and cannot read the
  environment of a running host gog process (workers already run with their own
  PID namespace and `/proc`).
- A worker's own `gog` finds no home and no keyring. Its connection to
  `gmail.googleapis.com` is already outward and waits on a Network card
  (`MAIL_SUBMISSION_HOSTS`, `packages/ui-server/src/brain/turn-egress.ts:24-26`),
  and reaches Google unauthenticated if allowed. A worker's `brain google` finds
  no credential and answers `unavailable`.

### Standalone: an advisory boundary

When a local coding agent runs as the same OS user as the brain CLI, nothing
brain-kit does can stop it from running `gog` or reading its keyring. The
standalone CLI therefore uses its own gog home (`BRAIN_GOOGLE_HOME`, default under
`$XDG_DATA_HOME/brain/google/`, never inside a brain repository; `brain doctor`
fails if it is), connects read-only unless `--write` is given, admits only modify
and draft create, under `standalone.reversible: allow` (a draft update needs a
snapshot store it does not have, so it escalates), never runs irreversible
operations, and says in its docs and in `brain google status` that a local agent
with shell access is inside the boundary.

## 11. Testing

Keyless, offline and deterministic.

- **Fake gog.** A Bun-shebang fake, injected by a transport factory parameter in
  tests (never an environment variable, so production cannot be pointed at it),
  which also bypasses the pin. It is driven by a scenario file: per operation
  path, the stdout, stderr, exit code and delay. It records argv, environment
  names and stdin. Fixtures are Odysseus mail and calendars on `example.com`,
  shaped from real gog 0.48 output by the live shape check, never copied from it.
- **No real gog in tests.** The test network guard refuses to spawn any
  executable named `gog` that is not a registered fake, as it refuses `curl`
  (`for (const key of ["spawn", "spawnSync"]`, `scripts/test-network-guard.ts:132-138`).
- **Discipline tables.** Every catalog operation's argv uses only snapshot flags;
  reads carry `--readonly`; everything but the host send path carries
  `--gmail-no-send`; every call carries `--enable-commands-exact` for exactly its
  own path; the environment is exactly the allow-list; bodies arrive on stdin;
  values with a leading `-`, commas, newlines or NUL are refused or built safely.
- **Structured projection.** Every structured field validator, with mutation
  proof that a subject, name, address, snippet, raw calendar id or raw event id
  leaking into a structured result fails a test; a structured read records no
  safety occurrence, the projection stays `normal` and the collector obligation
  is discharged; a content read records `google_result` before its text returns.
- **Standing admission.** Remembered approvals inert in a tainted session; a
  session allowance admitting the next tainted reversible call for its
  operation and entity only; its 24-hour and process-lifetime expiry, its
  100-item ceiling, its voiding on a policy-hash change, principal loss and a
  return to normal policy; no transfer on handoff, fork or import; use in voice;
  an alias re-pointed at another account inheriting nothing;
  `standalone.reversible`; the card-less dispatch re-read under the write lock.
- **Address and MIME tables.** Display-name spoofing, group syntax, comments,
  quoted local parts, IDN and punycode, subdomains, `self`, empty lists; HTML
  parts, attachments and unreadable headers refusing a send.
- **Classifier and decision tables.** Every escalation, mode and override
  (including an `allow` override meeting an escalated call), allow-list, hidden
  label (search, get, modify, reply, quote), limit, posture (including standing
  admission in voice), principal, taint and standing-admission combination, each
  proven by a mutation.
- **Send binding.** Edited approval refused; the bytes sent equal the bytes shown;
  a second send of a recorded digest refused; `draft.save` on a locked draft
  refused; locks cleared at start; a race between a pending send card and a model
  `draft.save`.
- **Calendar.** Update classified on the resulting event; explicit `--scope`; ACL
  failure counting as shared and surfacing as a status reason; etag change after
  the card refusing; handles resolving only within their session.
- **Hidden labels.** Search, get, modify, trash, reply and quote on a hidden
  thread or message, each refused.
- **Credential isolation.** `filterSubprocessEnv` admits no `BRAIN_UI_GOOGLE_*`,
  `BRAIN_GOOGLE_*` or `GOG_*` name for any audience or operator extra; the pin
  refuses a writable binary; the native hosted-app proof in §10.
- **End to end.** Through the real WebSocket handlers for both backends, as
  `ws-github.test.ts` does: one card with the exact payload; decline and stop;
  record before execute; one invocation; taint before text; routing refusals
  sending nothing; voice refusing a needed card; a non-owner refused; a session
  allowance admitting the next tainted reversible call and nothing else.
- **Provider history.** The Claude and pi guards cover sessions with the Google
  tools: roster and append byte-identical across turns.
- **Live shape check (maintainer-run, read-only).**
  `scripts/google-shape-check.ts` runs each read operation against a real account
  with `--readonly` and the exact command allow-list, and prints only the JSON key
  paths per operation compared with the fixtures'. Its output holds no values and
  is safe to paste into a PR after the leakage gate. It gates every gog upgrade and
  every landing. Live writes are proven on a disposable account only, as a
  `needs: human` step.

## 12. Delivery

Two epics. Each is built on integration branches and lands on `main` in
increments, so every landing is a reviewable PR and nothing waits for a whole
epic. Until a brain's policy has a `google` block the features are off, but from
G1b every interactive session carries the tools and the brief line.

### Gmail

| Landing | Contents |
| --- | --- |
| G0 (docs, straight to `main`) | This plan; the decision record of the 2026-11-17 rulings and of the remaining questions once ruled; the integration-branch rule in `docs/process/github.md`; the epics' track mapping in `scripts/sync-project.ts`. |
| G1a: foundation, no roster change | Catalog, classifier, address and MIME parsing, structured projections; policy block, decision function and `brain policy check`; gog transport with pin, Gmail read codecs, schema snapshot, fake gog and the test-guard refusal; credential isolation and the native proof. |
| G1b: Gmail reads | The six Gmail tools on both backends (writes answering `unavailable`); provenance (`google_result` taint, structured discharge), routing and the brief line; `brain google status`, `connect` (with the scope-shape proof on a disposable account) and `gmail` read commands; the Gmail result components. |
| G2: writes | The write engine (the `google` card kind, ledgers, recording, locks, session allowances, remembered approvals, journal effect class); listing and revoking remembered approvals (`brain google approvals` and `revoke`, a minimal Settings list) and session allowances (on the session); reversible Gmail writes with inverses; the send path and draft delete; the card's design and components; the trash-inverse proof; standalone reversible writes. |
| G3: undo and settings | Undo from the journal; the full Settings panel; hosting and security docs. |

### Calendar

C1 (calendar operations and codecs, the three Calendar tools, calendar reads
with both views and handles, the calendar result components, `brain google
calendar` read commands and an optional calendar section in `brain briefing`)
needs only G1: its common work can start from `main` once G1a has landed, and
its tools follow G1b. C2 (calendar writes, ACL verification, the event card)
needs G2's write engine and lands after it.

### Branch mechanics

The maintainer chose integration branches on 2026-11-17. The repo's merge helper
(`scripts/integrate.ts`) admits only `main`-based candidates (`candidate`,
`scripts/integrate.ts:49-55`), while CI's candidate proof and the review receipt
accept any base. G0 records this as a ruled exception to the stack rules in
`docs/process/github.md`:

- **Task PRs** target the increment's integration branch (`feat/<epic>-gmail-g1a`,
  and so on). Each runs `bun run check:pr --base origin/<integration branch>`,
  carries its own failing-first and mutation receipts, gets hosted CI on its own
  base, and, when it touches a core package, a recorded independent review. It is
  squash-merged by hand after reading back its checks and says `Refs #N`: closing
  keywords only fire on the default branch.
- **Syncing `main`** into an integration branch goes through a PR, so CI runs on
  the merge (push CI runs only for `main`); a conflicted sync gets a fresh review.
  The hot files are `sdk-options.ts`, `ws/bridge.ts`, `protocol.ts`,
  `governance-policy.ts` and `subprocess-env.ts`.
- **A landing** is an ordinary `main` PR from the integration branch, through
  `integrate.ts confirm` and `merge`: complete selected hosted proof, the native
  credential proof, the provider-history guards, a fresh live shape-check receipt,
  a recorded independent review of the whole landing diff, the `CONTRACT:`
  prefix, changesets, `Closes` for every task it completes, and release
  milestones on the PR and each issue.
- After a landing, the next increment's integration branch starts from `main`.

## 13. Later services: Contacts and Tasks

Not filed yet; the foundation must not exclude them.

| Operation | Base | Escalates when |
| --- | --- | --- |
| `contacts.search`, `.list`, `.get`, `contacts.other.search` | read | — |
| `contacts.create` | reversible (inverse: delete) | — |
| `contacts.update` | reversible (inverse: restore snapshot, etag) | the contact is shared or from the directory; it changed since brain-kit recorded it |
| `contacts.delete` | irreversible | — |
| `tasks.lists.list`, `tasks.list`, `tasks.get` | read | — |
| `tasks.add`, `.update`, `.done`, `.undo`, `.move` | reversible | the list is shared |
| `tasks.delete`, `tasks.clear` | irreversible | — |

Contacts are other people's personal data, so contact reads have no structured
view beyond ids and counts, and taint like mail reads. Task titles are the
owner's own text unless the list is shared.

## 14. Rulings and open questions

### Rulings (maintainer, 2026-11-17)

1. **Taint.** A read whose result is composed only of host-validated structured
   values (§6) does not taint. Everything else stays strict: content reads taint,
   and in a tainted session every write asks unless the owner grants a session
   allowance on a reversible card. Own-account reversible Google writes are not
   outward actions under G5: they may run without a card under policy `allow`
   or a remembered approval in an untainted session, or under a session
   allowance in a tainted one. Irreversible Google calls remain outward and
   always ask. G0's decision record states this amendment to G5 and G6 in so
   many words.
2. **Transport.** gog for every v1 operation behind an operation-level boundary,
   with an exact pin and the §8 triggers for moving operations to REST.
3. **Branches.** Integration branches per landing increment, recorded in G0 as an
   exception to the stack rules.
4. **Standalone.** Reads and reversible writes; reversible only under
   `standalone.reversible: allow`; irreversible never.
5. **Label names.** Every label name in the account's label list counts as
   structured, length-capped with control, bidirectional and zero-width
   characters escaped; app-created names are accepted residual risk.
6. **Voice.** Voice never grants: a needed card refuses in voice posture, as
   GitHub writes do. A call standing admission already admits runs in voice,
   including under a session allowance the owner granted on screen.

### Open, with the default the epics assume

- **Q2. Remembered irreversible approvals** ("always allow sending to
  penelope@example.com"). *Default: none in v1;* every irreversible call shows a
  card.
- **Q5. Card-less writes under G2.** *Default: route them as recipient `google`.*
- **Q9. Principals.** *Default: owner only in v1.*
- **Q10. Connecting.** *Default: operator shell connect (`--remote`) in v1,* an
  in-app OAuth flow later.
- **Q11. Read scoping.** *Default: ship `hidden_labels` and document that read
  mail reaches the model provider.*
- **Q12. Undo.** *Default: record inverses from G2, ship undo in G3.*
- **Q14. Attachments.** *Default: none outbound in v1, metadata only inbound.*
- **Q16. Policy placement.** *Default: a top-level `google` block beside `apify`,*
  since it governs reads and reversible writes as well as outward ones.
