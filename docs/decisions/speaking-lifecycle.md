# Decision — keep speaking updates explicit; do not adopt this Jev classifier

**No-go for unattended Jev speaking lifecycle updates.** The fresh
[#846](https://github.com/schlessera/brain-kit/issues/846) comparison under
[#838](https://github.com/schlessera/brain-kit/issues/838) found correct
held-out field effects in 45 of 69 Jev runs, against 65 for the shipped skills
and 69 for explicit-owner deterministic updates. Zero vetoed Jev writes
does not compensate for missed decisions and incorrect acceptance labels.
No production integration or contract change is selected by this experiment.

Measured on 2026-10-11, from main
`9f0df4959887b2b549d628010a8e2af1e5c1bfff`, using the
[lean harness](../../evals/846-speaking-lifecycle/run.ts) and
[results JSON](../../evals/846-speaking-lifecycle/results-2026-10-11.json).
The [cases](../../evals/846-speaking-lifecycle/cases.json) extract the 19
natural-message corpus entries preserved in
`evals/cases/846-speaking-lifecycle.json` and add 11 cases. Seven are tuning;
23 are held-out. Each arm runs three times on each case, with fresh disposable
brains. The fixture day is 2026-07-12. There are three held-out waitlist and
three backup cases, plus negation, quotation, unknown targets, conditional
acceptance, a secondary assembly, withdrawal, delivery and closure.

## Arms

| Arm | What ran |
| --- | --- |
| Current | Unchanged `submission-outcome` and `conference-aftermath` skills installed under each brain's `.claude/skills/`, through Claude Code CLI with `claude-sonnet-5-5`. File tools and the actual `brain archive` command can act inside the disposable brain. |
| Candidate | Core's Jev client with `jev-1.13.0`: one outcome Choice and one joint submission/assembly shortlist Choice with `none`, followed by deterministic writes. Explicit owner operations remain distinct from outcome classification. |
| Explicit owner | The same deterministic writer, given the reviewed structured outcome and target by the owner. This is a mechanical baseline with correct semantic inputs, not automatic message interpretation. |

The candidate copies labelled dates and conditions in code, regenerates the
tracking projections and uses core's archiver. There is no confidence gate,
calibration or fallback; `threshold` is null. The prompts were not retuned
after seeing tuning or held-out answers. Claude used the logged-in
subscription, with both Anthropic key variables removed. The CLI also
reports auxiliary Haiku 5.5 use. There were 90 Jev client calls and 183 Claude
CLI invocations: 180 current-arm runs, one label check and two PR reviews.
Cost was not measured. PR reviews and their reviewed snapshots are retained
in the results. Sonnet's corrected-snapshot review approved the no-go;
its minor disclosure findings and resolutions are recorded there.

The first current-arm matrix was discarded: its semantic case IDs appeared
in Claude's working directory, potentially hinting at goldens. All 90 runs
were replaced with fresh neutral numbered directories, without changing
prompts, goldens or candidate answers. Only the replacement matrix appears
below; `discardedCurrent` retains the original summary and review, and its
90 invocations remain in the call count. Fresh harness invocations now also
use unique suffixes to avoid reusing prior transcripts or modified trees.

## Held-out quality and vetoes

| Arm | Outcome correct / 69 | Submission target correct / 60 | Field effects correct / 69 | Vetoed runs |
| --- | --- | --- | --- | --- |
| Current skills | 69 (100%) | 58 (96.7%) | 65 (94.2%) | 1 |
| Jev + code | 61 (88.4%) | 42 (70%) | 45 (65.2%) | 0 |
| Explicit owner | 69 (100%) | 60 (100%) | 69 (100%) | 0 |

Submission-target accuracy covers the 20 held-out outcome-message cases.
The nine withdrawal/delivery/closure runs have explicit operations. The
current prompt's final-report instruction can be read as asking for target
`none` on a non-outcome action, even when files record the correct target.
Those report targets are not proof of wrong-target writes. The results keep
the broader reported-target counts (current 58/69, Jev 48/69, owner 69/69)
and every per-run classification and field verdict.

Jev repeatedly selected `none` for clear waitlist, backup and rejection
messages. It also abstained on all three accepted messages containing a
distracting “return on 14 July” request. On the explicit stand-in case it
returned unclear once and accepted twice: the latter runs wrote a false
acceptance and added it to focus. These are field-quality failures, preserved
in the results, even though they do not meet the specified destructive veto.

The current path's held-out veto was a write to the protected canonical
`talks/memory.md` during delivery, while replacing the accepted outcome and
prior date with a delivered label. The other two delivery repetitions met
the preservation rubric. Two closure repetitions left both tracked
submissions active. One accepted message with a distracting return date
invented a submission deadline from that travel request.
Incomplete closure counts as a quality failure, not a destructive write.
No held-out arm conflated a rejection with document archiving or lost an
abstract. All three current-path tuning runs of `tune-accept` changed the
other submission without an unambiguous outcome for it; these vetoes are
outside the held-out table and remain in the results.

## Reliability and label check

| Arm | Same classification pair in all three runs / 23 | Same scored effects / 23 | Invalid answers | Outcome `unclear` / 69 | No-write runs / 69 |
| --- | --- | --- | --- | --- | --- |
| Current skills | 22 | 20 | 0 | 27 | 18 |
| Jev + code | 21 | 22 | 0 | 33 | 40 |
| Explicit owner | 23 | 23 | 0 | 27 | 18 |

Nine cases deliberately report outcome unclear, including the three explicit
non-outcome operations. An unclear classification is not synonymous with
doing no work. Jev's `none` target supplies many additional no-write runs
that lose useful coverage. No fallback, failed client result, CLI rate-limit
backoff or subscription-limit interruption occurred. Agreement describes consistency,
including consistently wrong answers, and never suppresses a minority veto.

Sonnet 5.5 reviewed all 30 source/golden labels once, from a different family
than the OpenAI author. It approved every label, including conditions,
deadlines and explicit operations. No label was fixed or case dropped; its
individual reasons are retained in `labelCheck.verdicts` in the results.
That reviewer is also the model used by the incumbent arm, so independence
from the author does not imply independence from the incumbent. The 11 new
cases were authored before label review and before any Jev comparison call;
the distracting date case already existed in the preserved corpus. Cases
deliberately stress the classifiers and do not model real-user prevalence.

The scorer was corrected after inspecting saved files: it now reads the
Status column, respects latest transitions, ignores negated and historical
annotations, tolerates punctuation/case and accepts a submission title in
focus. Mixed-index, focus-date and closure checks were also completed. The
neutral rerun exposed a false failure on an index labelled “closed”; that
alias was accepted after a named regression test failed on `archive-index`.
Every arm was rescored from its saved files. The 180 deterministic runs were also
replayed from their initial brains, with identical recorded model answers,
after fixing the writer to append summary history and preserve the prior
acceptance date during delivery. These scoring/writer corrections used saved
answers, without candidate reruns or golden changes. The separate current-arm
rerun corrected directory cues. The offline scoring tests cover these
corrections. Removing the unclear-write veto made its named assertion fail;
restoring it returned the tests to green.

## Limits and integration

This is one small authored corpus and one fixed Choice formulation, not a
claim that every Jev prompt must fail. There are no confidence intervals or
real-user prevalence estimates. Repetitions are correlated observations.
The current CLI permitted Read/Write/Edit and individual `brain` commands;
72 of 90 retained sessions also tried Bash commands outside that allowlist and were
denied. The model could use the approved file tools instead, but this is a
bounded permission configuration, not a measurement of every product mode.

Field scoring is mechanical and formatting-tolerant, not byte equality of
generated prose. Retrospectives, travel and publishing are excluded. The
lexical checks cover specified aliases rather than every equivalent phrasing.
The delivery rubric requires retaining the prior acceptance and date, which
the shipped aftermath skill does not explicitly require. Treat those misses
as failures against this authored preservation rule, not a newly adopted
product contract. Even crediting the remaining delivery miss would give the
current arm at most 66/69 field effects. The closure rubric also requires
archiving submission files, whereas the shipped aftermath skill says to
archive the conference files “at minimum status.md”. Crediting both partial
closures as well would give at most 68/69, against Jev's 45/69. These are
authored preservation/closure requirements, not a new product contract.
No calibrated confidence gate was evaluated; the no-go applies to this
ungated direct-Choice candidate, not every gated variant. The cleaner outcome and
submission-target gaps also support the no-go independently of that rubric.
The writer, initial trees and scorer were developed together, so the owner
baseline establishes feasibility rather than independent production proof.
The scorer protects existing abstracts, canonical talk notes and unrelated files;
it does not prove arbitrary filesystem containment, concurrency or recovery.
Archive `updated` uses the actual runtime date and is not scored against the
fictional fixture day. Only primary messages are exercised, not the preserved
secondary messages, repeated workflow checkpoints or arbitrary prose dates.
Raw reports and changed Markdown remain outside the repository; the compact
results retain the scoreable answers, provider responses and failure details.
Call counts mean Claude CLI invocations and Jev `ask` invocations. They do
not count Claude's individual turns or observe core's possible internal HTTP
retry; exact transport-attempt totals are not available from this run.

The explicit-owner result supports the feasibility of deterministic field
and projection updates. It does not justify accepting a classifier's target
or granting permission from its answer. Keep the current production path;
do not integrate this Jev candidate. A future re-evaluation would need a
clearer target judgment and held-out evidence that closes this quality gap
without destructive errors. No production rollout follows from this spike.
