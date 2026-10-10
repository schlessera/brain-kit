# Action notices

A waiting decision is visible in the Actions destination as soon as it exists.
Notices only tell a person that decisions are waiting: a counted web push for
higher-priority work and the Actions/FYI contribution to the in-app digest for
the rest. Neither grants authority or resolves anything. The policy and its
binding examples are the [Action notification decision](decisions/action-notifications.md);
the wire additions are in the [integration contract](integration-contract/wire.md#action-notices-additive-683).

Migration `031_inbox_notifications.sql` holds every record below in the UI
operational database. They survive restart and the
[operational backup](inbox-recovery.md); none lives in disposable `brain.db`.
Persisted instants come from the server clock.

## Episodes

A waiting episode starts when a decision (`approve` or `choose`) becomes
pending: a new Action, or an explicit snooze-to-pending reactivation. The store
records it in the same transaction as that transition
(`recordActionEpisode`, `packages/ui-server/src/inbox/notify.ts:203-221`);
leaving pending ends it. Version changes, retries, restarts and elapsed time
never start one. Decisions already pending when the migration runs begin their
first episode then.

## Push windows

The activity runtime's 20-second tick calls `enroll()`. It recomputes each
open episode's current state inside one transaction: pending (not snoozed),
unexpired, undeleted, in an open thread, with the existing priority score at
zero attempts. A score of 12 or more is push class. Each recipient principal
(a usable owner of a bound push subscription) gets the episode once. An arrival is dated
when the episode became eligible (its start, for a decision eligible from the
outset; the observing tick, for a later promotion), so the tick cadence cannot
move it out of its window. The first eligible arrival opens a fixed 60-second
window for that principal; later
arrivals join it without moving the deadline, and an arrival at or after the
deadline opens the next window. Thread identity is kept on each constituent,
not in the grouping key. Below-cutoff decisions and FYIs never join a window.

Delivery runs after activity intents on the same reentrancy guard
(`deliverActions`, `packages/ui-server/src/activity/push-sender.ts:287-336`).
Each destination is evaluated on its own. `beginAttempt()` rechecks, in one
transaction, that the subscription is still bound to the principal and the
principal is usable, that the device reported a usable zone and is outside
local quiet hours [22:00, 08:00), and which constituents of due windows are
still eligible. It drops any episode this destination already has a known
success for, any that spent three attempts, and any still inside the
five-minute backoff. It then freezes the attempt's count, payload and
components before anything is sent. Due work from several deferred windows
therefore leaves as one current-count notice at 08:00, while work whose own
deadline has not passed waits for it.

The push service's answer settles the attempt once: `success` (accepted, not
displayed or read), `failed` (a provider status), `ambiguous` (no status, so
the request may have arrived) or `gone` (404/410, which also prunes the
subscription). An attempt left `in_flight` by a crash counts as ambiguous.
History stores a SHA-256 of the endpoint, never the endpoint or keys, and
cannot be edited.

## Client zones

The React client reports its IANA zone on registration and rebind, after the
first authenticated probe, on reconnection, on foreground return and when a
probe sees the zone change (`useNotificationZoneRefresh`,
`packages/ui-react/src/hooks/use-notification-zone.ts:22-77`). The SDK worker's
subscription renewal sends the device zone too. A client context is the
principal plus an identifier the browser persists, because ambient and proxy
modes give several browsers one principal. The server validates the zone
against its own zone database for that context and, only when the caller owns
it, that device. Coverage and dismissal belong to the context as well, so one
browser never consumes or hides another's summary. A missing or unusable zone leaves that device's notices and
that context's digest pending (`zone_required`), with no server-time or UTC
fallback. An inactive client keeps its last reported zone: the server cannot
see a device move until it reports again. Budget days and snooze keep their
configured-zone rules.

## Digest contribution

`digest()` runs on the tick and when a client fetches `GET /api/activity/digest`.
For a context with a usable zone it finds the latest local 09:00 or 17:00.
The card refetches after each zone report, so a first report shows its
summary without a reload. If
no summary exists for that slot it stores one, listing below-cutoff waiting
episodes and FYIs not yet reported to this context, and commits their
coverage in the same immediate transaction. Missed slots produce one current
summary, not a replay, and include older unreported work regardless of age.
A failed or racing generation stores nothing or returns the winner's result,
so coverage never advances without a stored summary. An episode reported at
09:00 is omitted at 17:00 but stays in Actions; a later push remains possible
if its score reaches 12. Activity digest coverage and retention are separate
and unchanged.

## Verification boundary

`packages/ui-server/tests/inbox-notify.test.ts` drives the real notifier and
sender with a captured local transport, several principals and destinations
and controlled clocks through every example in the decision record. A
captured submission is not device display, and nothing here enables the
autonomous system.
