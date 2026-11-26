# Storage history and pressure guidance

## 2026-10-16 — Bounded layered history with qualified scenarios (#2014)

The maintainer approved the [reconciled bundle](https://github.com/schlessera/brain-kit/issues/2014#issuecomment-6212070681)
after comparing the layered proposal in #2044 with the concurrent policy review.
The [design](https://github.com/schlessera/brain-kit/blob/5a0ce18fdcecf0a6c5b83487c865a3f73806d5d0/docs/plans/storage-growth.md) specifies its encoding, qualification,
recovery and delivery rules. This decision records policy, not runtime delivery.

> **2026-11-02 — The design left `docs/plans/` ([#2511](https://github.com/schlessera/brain-kit/issues/2511)).**
> #2058 and #2059 delivered it in #2172. The shipped history and guidance
> shapes are in the integration contract
> ([Storage history and pressure guidance](../integration-contract/http.md#storage-history-and-pressure-guidance-additive-2058));
> the policy stays here. Read the design unchanged at the pinned link above.
> Its offline trace experiment moved to the
> [measurement archive](measurement-archive.md#storage-design-experiments-2511).

Keep 64 six-hour, 90 daily and 32 weekly endpoints: 186 records, four capacity
scopes and a 256 KiB serialized history ceiling. The same observations update all
three tiers without extra scans or catch-up work. Actual timestamps, gaps and
changed scopes remain visible. Compact tuples and bounded shared metadata trade
record overhead for longer daily retention; physical SQLite/WAL overhead remains
separately measured operational storage. Exhausted metadata capacity pauses
history rather than destroying previous valid evidence.

Observed rates describe measured change. The approved [seven-day and 30-day
windows](https://github.com/schlessera/brain-kit/issues/2014#issuecomment-6212083563)
yield conditional capacity-exhaustion scenarios, shown only with sufficient
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

## 2026-11-25 — Scenario drawing and shared constants (#4537, #4539, #4549)

The [epic rulings](https://github.com/schlessera/brain-kit/issues/4537) draw
this policy as a chart in the Storage pane's **Available space over time**
section ([the composed pane](design-kit/storage.md#2026-11-25--the-composed-pane-volumes-history-breakdown-and-tools-4537-4549)).
The policy above is unchanged; this records how it is drawn.

**Scenarios (D9).** Each qualified window is one dashed line, labelled with
its own window ("7-day rate · empty ~26 Jul"): short `7 4`, long `2 3`. An
unqualified window draws nothing and its caption says why, in the server's
reason ("gap inside the 7-day window", "under 30 days of history"). A
non-depleting window runs flat across its own span and reads "not running
out". There is no cone and no fill between two lines, because a range is not
a confidence interval. A line starts only at a measured current bucket: when
now is a gap or another volume's figure, no line is drawn
(`scenarioLines`, `packages/ui-kit/src/storage/history-geometry.ts:403-420`;
`storageScenarios`, `packages/ui-react/src/components/settings/storage/storage-history.ts:129-159`).
A changed scope draws no projection and says so.

**History (D3).** The chart draws actual endpoints of the selected volume in
the selected tier. Gaps break the line and are hatched with "? no observation
· not zero"; the current bucket is a hollow, provisional point; a point
measured under another root scope is drawn apart. Markers come from data the
pane already has (gaps, scope changes, owner refusals, each tool's latest run)
joined with the server's events timeline (#4541, #4548): warning starts,
steps, recoveries and ends, refusals and their resolutions, scope changes and
maintenance runs, at the server's times. An event both report is drawn once,
and a timeline that pauses a kind says so under the chart. Without a timeline
(an older host's 404, or any failure) the markers are the client's alone
(`storageMarkers`, `packages/ui-react/src/components/settings/storage/storage-history.ts:311`). The
exact endpoints table, including every per-owner figure, scope and collector,
sits behind **Measurements behind this chart**.

**Shared constants.** The Low and Very low ticks on the gauge and the bands on
the chart are drawn from the ui-sdk policy constants (#4539), the same values
the server's severity reads, so a tick sits where severity changes. There is
no threshold field on the wire.

**Notifications.** The Alerts row states the delivery rules above as they
run: notices only at Very low (Critical); the 22:00–08:00 quiet hours hold
them too; an unknown timezone sends nothing. Its quiet-hour bounds come from
the guidance response, and opening the pane never asks for permission.

### Alternatives and tradeoffs

- A filled cone between the two windows (brief rev 1) reads as a confidence
  interval, which the scenarios are not. One line per window keeps them as two
  conditional statements.
- Drawing only when both windows qualify hides a qualified window behind an
  unqualified one; each line stands on its own window instead.
- Starting a line at the last measured point when now is a gap would project
  from a stale value as if it were current; the chart says why there is no
  line instead.
- A per-volume threshold field on the wire duplicates policy the client
  already has as constants, and could drift from the server's severity.
- "Very low still alerts" in quiet hours (the brief's first draft) misstates
  the server, which holds Very low notices in quiet hours as this policy says.
