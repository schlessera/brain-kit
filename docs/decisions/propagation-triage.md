# Decision — Jev propagation triage is feasible on supplied source context

**Conditional go for a scoped binary forwarding integration; no adoption of
unattended date changes or a three-class semantic verdict.** On these authored
cases, `jev-1.13.0` matched the audit skill's Sonnet review judgment for whether
a propagation finding needed owner review. Both identified all eight held-out
still-current cases and forwarded all sixteen stale/uncertain cases, in every
one of three repetitions. Adding explicit source diffs preserved that result.

The experiment does not establish that arbitrary documents can be safely
acknowledged, or change what `updated` means. The comparison itself changed no
production behavior; the subsequently approved opt-in integration is recorded
below. The [audit skill](../../packages/core/skills/audit/SKILL.md) still
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

The comparison's review arm ran the then-shipped audit skill, pinned by the saved hash, with the same rubric and
case state through subscription-authenticated `claude-sonnet-5-5`, with tools
disabled. This is a structured diagnostic of its propagation review/propose
step, not a full shipped agent sweep or an existing auto-dismiss feature. The
shared rubric supplies the substantive semantic criteria; the skill itself
only instructs proposing propagation repairs to the owner. The deterministic
baseline forwards every finding, represented as `uncertain` with
a fallback; it makes no three-class semantic assertion.

The corpus has twelve tuning and twenty-four held-out cases, balanced by label.
It covers paraphrases, irrelevant changes, already-reflected updates, changed
facts and requirements, negation, historical scope, multiple sources, missing
history, unknown scope, unresolved references/authority/timing, and copied
instructions. Cross-family review by `claude-sonnet-5-5` agreed with 35/36 GPT-authored
golds and requested one authority clarification. It was applied before scored
calls without changing its `uncertain` label; the conditional approval and
author's resolution remain explicit. No false-safe golden was found. This
reviewer is independent of the GPT-family author, but uses the same model as
the Sonnet comparison arm and shares any of that model's blind spots. It read
the rubric before labelling; the exact requested clarification received no
second model review.

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
both provider arms; forwarding recall is also 100%. No **held-out** provider
response was invalid, unavailable or fell back. In diff-assisted tuning,
Sonnet's second repetition of `t-missing-scope` produced one invalid structured
answer (`error_max_turns` without structured output). It was counted as an
uncertain fallback, not retried or credited as correct; its original stdout
remains in external scratch. That tuning arm
scored 30/36 with 10/12 three-class repeat agreement. The deterministic baseline always forwards,
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
tuning safety. A floor of zero filters nothing: observed safety rests on the
raw model choices across only sixteen distinct unsafe held-out cases, not on
a confidence safeguard. This is not a claim that confidence zero establishes truth.
On tuning, Jev's three-class scores were 25/36 without diffs and 26/36 with
diffs; the forwarding boundary remained correct. No
held-out answer changed the floor, question or golds.

## Date-only mechanics and limits

The real audit compares `updated`, not semantic changes (`audit`,
`packages/core/src/lib/auditor.ts:663-744`). Propagation has only a manual
repair handler (`repairHandlers`, `packages/core/src/lib/hygiene-repair.ts:127-154`).
The offline experiment applied the shipped surgical editor to real disposable
files, rebuilt their disposable index and ran the real audit before/after.
For all 36 cases, changing only the derivative's `updated` cleared propagation,
preserving all other fields, body bytes and source files. It also cleared the
warning on every deliberately stale case. Remaining findings are retained in
the results. Warning clearance is therefore no proof of correctness.
All authored mechanics fixtures use unquoted, LF-terminated date lines;
different quoting and newline styles are outside this corpus's coverage. The
post-review offline rerun derives changed fields from parsed file readback
and asserts that the sole changed path is the derivative. The preserved-byte
flag is a successful invariant check, not an independent semantic measure.

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
Claude Code also reported Haiku 5.5 usage on most invocations: 199/216 (101 in
the control, 98 with diffs). It is not a separate comparison arm. The retained
usage model names are invocation-level observations; they do not independently
attribute the structured label to a particular model. Sonnet is the explicitly
requested primary model. Both Anthropic API credential variables were removed
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
[#3452](https://github.com/schlessera/brain-kit/issues/3452), where the maintainer
subsequently authorized the bounded integration below.

## Approved separate freshness acknowledgements

On 2026-11-03 the maintainer directed implementation, retaining the source diff
and adding user-controlled confidence/risk settings and possible extra questions.
The implementation chooses separate Markdown receipts, preserving the established
meaning of content-edit dates. Canonical `hygiene.propagation.enabled` is the
owner's opt-in, off by default. A credential is never that authorization.

Automatic review receives complete current/reference sources, the derivative,
explicit scope, the UTC observation day and code-computed source diffs. An
explicit `propagation_reference` takes precedence; otherwise a recorded Git
commit containing the exact derivative bytes supplies the reference. This is
a content-version baseline, not a claim about generation time. Missing old
sources, historical links, unknown scope, exclusions and input limits leave
the finding for a human instead of guessing history or clipping evidence.

`context/hygiene/propagation-reviews.md` stores typed judgments and hashes.
Read-only audit applies a receipt only while full evidence and current policy
match. Changed source/derivative bytes, scope, observation day or model/question
version invalidate it. The observation day matters: unchanged source text can
describe a future transition that becomes current tomorrow. Threshold changes
re-apply gates to saved answers without a new paid request; missing extra
question answers require a fresh request. Negative judgments are cached too,
and bounded passes consider unseen/oldest-reviewed paths first.

Before publication, code checks current input/config bytes and the receipt
file again. Only the operational Markdown receipt is changed; source prose,
frontmatter and dates remain byte-identical. This is not a cross-file atomic
transaction. A review failure remains a finding, not a repair claim.

Hosted interactive hygiene remains credential-free/shared. The separate,
operator-enabled daily propagation job uses credentialed/exclusive maintenance
and the same wrapper as other repository jobs; it is never trusted/unwrapped.
Normal CLI reconciliation can perform the same work when its explicit brain
opt-in and provider access are available. Source/provider failures never
broaden worker credentials or fall back to executing outside the boundary.

## User-selected confidence and cross-checks

The original measured currency Choice remains the main gate. The optional
assertions and coverage Choices ask whether all included claims remain supported
and all required in-scope information is present. Both must answer `yes` when
enabled; neither can override a non-current/uncertain main answer. Every required
confidence must meet the floor. Correlated answers are never averaged or
multiplied into a supposed correctness probability.

Presets were chosen as policy controls before their diagnostic run:
conservative is 0.9 with checks, balanced 0.7 with checks, permissive 0 with
the currency question alone. Explicit overrides are supported. The maintainer
selected balanced as the default on 2026-11-08; this is a policy choice, and its
0.7 floor does not mean 70% correct. Automation still requires explicit opt-in.
The dry-run report exposes
every judgment and threshold sensitivity; it can help an owner choose how much
automation to allow while keeping all structural/context checks mandatory.

The [product-path diagnostic](../../evals/3452-propagation-policy/run.ts) made
93 actual JEV requests, asking all three questions against the same supplied
state per request. It ran three repetitions through real Git reference/diff
acquisition and the actual product dry-run path on the unchanged reviewed cases.
Fifteen of 108 case/repetition outcomes were unavailable before a model call:
three missing-history and two unknown-scope cases, repeated three times.
There were no provider failures. The complete [results](../../evals/3452-propagation-policy/results-2026-11-03.json)
retain requests/responses, product outcomes and policies. The conservative
input-byte guard debit was $0.016298 against a $1 cap, not an invoice.

| Policy | Tuning safe acceptances / 12 positive outcomes | Held-out safe acceptances / 24 positive outcomes | False acknowledgements |
| --- | --- | --- | --- |
| Conservative, floor 0.9 with checks | 0/12 | 3/24 | 0 |
| Balanced, floor 0.7 with checks | 5/12 | 16/24 | 0 |
| Permissive, floor 0, currency only | 12/12 | 21/24 | 0 |

One held-out still-current case lacks a historical source; its three repetitions
cannot be accepted by the product's reference requirement even though the
earlier supplied-context classifier could judge it from current evidence.
At the same floor of 0.7, currency alone accepted 18 held-out outcomes versus
16 with checks; at 0.9 the counts were 17 versus 3. At floor 0 both accepted
21. Thus this small diagnostic shows a coverage cost, not a demonstrated
reduction in false clearances from extra questions. No preset was selected
from held-out results, no floor is advertised as calibrated safety, and no new
blind corpus or production rate follows from reusing these authored cases.
All policy counts replay the same three-question responses. The currency-only
counts discard the additional answers; they do not measure a separate live
one-question arm. Asking only the currency question in permissive mode could
change that answer as well as remove the extra vetoes.

Shipped-path tests cover the complete reviewed corpus with scripted provider
responses and actual history/receipt/audit behavior, plus fresh CLI processes,
cache reuse, day/policy/context invalidation, privacy and path bounds, refusal
of concurrent edits, malformed/failed responses and the hosted scheduled-job
boundary. Two restored guard mutations failed on their intended runtime
assertions: ignoring fresh-context revalidation acknowledged a concurrently
changed source (expected zero, got one), and allowing extra questions to
override currency acknowledged a changed commander (expected zero, got one).
