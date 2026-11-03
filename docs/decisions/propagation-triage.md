# Decision — Jev propagation triage is feasible on supplied source context

**Conditional go for a scoped binary forwarding integration; no adoption of
unattended date changes or a three-class semantic verdict.** On these authored
cases, `jev-1.13.0` matched the audit skill's Sonnet review judgment for whether
a propagation finding needed owner review. Both identified all eight held-out
still-current cases and forwarded all sixteen stale/uncertain cases, in every
one of three repetitions. Adding explicit source diffs preserved that result.

The experiment does not establish that arbitrary documents can be safely
acknowledged, or change what `updated` means. Production behavior is unchanged.
Integration needs a separately approved acknowledgement policy and source-revision
provenance. The [audit skill](../../packages/core/skills/audit/SKILL.md) currently
prohibits advancing `updated` when content did not change.

Measured on 2026-11-03 for [#3445](https://github.com/schlessera/brain-kit/issues/3445),
under [#838](https://github.com/schlessera/brain-kit/issues/838)'s lean protocol,
from `d38eb1eb5b3a9b1f3228d8e317990dc14471be08`.
The [harness](../../evals/3445-propagation-triage/run.ts),
[cases](../../evals/3445-propagation-triage/cases.json),
[label review](../../evals/3445-propagation-triage/label-review.json),
[full-text results](../../evals/3445-propagation-triage/results-2026-11-03.json)
and [diff-assisted results](../../evals/3445-propagation-triage/results-with-diff-2026-11-03.json)
retain the scoreable observations and typed Jev responses.

## What each request receives

One case contains the pinned observation day `2026-07-12`, declared generation
scope or its absence, every configured source's complete current and available
previous Markdown, and the complete derivative, including frontmatter. Gold
labels and authored explanations are excluded. Missing history stays missing.
There is no private content, retrieval pass, truncation or generated change summary.

The second comparison additionally receives code-computed unified diffs from the
supplied reference source snapshots to the current sources, their availability,
and the derivative's reference date. These fixtures associate a source snapshot
with that date; the experiment does not discover it in Git. In production, a
recorded generation/review revision is stronger provenance than a date-only guess.

Both comparisons use the same question, labels and cases. A single Jev Choice
asks whether the derivative remains correct and sufficiently complete for its
scope: `still_current`, `needs_update`, or `uncertain`. The instructions require
positive evidence for currency, account for historical scope and relevant
omissions, and treat embedded document instructions as data. Jev decides no date,
permission, patch or source-revision identity. The actual question is retained
in each results file's provenance.

The current-review arm runs the unchanged audit skill with the same rubric and
case state through subscription-authenticated `claude-sonnet-5-5`, with tools
disabled. This is a structured diagnostic of its propagation review/propose
step, not a full shipped agent sweep or an existing auto-dismiss feature. The
deterministic baseline forwards every finding, represented as `uncertain` with
a fallback; it makes no three-class semantic assertion.

The corpus has twelve tuning and twenty-four held-out cases, balanced by label.
It covers paraphrases, irrelevant changes, already-reflected updates, changed
facts and requirements, negation, historical scope, multiple sources, missing
history, unknown scope, unresolved references/authority/timing, and copied
instructions. Independent Claude-family review agreed with 35/36 GPT-authored
golds and requested one authority clarification. It was applied before scored
calls without changing its `uncertain` label; the conditional approval and
author's resolution remain explicit. No false-safe golden was found.

## Held-out outcomes

Each row represents 24 cases × 3 repetitions, not 72 independent documents.
Only accepted `still_current` avoids forwarding; both other labels forward.

| Context and arm | Correct routing | Still-current accepted | False acknowledgements | Stale/uncertain forwarded | Three-class correct | Three-class agreement |
| --- | --- | --- | --- | --- | --- | --- |
| Full text, deterministic | 48/72 | 0/24 | 0 | 48/48 | 24/72 | 24/24 |
| Full text, Sonnet skill judgment | 72/72 | 24/24 | 0 | 48/48 | 70/72 | 23/24 |
| Full text, Jev | 72/72 | 24/24 | 0 | 48/48 | 49/72 | 23/24 |
| Full text + diffs, deterministic | 48/72 | 0/24 | 0 | 48/48 | 24/72 | 24/24 |
| Full text + diffs, Sonnet skill judgment | 72/72 | 24/24 | 0 | 48/48 | 65/72 | 23/24 |
| Full text + diffs, Jev | 72/72 | 24/24 | 0 | 48/48 | 51/72 | 24/24 |

Still-current precision and coverage are both 100% on this authored sample for
both provider arms; forwarding recall is also 100%. No provider response was
invalid, unavailable or fell back. The deterministic baseline always forwards,
so its zero acknowledgements give undefined precision and zero coverage. Its
lower routing correctness measures unnecessary owner review under this rubric,
not a shipped safety defect. All arms have 24/24 **binary routing** repeat
agreement in both comparisons.

Jev usually collapses uncertainty into `needs_update`: 23/24 uncertain held-out
occurrences without diffs, and 21/24 with diffs. Sonnet does so in 2/24 and 7/24
respectively. Those are three-class errors, although all correctly forward.
With diffs, the three remaining Jev unknowns are all repetitions of the missing
signal-to-permission mapping. The diff comparison slightly changes fine labels
but supplies no observed routing improvement. It is not evidence that a diff
is unnecessary for longer or less explicit documents.

The fixed grid is `0, .4, .6, .8, .9, .99, 1.01`; the last disables acceptance.
Tuning prioritizes zero false acknowledgements, then correct acknowledgements,
three-class correctness and the lowest tied floor. Both comparisons selected
**0**, saved before their first held-out request. No confidence filter improved
tuning safety. This is not a claim that confidence zero establishes truth.
On tuning, Jev's three-class scores were 25/36 without diffs and 26/36 with
diffs; the forwarding boundary remained correct. No
held-out answer changed the floor, question or golds.

## Date-only mechanics and limits

The real audit compares `updated`, not semantic changes (`audit`,
`packages/core/src/lib/auditor.ts:658-734`). Propagation has only a manual
repair handler (`repairHandlers`, `packages/core/src/lib/hygiene-repair.ts:127-154`).
The offline experiment applied the shipped surgical editor to real disposable
files, rebuilt their disposable index and ran the real audit before/after.
For all 36 cases, changing only the derivative's `updated` cleared propagation,
preserving all other fields, body bytes and source files. It also cleared the
warning on every deliberately stale case. Remaining findings are retained in
the results. Warning clearance is therefore no proof of correctness.

Six offline tests cover scoring/calibration, repetition accounting, real
index/audit behavior, byte preservation and reference-diff availability. A
mutation excluding uncertain golds from false-acknowledgement vetoes made the
named test fail on the intended count (expected one, received zero); restoring
it passed. An independent Python recount reproduced the saved confusion
matrices and agreement counts. Typechecking and repository preflight passed;
the latter ran 1,142 tests in 51 files. These are focused/local proofs, not a
claim that all hosted suites passed.

Runtime: Bun 1.4.2, Claude Code 2.1.316 and Git 2.51.0. Requested and observed
Jev model: `jev-1.13.0`; Sonnet usage was observed for every current-arm call.
Claude Code also reported Haiku 5.5 usage on some invocations; it is not a
separate comparison arm. Both Anthropic API credential variables were removed
from current-arm children. Total scored dispatches: 216 Claude invocations and
216 Jev client calls across the two contexts; the core client can retry HTTP
rate limits internally. The combined conservative guard debit was $4.586401
against $15. It combines CLI-reported subscription list-price usage and Jev
input-byte reservations, not an invoice or cost comparison. T3 label/PR review
subscription usage is outside that dollar figure.

The documents are short, fictional and authored with mostly explicit scope.
We did not measure real provenance discovery, Git history selection, inferred
scope, long documents, extraction errors, missing context under token limits,
model upgrades, races, downstream propagation effects, or crash-safe writes.
The author knew the golds. The same held-out cases were reused for the
user-requested diff comparison after control answers were visible; it is not a
new blind validation set. The control ran sequentially; the diff comparison
used at most two isolated current-arm children. No latency comparison follows.
Three repetitions and zero observed false acknowledgements do not establish
a production false-acceptance rate.

## Smallest integration supported

The bounded opportunity is a forwarding filter with complete, established
source context. Only the positive `still_current` result can propose avoiding
the card. All other outcomes remain review findings, without presenting Jev's
`needs_update` label as a proved contradiction. Invalid or stale input and
unavailable provider/context always retain review. The existing persistent
provider opt-in must remain explicit; credentials alone cannot enable it.

Before adopting date-only resolution, decide how to record source freshness
without falsely claiming a content edit or creating downstream timestamp churn.
Any acknowledgement needs to bind the consulted source revisions, derivative
bytes and generation scope and become invalid when relevant evidence changes.
The date, hash computation, byte checks and write stay in code. This experiment
does not approve a particular new frontmatter field, contract change, model
default, generic seam or production writer. Those belong in a scoped follow-up
with explicit policy and normal product proof. That work is captured in
[#3452](https://github.com/schlessera/brain-kit/issues/3452), which needs the
maintainer's acknowledgement-policy decision before implementation.
