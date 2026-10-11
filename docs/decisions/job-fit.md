# Decision — retain agent job-fit assessment; do not adopt this Jev candidate

The lean [#847](https://github.com/schlessera/brain-kit/issues/847) evaluation
does not support replacing the research skill's fit judgment with this
candidate. Jev plus code improves substantially on keyword scoring, but its
held-out decisions include unsupported acceptance of missing residence terms
and false exclusion of a withdrawn, quoted location restriction. The research
skill was correct in all 54 held-out observations; the candidate in 48.

This is a **no-go for this candidate**, with no production changes. The
question is quality and reliability under [#838's lean protocol](https://github.com/schlessera/brain-kit/issues/838),
not cost. No savings or ranking-quality claim is made.

## What was compared

Measured on 2026-10-11 from main `9f0df4959887b2b549d628010a8e2af1e5c1bfff`.
The [harness](../../evals/847-job-fit/run.ts) and
[compact results](../../evals/847-job-fit/results-2026-10-11.json) contain
the requests, scoring rules, individual outcomes and tuning comparison.

| Arm | What runs |
| --- | --- |
| Research skill | Unchanged shipped `research-opportunity`, installed in `.claude/skills/` in a fresh disposable brain per case and repetition; subscription-backed Claude Code with `claude-sonnet-5-5`. It reads criteria and identity, writes opportunity notes and runs the real pipeline CLI. |
| Jev plus code | Core's shipped Jev transport with model pinned to `jev-1.13.0` and a 60 s request budget (rather than shipped alias/latest and 10 s defaults), two Choice questions: passage must-have and relocation dealbreaker. Harness code hard-excludes literal title/location markers, checks guaranteed salary minimum and combines configured keyword weights. No generation fallback. |
| Keyword scoring | Shipped `scoreJob` and its queue/dismiss thresholds. A queued posting maps to candidate, dismissed to excluded, pending to review. |
| Review everything | Every posting goes to human review. |

The keyword baseline uses the shipped scorer
(`scoreJob`, `packages/module-jobs/src/score.ts:277-320`), including its
literal group matching (`groupScore`, `packages/module-jobs/src/score.ts:230-243`).
No scorer, skill, transport or public contract changes in this spike.

Both semantic arms receive the same criteria text (including its evidence precedence and current-exclusions clarification), posting, structured job metadata,
criteria, identity and fictional company packet. Keyword scoring receives its
existing `ScoreJobInput`, so it cannot use posting text omitted from that
field. The skill gets local file and CLI permissions, an explicit queue-report
format and the dealbreaker label polarity. External research and the closing
conversation are outside this fit-only measurement. It uses the supplied
fictional packet; no real companies are researched.

The candidate location guard is harness-defined: it hard-excludes on the full
posting. Shipped location scoring only removes location points and reads title,
description, tags and location. They are not equivalent implementations.
Successful hard gates guarantee at least 70 points against a threshold of 60
in this configuration, so candidate eligibility is effectively determined by
its gates; autonomy remains keyword-based and is not a measured preference.
The Jev question wording was written once before measurement and not tuned.

## Cases and label check

The preserved [inputs](../../evals/cases/847-job-fit.json) contain 29 semantic
cases and 18 historical extraction controls. The controls' parser-specific
outcomes are outside this comparison. Sonnet 5.5 checked every semantic golden
once through the subscription CLI. Twenty-eight agreed, none clearly wrong, and one
ambiguous. `held-future-duty` could reasonably mean either current duties fail
or future duties remain unknown; it was dropped before scoring. All verdicts
and reasons remain in the results. No golden was changed.

The remaining 28 cases have ten tuning and eighteen held-out sources, all
Odysseus data at `2026-07-12`. Held-out queue goldens comprise five candidates,
nine exclusions and four reviews. They include four definite relocation
dealbreakers and four failed passage must-haves. Negation, indirect relocation,
remote advertisements versus binding terms, contradictory clauses, quoted
restrictions, missing pay, missing residence terms and injection are covered.
Descriptive autonomy labels are not scored: neither ordinal preference quality
nor a Score transport was evaluated.

## Held-out quality and reliability

| Arm | Exact decisions | Eligible precision / recall | Dealbreaker / must-have unsafe passes | Unanimous decisions | Invalid / review routes |
| --- | --- | --- | --- | --- | --- |
| Research skill | 54/54 (100%) | 100% / 100% | 0 / 0 | 18/18 | 0 / 12 |
| Jev plus code | 48/54 (88.9%) | 80% / 80% | 0 / 0 | 18/18 | 0 / 9 |
| Keyword scoring | 24/54 (44.4%) | 42.9% / 60% | 6 / 6 | 18/18 | 0 / 9 |
| Review everything | 12/54 (22.2%) | Undefined / 0% | 0 / 0 | 18/18 | 0 / 54 |

Per repetition, exact decisions are 18/18, 18/18 and 18/18 for the skill;
16/18, 16/18 and 16/18 for the candidate; 8/18 each for keyword scoring;
and 4/18 each for review everything. The candidate improves on keywords but
does not match the current agent. Keyword scoring triggers the dealbreaker
veto on two distinct postings in all three repetitions. Neither semantic arm
has a dealbreaker or failed-must-have unsafe pass.

There are three repetitions per arm. Counts above are case-repetition
observations over eighteen cases, not 54 independent postings. Every unsafe
pass counts; majority voting never erases a veto. A dealbreaker miss means a
golden relocation dealbreaker was queued as eligible. Criterion-label errors
are reported separately in JSON, including cases where another failure still
keeps the posting excluded. Review routes count as abstentions, including
missing salary and unclear evidence; they are not automatically correct.

Jev's six held-out decision errors are three exclusions of `held-quoted-marker`
and three candidate decisions for `held-no-residence`. The literal guard causes
the former even though Jev correctly reads the current residence terms.
The latter reflects Jev accepting remote work as sufficient residence evidence
despite the explicit precedence rule. It makes the same wrong decision in all three repetitions; unanimous answers
are not evidence of correctness.

The confidence grid was 0, 0.4, 0.6, 0.8, 0.9 and 0.95. The fixed selection
rule uses tuning only: fewer dealbreaker passes, then more exact decisions,
then the lower floor. Floors 0, 0.4 and 0.6 tie at 27/30; higher floors reduce
agreement. The selected floor is **0**, applied unchanged to held-out. This
disables confidence abstention; it is not evidence that confident answers are
correct. Both selected probability and confidence are checked at every floor.

The scored measurement made 84 Claude CLI workflow invocations and 84 Jev
HTTP requests (168 atomic judgments), with no retries, invalid responses,
generation fallbacks or subscription-limit stop. Label checking used one
additional Claude invocation. All 84 scored current runs used Sonnet 5.5,
created one status file and had a pipeline index present afterward. The corrected runs had
no permission denials; these artifact counts, served models and agent-turn counts are recorded per row. Cross-family review and the discarded pilot are also
included in the results' overall call count. Overall totals are 95 Claude CLI
invocations (84 scored workflows, one label check, eight pilot calls and two
reviews) and 168 Jev HTTP attempts (84 scored and 84 discarded). Individual
Claude agent turns are recorded separately and are not called CLI invocations.

An initial 84-request Jev run omitted the clarification appended to the
skill criteria. It was discarded and repeated using the exact same criteria
text. Its summary and physical calls are disclosed separately, and raw outcomes
remain in scratch. Claude-family PR review, complementing the Codex-family author, identified
this asymmetry and the need
to distinguish shipped scoring from the candidate hard guard. Its second
review approved the corrected proposed PR with no unresolved blocking findings;
it reviewed artifacts rather than independently re-running providers.

An earlier tuning-only current-arm pilot used eight CLI invocations, six
completed and two interrupted. Its report adapter left relocation polarity
implicit, and its Bash patterns denied inherited command wrappers. Those
observations were discarded before any current-arm held-out run. The corrected
adapter explicitly defines a triggered dealbreaker and permits local CLI
operations. Pilot outcomes and calls are retained separately in the results.

## Limits and what would justify another evaluation

The no-go is sensitive to two cases out of eighteen, rather than a broad
population estimate. The separate post-hoc floor-0.4 line in the results is
non-selected; it must not replace the tuning-selected floor-0 headline. It also
scores 48/54, so the initially reviewed tie-break sensitivity does not rescue
the aligned candidate. The raw initial unaligned run scored 49/54; it is
discarded preparation evidence, not the headline.

This is one small authored set, one model version per provider and one label
checker. That checker is also the current-arm model, so its perfect score is
partly agreement with labels that the same model endorsed. Entity/source differences between splits do not establish population
independence. There are only five held-out eligible postings. The label checker
is Claude-family, complementing this Codex-family evaluation; historical golden
authorship is not established. Its autonomy-only reservations do not establish
ordinal correctness.

The skill's output adapter supplies queue semantics that the conversational
product normally expresses as pursue/skip/needs information. This assesses its
fit judgment, not external research quality, interview usefulness or a completed
user conversation. Generated pipeline dates follow the real CLI clock rather
than the fictional reference date; dates and exact file formatting are not
scored. Raw CLI reports and generated brains remain outside the repository. Bash
permissions and the workspace package symlink are not an isolation proof.
The prompt prohibited reading goldens, but tool invocation transcripts were
not retained, so label non-access is unverified.

No integration follows this no-go. Re-evaluation would need a candidate that
handles current versus negated/quoted restrictions and reliably abstains on
missing residence terms, with discriminating tuning cases and a new held-out
comparison against the research skill. Removing guards or selecting a better
held-out floor now would be a different candidate, not a repair to these figures.
