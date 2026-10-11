# Decision — do not adopt this Jev tag alias pipeline

The [#844](https://github.com/schlessera/brain-kit/issues/844) lean comparison
is a **no-go for the tested retrieval-plus-Jev pipeline**: adequacy as a
replacement is not established by this spike. It improves alias recall over
lexical detection, but misses an alias that the shipped audit skill finds in
every repetition. Jev recognizes that alias when shown it; the candidate
generator excludes it. There is no evidence here for replacing the current
judgment with this pipeline or for unattended alias adoption.

Measured on 2026-10-11 from main `9f0df4959887b2b549d628010a8e2af1e5c1bfff`,
with the [lean harness](../../evals/844-tag-aliases/run.ts) and [results
JSON](../../evals/844-tag-aliases/results-2026-10-11.json). No production
behavior, alias configuration or tag writer changes.

## What was compared

[Thirty-three authored Odysseus cases](../../evals/cases/844-tag-aliases.json),
with the pinned fictional date `2026-07-12`: ten tuning and twenty-three
held-out. The preserved twenty-three cases gained ten held-out cases covering
synonyms, an acronym, a homonym, hierarchy, negation, injection and sparse
usage. Every arm receives the same case; three repetitions preserve all cases.
Goldens never enter either evaluated model prompt. This is a nominal authored
held-out split, not a blinded or independent sample: the harness author could
see all cases.

| Arm | What runs |
| --- | --- |
| Current | Sonnet 5.5 through the subscription-authenticated Claude Code CLI, with the unchanged shipped `audit` skill installed in each disposable brain’s `.claude/skills/`. The product CLI indexes the case; the agent runs the audit and reads usages. The task restricts the skill to report-only tag-noise judgment. A structured answer records the proposed pair disposition. |
| Candidate | Code admits lexical variants, matching acronyms, shared tag components or two shared context words after an English stop list including common note-writing verbs; actor names still count. Core’s Jev client calls `jev-1.13.0` Choice with representative usages, separately in both orientations. Proposal requires candidate retrieval, orientation agreement on `same`, and both confidences at the tuning-selected floor. Every rejected pair is also judged diagnostically. |
| Lexical | The shipped `findVariantGroups`, with each case’s tag configuration. |

The fixed floor grid is `0, 0.5, 0.7, 0.8, 0.9, 0.95, 1`. Tuning chooses zero
false merges, then maximum recall, then the lowest floor. It selected **0**
(12/12 tuning alias trials, no false merges), before held-out dispatch. The 0.5
floor tied; higher floors reduced recall. Zero is no extra confidence
restriction, not a calibrated guarantee of correctness. With zero false merges
at every tested tuning floor, this sample cannot establish any safety benefit
from confidence filtering.

## Held-out results and vetoes

This is a **pair-prompted, report-only** comparison, not full audit discovery.
Twenty-three cases × three repetitions = 69 outcomes. Ten alias cases × three =
30 alias trials. False merges include any accepted negative or unknown in any
repetition; majority votes never erase them.

| Arm | Alias recall | Correct three-way outcome | False merge events | Original document changes | Veto |
| --- | --- | --- | --- | --- | --- |
| Current | **30/30 (100%)** | **68/69 (98.6%)** | 0 | 0 | No |
| Candidate | **27/30 (90%)** | 60/69 (87.0%) | 0 | 0 | No |
| Lexical | 3/30 (10%) | 33/69 (47.8%) | **3** | 0 | **Yes** |

Lexical detection merges `hosting` and `hoisting` on all three repetitions:
welcoming guests and raising a beam are different concepts. Its only recalled
held-out alias is `weave_pattern` / `weave-pattern`.

The candidate retrieves 20/23 held-out pairs and 9/10 aliases. Its sole alias
miss is `night-watch` / `guard-shift`. Jev answers `same` in both orientations
on every repetition, but the contexts share no retrieval words. Ignoring the
retrieval filter diagnostically yields 30/30 recall, 67/69 correct outcomes and
zero false merges. That is evidence about the judge, not an alternative pipeline
result or a go decision.

Three-way correctness requires an explicit `uncertain` on an unknown. Filtered
negatives count as correct rejections; filtered aliases remain misses; filtered
unknowns do not count as explicit correct abstentions. The candidate filters
both held-out unknowns, accounting for its other six incorrect three-way
outcomes. These are safe non-proposals, not false merges.

Excluding the weaker disjoint-context case leaves **27/27 alias trials recalled
by both Current and Candidate**, with zero false merges. Three-way correctness
then is Current 65/66 and Candidate 60/66; their remaining difference is how
unknowns are reported. Thus the recall no-go is sensitive to one declared
golden. It rejects this tested pipeline under that rubric, not Jev’s broader
feasibility or safety.

## Reliability

| Arm | Cases agreeing across all repetitions | Invalid answers | Explicit abstentions | Retrieval filters | Fallbacks |
| --- | --- | --- | --- | --- | --- |
| Current | 22/23 | 0 | 5 | 0 | 0 |
| Candidate | 23/23 | 0 | 0 | 9 | 0 |
| Lexical | 23/23 | 0 | 0 | 0 | 0 |

Current judgment varies on `ithaca-unknown`: two `uncertain`, one `different`.
All three avoid merging. Candidate final verdicts agree because retrieval
filters the sparse pairs, but **four orientation disagreements** remain in the
raw judgments. Direct judge-only verdicts agree on 22/23 cases: `ithaca-sparse`
varies between `uncertain` and `different`. The other unknown, `ithaca-unknown`,
has opposite orientation verdicts in all three repetitions. No alias or negative
pair verdict is unstable at the selected floor. Agreement counts are
descriptive; identical Jev requests and concentrated probabilities may give much
less effective variation than the agent runs. The 23/23 versus 22/23 comparison
does not establish greater candidate reliability. Fallbacks are zero by
construction: the harness contains no fallback model path, rather than treating
a failed Jev call as a fallback.

Measurement used 100 Claude CLI invocations (one label check and 99 current
runs) and 198 Jev HTTP attempts. Current runs report 338 agent turns, zero
permission denials, and only `claude-sonnet-5-5` in model usage. CLI invocations
are not individual internal model requests. Cross-family PR review is recorded
in the same results JSON, including its additional invocation. Cost and billing
were not measured.

## Label check

Claude Sonnet 5.5, a different family from the GPT-family case author, checked
every golden before measurement: **33 agreements, no wrong or ambiguous
verdicts**. No case was relabeled or dropped. Its reasons are in the results. It
specifically called the disjoint-context alias weaker evidence than the other
positives, because a guard shift could denote a scheduled unit rather than the
duty. Both usages describe guarding overnight; this declared golden was
retained. The sensitivity numbers above show the effect of excluding it. The
label prompt included proposed goldens, inviting anchoring. Labels are not
independently rediscovered; changed inputs require a fresh label check and
scratch directory.

## Limits and what would justify another evaluation

- This is a small authored regression set with short, often explicit usages,
  not a sample of real brains. The stop list includes common note-writing verbs and shared actor names count as context overlap, so retrieval is sensitive to the authored grammar. Templates and entities repeat across splits;
  confidence tuning and observed zero false merges offer no population safety
  guarantee. The retrieval rule was written with the public cases in view.
- Current has whole-file and audit access; Jev sees representative text;
  lexical detection sees tags. This measures the prescribed product paths,
  not an information-matched ablation. Prompting for the pair focuses the
  audit’s existing judgment; ordinary multi-phase audit discovery is unmeasured.
- Both orientations use separate requests, but repetitions from one model and
  shared authored contexts are correlated. The label reviewer is also the
  current arm’s model family. Free-text reasons are not model-scored.
- Pair fixtures do not measure candidate pruning on a large vocabulary,
  long mixed usages, end-to-end discovery, human review effort, performance,
  or migration correctness. All runs are report-only. The file comparison checks only original document bytes; new files, config changes and index effects are not scored. No claim about safe unattended writes follows.

A future evaluation would need candidate retrieval that includes disjoint
synonyms without admitting nearly every vocabulary pair, and richer positive,
negative and unknown usages. Direct Jev judgment is promising enough to test
with that retrieval, but this experiment selects no integration. If a later
comparison passes, the smallest change would supply reviewable alias proposals
to the existing config/report/apply path; it would not add another tag writer or
automatically adopt aliases.
