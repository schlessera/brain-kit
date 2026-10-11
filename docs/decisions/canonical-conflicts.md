# Decision — no-go for calibrated Jev canonical conflict judgments

The [#843](https://github.com/schlessera/brain-kit/issues/843) lean comparison
is a **no-go for replacing the current Phase 2 pass with this candidate**.
At the tuning-selected confidence floor of 0.8, code plus Jev reported only
14 of 27 held-out positive occurrences (51.9% recall), against the current
agent's 27 of 27. It made no false reports. The current agent made three
explicit prose-exclusion errors, plus six reports vetoed by the conservative
assertion/exclusivity rubric described below.
The candidate's confidence filter removes useful Role and Status judgments
along with the tuning paraphrase errors it was selected to suppress.

This record changes no production behavior. None of these results authorize
an unattended edit. The reports on prose and non-asserted injection text veto unattended use
under the shipped fact-reading rule; unknown-scope reports add conservative
uncertainty vetoes.

Measured on 2026-10-11 from main `9f0df4959887b2b549d628010a8e2af1e5c1bfff`.
The [harness](../../evals/843-canonical-conflicts/run.ts),
[cases](../../evals/843-canonical-conflicts/cases.json) and
[compact results](../../evals/843-canonical-conflicts/results-2026-10-11.json)
contain the complete scoreable outcomes. Raw CLI outputs remain outside the
checkout. The fictional observation day is pinned to 2026-07-12.

## What was compared

The shipped rules require configured canonical authority, unkeyed sources,
short structured facts, shared subjects, a newer canonical file, a gap of at
least seven days, and exclusion of paraphrases
(`## Phase 2 — Canonical-source conflicts`, `packages/core/skills/content-hygiene/SKILL.md:60-92`).

| Arm | What runs |
| --- | --- |
| Current path | An unchanged installed `content-hygiene` skill in each disposable brain's `.claude/skills/`, on Claude Code 2.1.295 and `claude-sonnet-5-5`. Only Phase 2 runs, with dry-run requested and a structured conflict report. Read/Glob/Grep/Skill and the real `brain config check` command are available. |
| Deterministic | A small port of the archived extractor's grammar and arithmetic rules. Exact Count/Date comparisons require literal shared subject, attribute, observation date, event and single-valued cardinality. Semantic pairs abstain. |
| Candidate | The same extractor, canonical config and exclusion/date checks. Count/Date comparisons stay in code. Semantic pairs receive sequential same-subject and contradiction Choices through the shipped core client (`createJevClient`, `packages/core/src/lib/jev.ts:248-310`), requesting and observing `jev-1.13.0`. |

This is a whole-pipeline code-plus-Jev versus agent comparison. Mechanical
eligibility checks are an intended advantage of code, not an isolated
measurement of Jev. The three-class unknown diagnostic is added by the harness;
the shipped pass specifies conflict reports and skips, not a ternary output.
A scope-unknown claim cannot justify an edit under the conservative evaluation
rubric, even though the shipped skill does not explicitly define exclusivity.

All arms receive identical case brains. There are three repetitions per arm;
the second Jev repetition reverses source order. Ten cases tune the confidence
floor and 22 are held out. Held-out has nine positive cases: three Role,
three Status, one Employer, one Count and one Date; two unknown cases and
eleven negative cases. Repetitions provide reliability observations, not 66
independent examples.

## Calibration and quality

The grid was fixed at 0, 0.2, 0.4, 0.6 and 0.8. Tuning minimizes false-report
vetoes, then maximizes true positives, then three-class correctness, then
chooses the lowest tied floor. Both Jev judgments must meet that floor.
The floor was selected before any held-out model runs and remained 0.8.
One negative case, repeated three times, drives the veto reduction. This is
a thin calibration basis and the no-go applies to this calibrated prototype.
At zero, tuning had 9/9 true positives and three false reports, all on the
role paraphrase. At 0.6 it still had one false report. At 0.8 it had zero
false reports, 6/9 true positives and 21/30 abstentions.

Held-out, 22 cases × three repetitions = 66 outcomes per arm. A conflict on
an unknown golden is a false positive. Unknown remains a separate class;
abstaining on a negative is safe for reporting but fails three-class accuracy.
Every false report counts, with no majority vote.

| Arm | Precision | Recall | Three-class correct | Conservative-rubric vetoes | Unknown correct |
| --- | --- | --- | --- | --- | --- |
| Current path | 27/36 (75%) | 27/27 (100%) | 54/66 (81.8%) | 9 | 0/6 |
| Deterministic | 6/6 (100%) | 6/27 (22.2%) | 27/66 (40.9%) | 0 | 6/6 |
| Candidate, floor 0.8 | 14/14 (100%) | 14/27 (51.9%) | 38/66 (57.6%) | 0 | 6/6 |

The current path reports all three repetitions of `h-injection` (not an
asserted role fact), `h-prose-miss` (explicitly excluded prose), and
`h-unknown-employer` (uncertain exclusivity). Three are explicit prose-exclusion
errors. The instruction case adds three fact-reading vetoes under the
conservative assertion rubric; the employment case adds three uncertainty
vetoes, not proven false employment claims. Those six depend on this rubric
rather than an explicit shipped exclusivity rule. Counting only the explicit
prose-exclusion errors gives precision 27/30 (90%) and three vetoes.
On known yes/no goldens alone, precision is 27/33
(81.8%) and recall remains 27/27. Counting only the explicit prose exclusion
would still give three vetoes; the no-go does not rest on the unknown case. Its three other three-class mismatches
are no on the absent-anchor case. That skip/no-report is correct shipped
behavior; only the evaluation schema asks for an unknown distinction.
No arm writes content; the current reports target the correct secondary files
and pass the literal canonical evidence check on held-out. The vetoes are wrong conflict reports
that could lead to an edit, not observed content destruction.

The calibrated candidate misses every Role positive (0/9), the assigned vs.
unassigned Status case (0/3), and one of three sole-employer repetitions.
It gets the two direct Status negations (6/6), the Employer case twice (2/3),
and all arithmetic positives (6/6). Deterministic recall is confined to the
arithmetic positives. Jev adds eight correct positive reports: 8/21 (38.1%)
recall on semantic positives, versus the current pass's 21/21. Its low-confidence semantic no
answers also become unknown at 0.8; the floor applies to every judgment.
Arithmetic pairs with mismatched attribute/event/date or multi-valued
cardinality abstain before Jev (`h-other-quantity`, `h-other-event`,
`h-multiple-dates`, `t-historical-count`). These safe non-reports miss the
auxiliary no label and explain additional three-class losses.

**Unselected diagnostic:** removing the floor from the already collected
held-out answers gives 27/27 recall, 27/27 precision, 54/66 three-class
correctness and zero false reports. That is encouraging raw semantic evidence.
It does not justify switching to zero after examining held-out. Zero failed
tuning's paraphrase veto, and this held-out split lacks a role-paraphrase
negative. A fresh comparison needs such negatives in held-out before claiming
that the calibration problem is solved.

## Reliability and label review

| Arm | Cases agreeing across all three repetitions | Invalid answers | Abstentions | Fallbacks |
| --- | --- | --- | --- | --- |
| Current path | 22/22 | 0 | 0/66 | 0 |
| Deterministic | 22/22 | 0 | 45/66 | 0 |
| Candidate, floor 0.8 | 21/22 | 0 | 34/66 | 0 |

Candidate disagreement is `h-sole-employer`: yes/unknown/yes; the reversed
order's confidence is 0.77, below the frozen floor. There were no retained
Jev transport failures: all 87 retained Choice calls answered with the pinned
model. Claude made optional denied shell-tool attempts (the results hold the count)
over the 96 scored current runs, then used the available reading tools; none produced
an invalid report. All held-out current conflict reports pass path/evidence validation. This
check applies only to the current arm: code fixes candidate spans and targets
from the actual files rather than asking a model to invent them. The initial
evidence matcher incorrectly rejected a tuning report containing the actual
canonical span plus a parenthetical. The scorer now accepts a literal span
inside that annotation and checks the unique secondary path. This corrects
two tuning provenance flags; held-out metrics and calibration are unchanged.
The summary command recomputes current-arm provenance from the original
canonical body literals, including prose. Matching literal evidence does not
make prose eligible for a conflict report.

Claude Sonnet 5.5 checked all 34 authored goldens once before measurement.
It accepted 32 and flagged two. We corrected `h-prose-miss` from yes to no:
Phase 2 excludes ordinary prose. We dropped `h-two-roles`: its unstated
shared scope made no vs. unknown genuinely ambiguous. Intentional unknown
cases remain. These original verdicts and reasons are recorded in the JSON.
The checker differs from the author's model family, as requested; it shares
a family with the current arm and supplies no independent validation of
Claude-versus-Jev differences.

The first cross-family PR review disputed `h-facts-ignore`: the shipped
exception is keyed, and its garden-jars key has no unkeyed mapping. We dropped
this genuinely ambiguous case from all arms after review. The original nine
outcomes and 23-case summaries are retained as sensitivity evidence. Before
this drop, current precision was 69.2% with 12 vetoes, candidate recall was
unchanged at 51.9%, and three-class correctness was 54/69, 30/69 and 41/69.
The threshold and the no-go do not change. Subsequent review also
challenged the unknown-employer and injection interpretations. We retain
those deliberate uncertainty/instruction cases, with the veto breakdown
above, rather than treating instruction-shaped text as an asserted role.
All reviewer verdicts and responses remain in the JSON.

A later fixture check found that the added inbox case used `inbox/` although
the effective core inbox is `notes/`. We corrected the path, obtained one
fresh Claude label verdict accepting no, and reran all arms three times on
that brain. The nine earlier outcomes are excluded; their provider calls
remain in the total. This changes the input to implement its stated golden,
not the label to match model output.

The initial collector also unnecessarily repeated four successful Claude
calls because numeric metadata matched `429`. The corrected check requires
a failed call and examines failure text. Scoring uses the first successful
output of every repetition; all four labels match their later outputs, so
this recovery changes no scored labels. All dispatches remain counted.

Before the first cross-family PR review, total dispatches were 108 Claude CLI calls
and 93 Jev client calls. That includes two label-check calls, the corrected
inbox reruns and the four unnecessary repeats. Six Jev calls belong to the
excluded initial inbox inputs. The final running count is **111 Claude CLI
dispatches and 93 Jev client calls**, including three cross-family PR reviews.
Claude credentials were removed from every child environment;
all calls used the logged-in subscription. No subscription limit was hit.
Jev's shipped client may internally retry HTTP attempts; the count is client
calls, not a physical HTTP accounting claim. Cost was not measured.

## Limits and what would change the decision

These are small authored brains, not a sampled production corpus. Eligibility
coverage includes configured inbox and archive directories, recency boundaries,
historical facts, absent anchors, rejected quotes and injection.
The arithmetic premise is a narrow experimental convention; the extractor
recognizes only two explicit fact layouts. Prose, multi-fact discovery, Month
YYYY, keyed drift, full hygiene reconciliation and Phase 3 replacement effects
were not measured. The historical exclusion is a conservative authored convention; the
shipped unkeyed pass does not state it as explicitly as the keyed pass does.

Current-path tools were limited to the disposable brain's Phase 2 work and
read/config operations. Denied optional shell attempts could affect its behavior.
The second Jev repetition combines source-order sensitivity with repetition
variation; it does not isolate either cause. Agreement measures reported labels
and validity, not identical explanatory prose. Confidence is not truth, and
an abstention-heavy arm's agreement does not establish useful recall. The
Jev prompts were authored with all case categories in view, including the
held-out rejected quotation. Only the numeric floor was tuned without
held-out outcomes; this is not a blind test of prompt generalization. Tuning
mostly uses pipe syntax and held-out mostly colon syntax.

The candidate conservatively gates a no answer on both same-subject and
contradiction confidence; even a confident contradiction-no can abstain
when same-subject confidence is low. It also returns unknown for arithmetic
scope mismatches that could be classified as no. These are weaknesses of
this measured prototype, not evidence of Jev failures. No post-held-out
changes to those judgment rules are included in the headline comparison.

No product integration follows this no-go. Re-evaluation should establish a
tuning rule that preserves the explicit Role/Status positives while suppressing
paraphrase conflicts, then test it on fresh held-out paraphrase controls.
Any later accepted integration should remain report-only through the existing
hygiene candidate path; classification supplies no replacement authority.
