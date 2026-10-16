# Storage history and pressure guidance

## 2026-10-16 — Bounded layered history with qualified scenarios (#2014)

The maintainer approved the [reconciled bundle](https://github.com/schlessera/brain-kit/issues/2014#issuecomment-6212070681)
after comparing the layered proposal in #2044 with the concurrent policy review.
The [design](../plans/storage-growth.md) specifies its encoding, qualification,
recovery and delivery rules. This decision records policy, not runtime delivery.

Keep 64 six-hour, 90 daily and 32 weekly endpoints: 186 records, four capacity
scopes and a 256 KiB serialized history ceiling. The same observations update all
three tiers without extra scans or catch-up work. Actual timestamps, gaps and
changed scopes remain visible. Compact tuples and bounded shared metadata trade
record overhead for longer daily retention; physical SQLite/WAL overhead remains
separately measured operational storage. Exhausted metadata capacity pauses
history rather than destroying previous valid evidence.

Observed rates describe measured change. Short- and long-window capacity
exhaustion estimates are conditional scenarios, shown only with sufficient
comparable evidence and identified by their windows. A range is not a confidence
interval. Missing, partial or incompatible data cannot produce a number or clear
a warning. Qualified flat/falling depletion is labelled without infinite headroom.
Weekly points support inspection, not forecast evidence. The offline experiment
qualifies deterministic cases; it does not establish real-world forecast accuracy.

Direct capacity warnings enter at 10% (Low) and 5% (Critical), with recovery
above 12% and 7%. Either qualified forecast within 30 days can trigger Low;
both within seven days can trigger Critical. Forecast recovery uses 45 and ten
days, preserving the either/both distinction. Recovery requires two qualifying
fresh observations at least 60 seconds apart and every active cause to recover.
Owner-confirmed no-space refusal independently enters Critical; missing evidence
cannot erase it. Pressure never authorizes cleanup, expiry or retention changes.

Show capacity evidence in Storage and the highest severity in a persistent app
indicator. Existing owner-authorized, opt-in Web Push can submit one Critical
notice per episode/subscription. Deduplicate durably and suppress stale/resolved
notices. No recurring reminders initially. Strict local 22:00–08:00 quiet hours
apply to initial delivery and bounded retries; unknown timezone is not guessed.
Notification copy contains no operational details. A transport receipt is not
proof of device display, and ambiguous delivery is not automatically retried.

### Alternatives and tradeoffs

- The original 64/32/32 allocation fit 128 records but supplied only one month
  of daily detail. Ninety daily observations preserve the later review's intent.
- The separate 128-recent/90-daily proposal lost the weekly horizon. Reducing
  recent detail to 16 days preserves both daily history and seven-month reach
  while keeping the byte and scan limits.
- Repeating verbose metadata in every record fails the compact payload objective.
  Shared metadata adds reference accounting and an explicit churn budget.
- Omitting forecasts entirely avoids misleading precision but loses the selected
  early-warning capability. Qualified scenarios retain uncertainty and direct
  capacity/refusal triggers remain independent.
- In-pane-only warnings cannot reach an absent owner. A persistent indicator and
  opt-in Critical push address that, while one notice per episode limits noise.
  This reconciled ruling supersedes the earlier daily-reminder selection.
- Repeated notifications after uncertain transport outcomes risk duplicate alerts.
  Durable unknown outcomes preserve honesty at the cost of a potentially missed
  push; the in-app state remains authoritative.

The first Storage pane still includes the complete safe-removal journey under
[S4=B](design-kit/storage.md); this later extension does not block that delivery.
