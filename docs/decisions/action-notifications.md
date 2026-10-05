# Decision — client-local Action notifications

The maintainer's [2026-10-02 rulings on #683](https://github.com/schlessera/brain-kit/issues/683)
choose how durable waiting decisions reach their authorized recipient. This
record captures that policy for R50/U9 in the
[async collaboration design](../plans/async-collaboration.md#u9-escalation-notifications-ui-server)
and [requirements](../plans/async-collaboration-requirements.md). It records
selected requirements, not observed notification delivery or permission to
enable the autonomous system. The complete-v1 containment, admission, budgets
and system-proof gate in [the async decision](async-collaboration.md) remains
binding, as does the shared mechanism in [the voice decision](voice-permission.md).

## What is being chosen

An Action is visible immediately in the existing Actions destination. Push
batching and scheduled digest generation affect notices, not when a person
can find the decision. A notice deep-links into Actions; it grants no authority
and never resolves an Action. Minimize lock-screen data: counts and navigation
belong there, while thread content, effects and device credentials stay behind
authenticated access.

The selected parameters and their dated rulings are:

| Choice | Selected policy | Ruling |
| --- | --- | --- |
| Batching | Fixed window from first eligible arrival; later arrivals do not extend it | [Fixed window](https://github.com/schlessera/brain-kit/issues/683#issuecomment-5944687441) |
| Interval | 60,000 ms | [60 seconds](https://github.com/schlessera/brain-kit/issues/683#issuecomment-5947665720) |
| Group | Recipient principal + existing channel + delivery class, across threads | [Cross-thread grouping](https://github.com/schlessera/brain-kit/issues/683#issuecomment-5947756839) |
| Push eligibility | Current eligible pending approve/choose decisions with score >= 12 | [Inclusive cutoff 12](https://github.com/schlessera/brain-kit/issues/683#issuecomment-5947941215) |
| Digest | In-app Actions/FYI contribution at 09:00 and 17:00 | [Twice daily](https://github.com/schlessera/brain-kit/issues/683#issuecomment-5948582687) |
| Quiet hours | Strict local [22:00, 08:00), including retries; no deadline exception | [Strict pause](https://github.com/schlessera/brain-kit/issues/683#issuecomment-5948714622) |
| Notification zone | Each client's validated, last reported local IANA zone | [Client-time amendment](https://github.com/schlessera/brain-kit/issues/683#issuecomment-5948836407) |
| Digest coverage | B: new or explicitly reawakened waiting episodes only in the current client context | [Coverage B and shared recovery rules](https://github.com/schlessera/brain-kit/issues/683#issuecomment-5949226150) |

The client-time amendment supersedes the preceding ruling's server-configured
zone proposal for notification timing only. It preserves the strict quiet
interval and digest cadence. Budget days and deterministic snooze keep their
existing configured-zone rules.

## Eligibility, windows and counts

Use the existing server-computed priority formula with **zero Action attempts**:
`4 * stakes + 3 * deadlineUrgency + min(ageInWholeDays, 5)`, with nonnegative
age. Stakes are 1–3. Deadline urgency is 3 below 24 hours, 2 below 72 hours,
1 below seven days, otherwise 0. Preserve ordering and model-suggestion ceilings;
this cutoff changes delivery eligibility, not priority or permission authority
(`inboxPriority`, `packages/ui-server/src/inbox/state.ts:59-72`).

Push and digest delivery classes remain separate. A below-cutoff constituent
cannot piggyback into a push when a higher-priority Action joins the group.
FYIs stay digest-only under F9/R13, follow their existing validity/retention
rules, and never count as waiting decisions or against the Actions cap.

The first eligible arrival for a group starts its fixed 60-second window.
Retain each constituent's Action, waiting episode and thread identity even
though thread ID is absent from the grouping key. An arrival after dispatch
starts a new aggregate. The deadline governs server dispatch eligibility, not
device display time, provider storage TTL or transport urgency.

Before digest selection or **each destination's attempt**, recompute current
status, score and recipient authority in a transactional snapshot. Exclude
resolved, dismissed, expired, dropped, suppressed/deleted and still-snoozed
decisions. Counts reflect eligible constituent episodes in that attempt, not
the count at batch creation. Preserve immutable attempt history, including the
payload and count actually submitted. A historical notice is not claimed to
update on every device after an Action changes.

## Client-local timing and ownership

Quiet hours and the 09:00 and 17:00 digest schedule use each client's validated
local IANA timezone. Evaluate each authorized destination independently; two
devices can share a logical aggregate and have different dispatch eligibility.
Validate and persist zone metadata under authenticated client/destination
ownership. Refresh it on registration/rebind, reconnection, foreground return
and detected zone changes. Preserve registration compatibility and existing
activity behavior; metadata is a delivery preference, never a grant.

Missing or invalid metadata leaves these **new timed notices visibly pending
for refresh**. There is no silent server-zone or UTC fallback. While a client
is inactive, its stored zone is only its last reported zone: the server cannot
observe an inactive device moving between zones. A later lifecycle refresh
must recompute eligibility using current authorized ownership and the new zone.
Rebind must not carry another principal's notification authority with the zone;
revocation applies at every attempt.

Persist absolute timestamps/deadlines in UTC. The server clock still governs
timestamps, leases, retry and authorization; client clock skew cannot advance
a window, change grants or change budget/snooze semantics. Civil schedules must
follow the validated zone's offset/day changes and survive restart without
inventing another episode or replaying covered work. The client-local
Actions/FYI coverage is independent of global activity coverage/retention.

At the end of a destination's quiet interval, consolidate ready **unsent**
constituents from deferred batches into one current-count notice for that
principal/channel/push class. Keep each original 60-second deadline. Not-yet-due
work waits until its own deadline; ordinary available-send windows are not
prolonged. Another destination still in its quiet interval defers independently.
Every retry rechecks quiet status; arrival before 22:00 gives no exemption.

## Waiting episodes, receipts and recovery

A waiting episode begins when a new Action becomes pending or an explicit
snooze-to-pending reactivation occurs. Ordinary clock changes, version changes,
retry and restart do not create episodes. A still-snoozed Action is ineligible.

Digest B includes only currently eligible **below-cutoff** waiting episodes not
already reported in the authenticated client context. An unchanged episode
reported at 09:00 is omitted at 17:00, although the decision remains in Actions.
FYIs contribute separate new-only updates under their existing validity and
retention rules, with durable coverage; they do not join the waiting count.

Digest inclusion is neither a push receipt nor a read receipt. If a pending
decision later reaches score 12, it may receive its **first push** in that same
episode. Permit at most one **known successful push submission** per episode
per authorized destination. Do not send recurring reminders merely because
submitted work remains unresolved. Explicit snooze reactivation may permit a
new episode; retry, restart and elapsed time never reset that receipt.

Retry only destinations/constituents without known successful submission,
using existing bounded retry/backoff. Recheck current authority, quiet status,
score and waiting eligibility before each attempt. Keep earlier attempt records
when a retry's count changes; never resend a known-success component as newly
delivered. Distinguish an ambiguous outcome from known success. Provider
acceptance establishes submission, not display or reading, and this design
makes no claim of physical exactly-once delivery.

After missed digest generations, store **one current catch-up summary** at the
next available generation/client-return opportunity. Include all unreported
eligible current episodes regardless of creation age; do not replay every
missed slot. Commit durable client-context Actions/FYI coverage atomically with
the stored summary. Failure or racing generators cannot consume coverage
without a stored result. Do not copy activity's first-run 24-hour window and
lose older unreported waiting work. Global activity coverage/retention remains
unchanged. Episode, destination history and coverage are authoritative
operational state that must survive restart and export/restore; they never
belong in disposable `brain.db`.

## Examples that bind implementation

These are required outcomes with controlled clocks and captured transport,
not observed device deliveries. Assume current authority and an available
sender unless the example changes them.

| Situation | Required result |
| --- | --- |
| Push-eligible arrivals at 0/20/50 seconds, same or different threads, same principal/channel/class | One notice counting three decisions, eligible at 60 seconds, with the Actions deep link. The deadline is not 110 seconds. An arrival after dispatch begins a new fixed window. Other principals/classes stay separate. |
| Scores 11 and 12 | 11 stays digest-only; 12 qualifies for push. Fresh medium/no-deadline score 8 and low-stakes/48-hour-deadline score 10 remain digest-only; fresh high/no-deadline score 12 qualifies. FYIs never count or piggyback. |
| Local 22:00 versus 08:00 | 22:00 is quiet; 08:00 is outside quiet hours. Evaluate every attempt, including retry. |
| Qualifying arrival at 23:00, recorded deadline at 06:00 | No overnight deadline bypass; wait until 08:00 if still eligible. |
| Arrival at 21:59:30, fixed deadline 22:00:30 | Defer at dispatch even though arrival preceded quiet hours. |
| Three eligible overnight decisions, one resolves before local 08:00 | Recompute the morning notice to count two. A fourth first eligible at 07:59:45 is due only at 08:00:45 and cannot join the 08:00 send. |
| Two clients at 2026-10-03T13:00:00Z, zones America/New_York and Asia/Tokyo | New York is 09:00, eligible for its digest and outside quiet hours; Tokyo is 22:00, so its push attempts defer independently. One client's coverage is not the other's receipt. |
| New York offset change on 2026-11-01 | Local 09:00 is 14:00Z instead of the earlier offset's 13:00Z. Follow the civil schedule across offset/day changes; retain UTC deadlines and episode/coverage identity. |
| Missing/invalid zone, zone change, client skew or authenticated rebind | Missing usable metadata remains visibly pending, without server-time fallback. Refresh on every named lifecycle path; re-evaluate eligibility and current ownership. The server clock, budget days and snooze stay authoritative under their existing rules. |
| Below-cutoff episode reported at 09:00, still pending and unchanged at 17:00 | Omit it at 17:00; keep it in Actions. A new eligible 10:00 arrival appears at 17:00. |
| Explicit snooze and reactivation | Exclude while snoozed; reactivation starts a fresh reportable episode. A clock/version/retry/restart alone does not. |
| Older unreported eligible episode after missed slots or first generation | Include it in one current catch-up summary despite its age. A failed/racing generation does not advance coverage without its stored summary. Apply FYI validity/retention separately. |
| Device one accepts a two-decision submission; device two fails; one decision resolves before retry | Keep device one's two known-success components. Device two retries only its one remaining eligible unsent decision. Freeze the earlier payload/count; do not resend device one's successful components. Ambiguity is distinct from known success. |
| Digest-reported pending decision later crosses 12 | First push is eligible in the same episode. After a known success, unresolved state alone causes no repeat push. |
| Retry/restart or revoked principal | Persist episode/coverage/attempt history without inventing another episode. Recompute authority; a revoked principal receives no notice. |

The two-zone and offset examples were checked against the installed runtime's
`Intl.DateTimeFormat` using fixed UTC instants; they are fixtures, not a claim
about any deployment's zone or timezone-data version.

## Integration evidence and verification boundary

The existing notifier drops later same-tag activity intents instead of
incrementing an Action count
(`function createIntent(input: {`, `packages/ui-server/src/activity/notify.ts:90-126`).
The sender processes run-bound activity rows and settles one intent from a
device pass; that is not the required per-episode/per-destination Action history
(`async deliverPending(notifier) {`, `packages/ui-server/src/activity/push-sender.ts:194-273`).
Reuse concrete subscriptions, authorization, revocation and bounded backoff,
but add the Actions-aware aggregate and durable constituent/destination records.
This decision authorizes no new channel, extension seam or daemon.

The client already reads a zone for client environment
(`const zone`, `packages/ui-react/src/lib/client-environment.ts:107-108`).
Push rebind sends the subscription and label
(`rebindPushSubscriptionAfterLogin`, `packages/ui-react/src/lib/push-registration.ts:22-36`);
the server subscribe path does not persist that client's delivery zone
(`.post("/push/subscribe"`, `packages/ui-server/src/routes/push.ts:76-89`).
Collection for a chat environment is not authenticated notification-zone
binding or lifecycle freshness proof.

Existing activity digest generation serializes its transaction
(`generateActivityDigest`, `packages/ui-server/src/activity/digest.ts:31-39`)
and owns an activity-specific window/coverage marker
(`generateInTx`, `packages/ui-server/src/activity/digest.ts:41-101`).
Those mechanisms provide prior art; that global marker cannot represent
client-context waiting episodes or discard older unreported decisions.

Implementation verification must use the real notifier/sender with a local
captured push transport and multiple authenticated subscriptions, controlled
clocks, nonempty constituent sets and all examples above. Protect aggregation,
zone/current-state/authority, receipt, retry and atomic coverage with mutations
that fail the intended assertion. Include restart/export/restore and client
registration/rebind/reconnect/foreground/change paths. Predicate-only tests and
a successful transport submission do not prove device display, read state or
the full autonomous containment gate. Preserve additive registration contracts;
any unforeseen breaking change needs its own ruling. Hardware verification,
when separately required, must state the authorized device check and observable
receipt; this documentation supplies none.

## Alternatives and consequences

The seven comparisons on #683 separate product judgment from measured optimum.
The selections accept these tradeoffs; no optimal notification rate was measured.

- **Debounce until arrivals pause:** may reduce notices during a long burst,
  but extends initial waiting and adds a maximum-wait deadline. The fixed window
  bounds first eligibility; a long burst can produce several batches.
- **Five-minute window:** combines longer bursts but delays the first attempt.
  Sixty seconds favors timely notice while combining nearby escalations.
- **Per-thread batches:** give narrower thread context but can interrupt the
  same recipient several times. Cross-thread grouping gives one count and
  preserves constituent identity behind the Actions deep link.
- **Cutoff 8:** includes fresh medium stakes and more low-stakes deadlines.
  Cutoff 12 accepts later digest visibility for those decisions to reduce
  interruptions, while keeping Actions immediately available.
- **Daily morning digest:** updates less often but leaves post-09:00 arrivals
  waiting until the next morning summary. Twice daily adds a 17:00 update.
- **Deadline exception or server-configured notification zone:** an exception
  permits overnight interruptions; the strict pause refuses them. The explicit
  amendment requires client-local schedules instead of server time, accepting
  owned zone metadata, refresh work and inactive-client freshness limits.
- **A: repeat the complete lower-priority waiting snapshot:** gives a recurring
  backlog summary but repeats unchanged work. B reports new/reawakened episodes
  once per client context; the Actions destination retains the unfinished list.
  Durable coverage and one current catch-up preserve unreported older work.

Neither branch permits unbatched per-Action pushes, recurring push reminders,
digest push/email, notice mutation assumptions or permission bypass. The
[shared recovery comparison](https://github.com/schlessera/brain-kit/issues/683#issuecomment-5948933424)
defines the transactional counts, due-only consolidation, partial-device
receipts and atomic catch-up adopted with B.
