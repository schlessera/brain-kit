# Decision — retain the combined import enrichment call

The [#850](https://github.com/schlessera/brain-kit/issues/850) comparison is a
**no-go** for replacing the shipped combined call with Jev classification and
a focused summary generator. Jev's proposed tags were marginally better by
micro F1, but its type confidence floor rejected too much useful work. It
completed 36 of 54 classifiable held-out runs, against all 54 for the skill.
Even before abstention, Jev's type accuracy was lower. No product behavior or
provider default changes follow from this experiment.

Measured on 2026-10-11 under
[#838's lean protocol](https://github.com/schlessera/brain-kit/issues/838).
The [results](../../evals/850-import-enrichment/results-2026-10-11.json)
contain individual outcomes, changed files, label verdicts, summary judgments,
confusions and tuning calibration. The
[harness](../../evals/850-import-enrichment/run.ts) records its starting main
commit; the implementation and scoring changes are this PR's diff.

## What was compared

| Arm | What runs |
| --- | --- |
| Current | The shipped skill's enrichment instructions (`## Stage 3`, `packages/core/skills/brain-import/SKILL.md:80-85`), installed in each disposable brain's `.claude/skills/`, invoked for approved Stage 3 with Sonnet 5.5 (`claude-sonnet-5-5`). It writes type, controlled tags and a one-line summary. |
| Candidate | The shipped core Jev client (`createJevClient`, `packages/core/src/lib/jev.ts:248-338`), pinned to `jev-1.13.0`: one type Choice and one Noul per controlled tag. Code protects owner fields and bodies, abstains below the type floor, and calls Sonnet 5.5 with Read only for an empty mutable summary on an accepted source. |

The issue names no deterministic baseline. Both arms receive identical case
files, taxonomy definitions, approved paths and mutable fields. Existing
nonempty summaries are retained. There is no current-path fallback in the
candidate: rejected classification is review work, not a successful enrichment.
Claude uses the logged-in Max subscription with both Anthropic API-key
variables removed. The installed CLI is 2.1.295; its result metadata also
reports ancillary `claude-haiku-5-5` usage. The requested enrichment and summary
model is Sonnet 5.5. File tools are confined to each disposable brain.

## Cases and label check

The [preserved data](../../evals/cases/850-import-enrichment.json) contains
18 semantic cases and 18 scripted fault controls. Only semantic cases are
measured live; fault-control labels describe injected responses. Ten
[additional cases](../../evals/cases/850-lean-additions.json) add adoption versus
proposal, completed versus planned work, existing versus absent summaries,
damaged text and hostile attachments. Inputs use the Odysseus world and
`2026-07-12` reference date.

Sonnet 5.5 checked every one of the 28 semantic goldens once, before measuring
the arms. It accepted 26, flagged one wrong type and one ambiguous tag set:

- `held-dispute`: corrected `unclear` to `note`, with summary required. The
  conflicting recollections are classifiable reference material, even though
  they do not establish an adopted ruling. Its expected file effects were
  updated with that correction.
- `held-conditional`: excluded from scoring because the tag set was ambiguous.
  The preserved case remains in the source data and its verdict is retained.

The resulting set is **8 tuning and 19 held-out cases**, three repetitions per
arm. Held-out gold types are nine notes, four logbooks, four rulings, one custom
inbox entry and one unclear fragment. Duplicate files count as one case-run;
both approved copies must receive correct fields.

## Results

Held-out: 19 cases × 3 repetitions, **57 runs per arm**. Abstention remains in
the accuracy denominator. Tag precision/recall/F1 score proposed semantic tags,
including proposals that do not reach files.

| Metric | Current skill | Jev + focused summary |
| --- | --- | --- |
| Raw type correct | **57/57 (100%)** | 52/57 (91.2%) |
| Type correct at frozen floor | **57/57 (100%)** | 39/57 (68.4%) |
| Tag precision / recall / F1 | 0.986 / 0.933 / 0.959 | 0.960 / 0.960 / **0.960** |
| Summary-need decision correct | **57/57** | 42/57 |
| Actual type/tag fields correct | **52/57** | 42/57 |
| Required summaries produced | **48/48** | 33/48 |
| Required summaries supported and complete | **43/48** | 33/48 |
| Complete case correctness | **48/57 (84.2%)** | 36/57 (63.2%) |
| False completions | 0 | 0 |
| Wrong-target writes / content loss or rewrite / protected metadata changes | 0 / 0 / 0 | 0 / 0 / 0 |
| Unsupported summary claims | 0 | 0 |

Complete case correctness requires semantic labels, summary need, actual
type/tag fields, supported complete required summaries, and no write veto.
Protected owner type/tags are expected to stay unchanged; raw judgments are
scored separately. Timestamps, manifests, reorganization and later import
stages are outside the measured task. The skill sometimes reports summary need
after filling it; its actual generation decision is scored from file effects,
with the report retained separately.

Jev's raw type errors were `entry → logbook` three times on the HTML store
reference, and `note → logbook` twice on the missing-summary tools reference.
The 0.8 floor rejected all five, but also rejected thirteen correct classifiable
answers. It declined the archival escort, protected-owner decision, hostile
minute, custom inbox and both tools-reference variants in every repetition.
Three further abstentions correctly left the unclear fragment unwritten.

Jev missed `navigation` on all three archival escort runs and proposed
`stewardship` on all three unclear fragments. The skill missed `stewardship`
on all three disputed-meeting runs and `navigation` on two escort runs; it
proposed `stewardship` on one unclear-fragment run. The tiny F1 advantage does
not offset the candidate's coverage loss.

A GPT-family author judged all 107 distinct `(case, summary)` outputs against
the sources, allowing concise secondary-detail omissions while requiring the
main action/decision and material qualifiers. The skill's three escort summaries
lost essential undated, pre-Thrinacia provenance. Two planned-work summaries
used the ambiguous phrase “shed them” for returning tools to a covered shed.
Those five outputs are incomplete; no explicit invented delivery date, disposal
or completed work is inferred. The generated candidate held-out summaries
passed. These judgments cannot reverse the raw type or coverage gaps.

## Calibration and reliability

Tuning only: choose the lowest type floor with zero wrong accepted types;
maximize tag micro F1, choosing the lowest threshold on ties. The frozen values
are **type confidence 0.8** and **tag probability 0.5**. No held-out labels were
used to select either value. Tuning tags achieve F1 1.0 for both arms. The
skill has two false completions on the damaged tuning fragment; Jev leaves
all three repetitions unwritten at the selected floor.

| Held-out reliability | Current skill | Candidate |
| --- | --- | --- |
| Identical raw type/tag judgments across all repetitions | 17/19 cases | 18/19 cases |
| Identical effective label/summary-need/completion decisions | 17/19 | 19/19 |
| Invalid or unparseable retained answers | 0 | 0 |
| Abstentions | 3/57 | 21/57 |
| Full-current fallbacks | 0 | 0 |

One skill report keyed the identical duplicate files separately and listed
remaining summary paths. It was valid scoreable JSON and was normalized only
after confirming the per-file labels agreed; the original report is retained.
Candidate effective agreement hides raw variation on the tools reference:
every variant abstains. It is reliable refusal, not reliable completion.

Calls: **81 physical Jev requests; 164 Claude CLI invocations before PR review**.
Those Claude invocations are 81 retained skill runs, 51 retained focused
summary runs, one successful label check, one interrupted initial invocation
without case input, and 30 discarded invocations. The initial retry regex
mistook numeric metadata in successful JSON for rate-limit errors. All 15
affected measurement groups were rerun on pristine inputs after restricting
retries to error responses. The discarded calls remain counted and identified
in results; their transcripts stay outside the tree. No actual rate-limit or
subscription-exhaustion response occurred. CLI invocations are not counts of
the skill's internal model turns. Cost is not an evaluation metric.

The scorer also initially treated multiline mutable YAML tags as changes to
protected bytes. Rescoring saved full-file effects corrected that false veto;
unit tests protect multiline values, owner comments and conflicting duplicate
reports. All corrections are scoring/transport fixes, not prompt or threshold
tuning against held-out quality.

## Limits and what would justify another comparison

- Nineteen authored held-out cases are directional evidence, with only one
  custom-inbox and one unclear case. Three repetitions are correlated, not
  57 independent sources. The duplicated file pair is not extra sample size.
- Taxonomy is config-driven but this set uses only three substantive types
  and three controlled tags. Record-topic tagging remains a policy judgment;
  disputed-meeting stewardship was accepted as defensible by the label check.
- The author supplied the cross-family free-text judgments. Secondary detail
  omissions are tolerated; the stored reasons make that choice reviewable.
  Removing all summary judgments still leaves a substantial candidate type
  and completion gap.
- The focused generator sometimes repeats input-stamping metadata in tuning
  summaries, including empty tags/summary that its writer then fills. It
  needs a body-focused prompt before any integration claim; those input facts
  were not counted as fabricated source facts.
- This measures approved Stage 3 terminal file enrichment per case, not a
  complete import, batch scaling, resumability or hosted writes. The guarded
  candidate is not a production writer. No unattended-adoption certification
  follows for the existing skill either, especially given its tuning false
  completions.

There is **no integration task selected**. Retain the combined skill path.
Reconsider only with a separately reviewed dataset demonstrating fewer custom
taxonomy errors and materially better accepted coverage at a tuning-selected
floor, while preserving source bytes, owner fields, uncertainty and provenance.
Do not lower this run's floor on held-out results or ship classification-only
summary omission as equivalent enrichment.
