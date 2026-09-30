# Recorded corpus trends use one conservative verdict

**2026-10-01.** The [maintainer's ownership ruling](https://github.com/schlessera/brain-kit/issues/592#issuecomment-5907172308)
and [comparison ruling](https://github.com/schlessera/brain-kit/issues/592#issuecomment-5907216663)
put deterministic classification in core. Stats JSON, human output, maintain,
briefing and the PWA reuse the same verdict and explanation. The PWA uses its
existing callout ladder: a current-value finding takes precedence for that
metric, with the recorded comparison added to its evidence. Complete
comparisons remain visible in receipts below the single leading notice. A
chart for an incomparable metric is replaced by the supplied explanation,
so incompatible recorded definitions are not connected as one trend.

## Calendar windows, not observation positions

The recent window includes today and its preceding six UTC calendar days.
The baseline is the preceding seven days. They never overlap. A metric
requires at least three valid daily observations in each, and the latest
used recording must be within 48 hours of the evaluation clock, inclusively.
Future dates and recordings do not participate. Same-day entries follow the
history reader's later-recording rule; an invalid later recording is not a
reason to fall back to an earlier duplicate.

Medians use the ordinary mean of the two middle values for an even sample
count. Gaps stay gaps. A recording must have a valid timestamp on its stated
UTC day; ratios must be finite in 0..1 and counts nonnegative safe integers.
Broken-link rows require a positive link denominator, a broken count no
greater than that denominator, and the recorded rate to equal their ratio.
Rate and count medians use exactly the same eligible rows. Separate lists can
fabricate a worsening rate/count combination which no daily record measured.

## Initial policy, not calibration

- Coverage: baseline minus recent median >= 0.05, with recent strictly below
  the configured coverage floor.
- Broken links: rate rise >= 0.01, count rise >= 3, and recent rate strictly
  above the configured ceiling.
- Orphans: count rise >= 5 and relative rise >= 0.20. From zero, only the
  absolute gate applies; relative change is null, never infinity.

These are the approved initial, uncalibrated thresholds. Comparisons use
unrounded numeric values. The core explanation prints round-trip decimal
representations, including fractional rates rather than rounded percentages,
so a boundary does not appear to contradict its verdict. It reports movement
and its observed dates, without inferring a cause. No new threshold framework,
LLM judgment, push notification or automatic remediation is introduced.

## Provenance is required

Compatibility is explicit rather than an unbounded semver assumption:

| Recorded version | Coverage semantics | Broken links and orphans |
| --- | --- | --- |
| 0.37.0, 0.38.0 | Total chunks/vectors | Reviewed original health definitions |
| 0.39.0 | Ambiguous development provenance; incomparable | Same health definitions |
| 0.40.0 | Eligible chunks/vectors, approved for the next release | Same health definitions |
| Missing, malformed, prerelease or any other version | Unsupported; incomparable | Unsupported; incomparable |

Source history shows the history implementation in `878e6cfa` and the
eligibility implementation in `fa6a62c7` both recording manifest version
0.39.0. That version alone cannot distinguish their coverage definitions.
The integration contract assigns the history addition to 0.40.0, whose
approved release includes the eligible-only definition. Old total coverage
and new eligible coverage cannot be compared. Unknown patch/minor versions
are deliberately declined until their metric definitions are reviewed and
this compatibility table and its tests are updated. Nothing rewrites old
snapshots or infers their semantics from a timestamp or apparent ratio.

Insufficient, stale and incomparable observations are distinct from a
measured comparison whose warning rule is not met. Unusable history produces
no warning or healthy claim in briefing or the PWA. JSON retains the reason
and partial sample evidence. Evaluation is read-only: maintain and
`stats --record` keep the existing recording and retention behavior, and
evaluate the history available before their write.

## Alternatives rejected

- Comparing the last seven observations: sparse histories would compare
  different durations, and retention would change their meaning.
- Padding missing days with zero: unknown coverage would become a collapse,
  and a missing orphan count would create a false rise later.
- Separate UI classification: thresholds, clocks, provenance and medians
  would drift from the command surfaces.
- Assuming every version is compatible: the coverage denominator has a
  documented semantic break, including an ambiguous development version.
- Rounded verdict inputs or causal explanations: the former changes policy
  at boundaries; the latter claims evidence that the snapshots do not carry.

Fixed-clock histories cover boundaries and invalid/paired rows. Real temporary
CLI fixtures cover JSON, text, briefing and maintain while checking that
evaluation leaves the JSONL bytes unchanged. Consumer tests use actual core
verdicts; Chrome checks that their full evidence fits the 320px stats answer.
