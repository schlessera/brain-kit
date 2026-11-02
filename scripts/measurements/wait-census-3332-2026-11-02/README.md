# Real-time wait re-census — 2026-11-02 (#3332)

This bundle re-runs the wait census from the #2763 acceptance audit
(`../test-cost-audit-2026-11-02/`) at a current `main` and classifies every
match in files that did not match at the #1849 inventory source.
https://github.com/schlessera/brain-kit/issues/3332 owns the work, under epic
https://github.com/schlessera/brain-kit/issues/1849 (maintainer ruling Q2,
option B, 2026-11-02).

## Sources

| Role | Commit |
| --- | --- |
| Census source (`main`) | `3984040f199cbadbee6e4ce3f1beff816b68dc36` |
| #1849 inventory source (baseline file list) | `5dc2595ca07042f2e2024c95bbc361f31637559f` |
| #2763 comparison source | `8e9855e706ab43dc1bb5b822296f171431e2546d` |

## Commands

From a brain-kit checkout with all three commits fetched:

```sh
git grep -n -E 'setTimeout|Bun.sleep|waitForTimeout|sleep\(' 3984040f199cbadbee6e4ce3f1beff816b68dc36 -- tests experiments ':(glob)packages/*/tests/**'
git show <archive-commit>:scripts/measurements/test-cost-audit-2026-11-02/wait-census-files-5dc2595c.tsv > base.tsv
bun scripts/measurements/wait-census-3332-2026-11-02/classify-waits.ts 3984040f199cbadbee6e4ce3f1beff816b68dc36 base.tsv > wait-census-lines-3984040f.tsv
```

The expression is the one `docs/process/test-waits.md` gives, unchanged.

## Counts

- Whole census at the source: 1,322 matching lines in 450 files
  (`wait-census-files-3984040f.tsv`).
- In scope: 604 matching lines in 204 files that do not match at
  `5dc2595c` (`scope-files-new-since-5dc2595c.txt`). That is the 197 files
  the #2763 audit listed, all still matching, plus 7 files that started
  matching after `8e9855e7` (`scope-files-added-after-8e9855e7.txt`).
- The classification has 605 rows: the 604 matches, plus one call site of a
  timer imported under another name (`setTimeout as pause`), which
  `test-waits.md` says to follow to its callers.

| Verdict | Rows |
| --- | ---: |
| justified | 374 |
| replaceable | 89 |
| not a wait | 142 |

`summary.tsv` breaks these rows down by role.

## Files

- `wait-census-lines-3984040f.tsv`: one row per in-scope line, with source,
  file, line, alias followed (`via`), search domain, literal milliseconds
  where the call has one, role, verdict, `comment_nearby` (a comment in the
  three lines above), the rule's reason and the source text (truncated to 240
  characters).
- `wait-census-files-3984040f.tsv`: per-file match counts for the whole
  census, in the same format as the #2763 census files.
- `classify-waits.ts`: the classifier. Its `RULES` list is ordered, and the
  first rule that matches a line classifies it. Each rule carries the reason
  written into the TSV.

## Verdicts

- **justified**: a role whose shape is its justification under the
  `test-waits.md` role table. These are failure maxima, condition polls,
  fixture or child holds, zero- or one-millisecond yields, timers that are the
  subject of the test, and simulated blocking work. Then there are the
  **negative observations** (`negative-window`, `negative-race`,
  `event-loop-liveness-window`): 84 rows in 46 files. Each is justified only
  once the source states its native opportunity next to the test, and 71 of
  them have no comment nearby. A later slice either states that reason or
  replaces the window with a causal completion barrier.
- **replaceable**: unconditional settling sleeps and test doubles that inject
  real latency. Each one gets an event, a fake clock or a condition, in
  reviewable slices. No timeout is raised.
- **not a wait**: type references, timer instrumentation (fake clocks, spies,
  descriptor capture and restore), handle declarations, sleep-helper
  definitions and production `socket.setTimeout` configuration.

## Limits

- The classification is **rule-based**: it reads the line and up to three
  lines on either side. The rules were checked against samples of every role,
  and the reviewed misfits were corrected (several are named in `RULES`).
  It is still not a hand review of all 605 rows. Each replacement slice
  re-reads the enclosing test before changing it and records any
  reclassification in its pull request.
- `ms` is the literal in the call. It is not an execution count, a duration
  sum or measured elapsed time; `test-waits.md` explains why those differ.
- Literal milliseconds across the 89 replaceable rows sum to 18,240. That
  figure is unweighted and is not a saving.

## First replacement slice

`packages/ui-server/tests/private-index-cache.test.ts`, lines 532, 549, 564,
609, 611, 627 and 692 at the census source, in the #3332 slice-1 pull request
against `epic/1849-test-cost`. The six rows classified `settling-sleep` were
replaced. Line 692, rule-classified `negative-window`, was reclassified on
review as a readiness wait for a held run. The idle-expiry cases now advance
the cache's registered timers on the file's existing `privateIndexClock`.
The advance and close cases wait for the held delta or run to start. The
pull request records the mutation receipts and focused timings.
