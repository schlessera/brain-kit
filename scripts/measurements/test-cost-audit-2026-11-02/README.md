# Test-cost epic acceptance audit — 2026-11-02 (#2763)

Evidence for the acceptance audit of epic
https://github.com/schlessera/brain-kit/issues/1849, posted as a comment on that
epic. Every file was produced on 2026-11-02 by read-only GitHub API collection
or by `git grep` over immutable commits. Nothing here ran product tests.

## Snapshots

| Role | Source | CI run | Event | Runner image | Bun | Chrome |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | `5cf1d548f7bd3a314eb36394dc5db0268db97da6` | 38549344893, attempt 1 | `workflow_dispatch` (exhaustive) | ubuntu-24.04 20261004.327.1 (runner 20261002.596) | 1.4.2 | 154.0.8037.97 |
| Comparison | `8e9855e706ab43dc1bb5b822296f171431e2546d` | 41382713082, attempt 1 | `schedule` (exhaustive) | ubuntu-24.04 20261025.353.1 (runner 20261021.618) | 1.4.2 | 156.0.8078.47 |
| Main tip context | `c23a5811c323aeb2e9582a07788dfa44eb0ceff6` | 41490214079, attempt 1 | `push` (proof reuse; product jobs skipped) | — | — | — |

The comparison run's 13 resource receipts (13 of its 17 jobs) each record 4
logical CPUs and 15.6 GiB. The baseline run predates those receipts, so its resources
are known only by runner label. The browser jobs use the pinned
`mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27`
image.

## Files

- `hosted/run-*.json`, `hosted/summary-*.json`: normalized snapshots and reports
  from `scripts/ci-timings.ts` (no actor or runner host names, no full logs).
- `jobs.tsv`: per-job duration, setup steps, main proof step, start/end offsets
  and resource receipts for both exhaustive runs.
- `profiled-tests.tsv`: the originally profiled test durations. Baseline rows
  are single lines read from the run's job logs; comparison rows come from the
  run's `unit-proof-*` JUnit and `*-proof` `proof-cases.json` artifacts.
- `runtime-theme-cartesian.tsv`: the two runtime families still running a full
  width × theme matrix (filed as #3329).
- `theme-named-browser-cases.tsv`: per-project case counts and summed case
  time, and the subset whose names contain `dark` or `light`, from the
  comparison run's `proof-cases.json` artifacts.
- `wait-census-files-*.tsv`, `wait-census-files-new-since-5dc2595c.txt`:
  per-file match counts of the `docs/process/test-waits.md` census expression
  at the inventory source and at the comparison source, plus the files that
  match only at the comparison source.

## Commands

```sh
bun scripts/ci-timings.ts collect --run 38549344893 --resources --out tmp/audit-2763/base
bun scripts/ci-timings.ts collect --run 41382713082 --resources --out tmp/audit-2763/cmp
bun scripts/ci-timings.ts collect --run 41490214079 --resources --out tmp/audit-2763/cur
bun scripts/ci-timings.ts report --out tmp/audit-2763/<dir>
gh run download 41382713082 --repo schlessera/brain-kit --name <unit|browser|layout|endurance|runtime...>-proof[-N]
gh run view 38549344893 --repo schlessera/brain-kit --job <id> --log
git grep -n -E 'setTimeout|Bun.sleep|waitForTimeout|sleep\(' <sha> -- tests experiments ':(glob)packages/*/tests/**'
```

The census keeps `.ts/.tsx/.js/.mjs` matches without the inventory's manual
executable-shape review, so its counts are higher than the inventory's 597
lines at the same source. Compare the two census files with each other, not
with the inventory.

## Limits

- The two runs differ in source (19 days of development, about 3,900 more
  unit cases), runner image, Chrome and shard layout. Every comparison between
  them is **uncontrolled**. No saving here is a controlled benchmark.
- Observed runner time is summed executed job intervals, not billed minutes.
- No local profile was re-measured. The measuring host was shared with
  concurrent workers (load average 20–27 on 16 logical CPUs), and the
  original local profile records no host or resource identity to match.
- Theme-named cases are selected by name only; a name match does not establish
  that a case is a redundant theme copy.
