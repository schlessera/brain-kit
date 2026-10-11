# Haiku 5.5 as the current-path model

Investigation for [#1611](https://github.com/schlessera/brain-kit/issues/1611),
under the [eval lab epic](https://github.com/schlessera/brain-kit/issues/1603).
On 2026-10-11, every lean [#838](https://github.com/schlessera/brain-kit/issues/838)
scenario that measured `claude-sonnet-5-5` as its current path was rerun with
`claude-haiku-5-5`. The question: does the cheaper model hold up, and would
any recorded go/no-go change if it were the current path?

This report changes no decision record. Each record's go/no-go was measured
against the model the shipped path uses today, and still stands for it.

## Method

- **What was rerun.** Only the Claude current-path arm changed, plus #1593's
  tool-less tag step. The setup matched each scenario's original run: the same
  cases, three repetitions, disposable brains and permissions.
- **What was reused.** Jev judgments, frozen floors, deterministic baselines,
  label checks and goldens came from the Sonnet results. No Jev request was
  made and nothing was recalibrated.
- **How Claude ran.** Every session used Claude Code 2.1.295 on the logged-in
  subscription, with API-key variables removed, one session at a time. No
  usage limit, overage or rate limit stopped a run.
- **Effort.** No harness set an effort level. Ten pass `--setting-sources ""`
  or `project`, so they ran at Claude Code's model default. `847-job-fit`
  passes neither and inherited the user's `effortLevel: high`. The Sonnet runs
  used the same arguments, so within a scenario only the model differs.
- **Result files.** Each harness gained an `EVAL_CLAUDE_MODEL` override. Haiku
  results are in `results-haiku-5-5-2026-10-11.json` beside each Sonnet file,
  which is unchanged.

Three Sonnet-measured scenarios were not rerun: #841, #848 and the
turn-surface routing comparison. Their harnesses were removed in #1542, and
#838 forbids restoring them.

## Results at default effort

Held-out numbers, each scored the way its decision record reports it.

| Scenario | Headline | Sonnet 5.5 | Haiku 5.5 | Effect if Haiku were the current path |
| --- | --- | --- | --- | --- |
| [839 smart capture](../decisions/smart-capture.md) | type / target of 57 | 57 / 57 | 42 / 56 | No-go flips to go |
| [1593 routing-only capture](../decisions/routing-only-capture.md) | type / target of 78 | 78 / 78 | 48 / 61 | No-go flips to go |
| [845 opportunity lifecycle](../decisions/opportunity-lifecycle.md) | exact of 90 | 66 | 37 | Go for the command strengthens |
| [842 mechanical hygiene](../decisions/mechanical-hygiene.md) | exact source maps of 102 | 75 | 71 | Go for code strengthens |
| [850 import enrichment](../decisions/import-enrichment.md) | type of 57 | 56 | 45 | Lead narrows to a near tie; no flip |
| [843 canonical conflicts](../decisions/canonical-conflicts.md) | precision; false-report vetoes | 75%; 9 | 65.9%; 14 | Unchanged |
| [844 tag aliases](../decisions/tag-aliases.md) | outcomes of 69; alias recall | 68; 30/30 | 64; 30/30 | Unchanged |
| [846 speaking lifecycle](../decisions/speaking-lifecycle.md) | fully correct of 69 | 57 | 60 | Unchanged |
| [847 job fit](../decisions/job-fit.md) | exact decisions of 54 | 54 | 53 | Unchanged |
| [849 candidate extraction](../decisions/candidate-extraction.md) | exact of 303 | 301 | 284 | Unchanged |
| [1416 interpreted briefing](../decisions/interpreted-briefing.md) | fully correct of 42 | 36 | 28 (stored), 35 (rerun) | Unchanged |

**Where Haiku holds up.** It holds up on bounded classification and extraction
with explicit rules: 844, 846, 847, 849 and roughly 1416.

**Where it falls short.** It falls short on agentic write flows: 839, 1593,
845 and 842. Three failure modes recur:

- It files captures as `note` instead of choosing a type.
- It asks for clarification it does not need.
- It abandons a capture when the Bash allow-list denies its shell quoting,
  such as `brain add $'…'`: 7 no-writes in 1593, and 1–6 per run in 839.
  Sonnet never did this under the same permissions.

**Safety and agreement.** At default effort Haiku made no destructive error
that Sonnet avoided, but it agreed with itself across repetitions less often.

850's Haiku answers include 9 held-out invalid outputs, each JSON wrapped in
prose.

## Effort sweeps

839 and 1416 were also run at `--effort high`, `xhigh` and `max`. The level is
not recorded in the stream. The process arguments carried the flag, and
thinking tokens rise with the level.

| | Default | High | xhigh | Max |
| --- | --- | --- | --- | --- |
| 839 type correct, of 57 (Sonnet 57) | 42 | 37 | 38 | 49 |
| 839 tag recall (Sonnet 92.4%) | 54.5% | 47.0% | 50.0% | 66.7% |
| 839 no-writes; wrong-target appends | 1; 0 | 6; 0 | 4; 0 | 0; 1 |
| 839 agreement, of 19 | 15 | 13 | 14 | 11 |
| 1416 fully correct, of 42 (Sonnet 36) | 35 | 22 | 15 | 12 |
| 1416 failures only from mentioning the real date | 6 | 17 | 21 | 26 |
| Mean thinking tokens per session (839 / 1416) | 475 / 443 | 626 / 864 | 1257 / 1993 | 8645 / 9729 |
| Mean wall time per session (839 / 1416) | 5.8 s / 6.3 s | 6.2 s / 8.3 s | 10.1 s / 13.2 s | 45.3 s / 44.9 s |

Higher effort did not make Haiku a viable current path:

- **High and xhigh** were no better than default on either scenario.
- **Max** recovered some of 839's type accuracy and tag recall. It cost about
  18× the thinking and 8× the wall time, had the lowest agreement, and made
  the only held-out wrong-target append.
- **On 1416,** more thinking made Haiku mention the machine's real date
  instead of the scenario's pinned date. With that forgiven, no level beat
  default.

## Fixes found while rerunning

- **850 scorer.** The protected-frontmatter scorer treated an unindented
  `- item` tag list as an owner-field change and vetoed it
  (`protectedFrontmatter`, `evals/850-import-enrichment/score.ts:26-34`). The
  new assertion in `experiments/850-import-enrichment-score.test.ts` fails on
  the old scorer. Sonnet's writes had no such vetoes, so its results are
  unchanged.
- **849 isolation scan.** The scan matched its own scratch and runtime paths,
  so it flagged every transcript. It now strips those paths first. Rescoring
  without new calls shows no real access.

## Limits and pending judgments

- **One sample per cell.** Each was three repetitions on the authored
  Odysseus cases. The two Haiku runs of 1416 differ widely (28 and 35 of 42),
  so single-run gaps of a few points are within noise.
- **Pending judgments.** Some Haiku cells await the cross-family judgment that
  their decision records apply, and are marked pending in their result files:
  - **Content-loss reviews:** 26 cells for 839 at default effort, plus each
    effort run, and 34 for 1593. A pending cell counts as possible content
    loss until reviewed.
  - **Summary judgments:** 119 for 850, so its complete-case figure is an
    upper bound.

  These do not change the verdicts above.
  [#1608](https://github.com/schlessera/brain-kit/issues/1608) clears them.
- **Effort default.** Claude Code's default level for the ten scenarios that
  ignore user settings is not recorded in the stream.
  [#1606](https://github.com/schlessera/brain-kit/issues/1606) makes effort
  explicit.

Raw transcripts were kept outside the repository and are not part of this
record.
