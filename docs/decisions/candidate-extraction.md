# Candidate extraction: keep the agent

**2026-10-11 — No-go for replacing research extraction with this candidate.**
The shipped agent extracted every held-out positive correctly. Code plus Jev
invented ten event-end field values by assigning submission cutoffs to an
unannounced event end, and the confidence floor dropped fifteen real contacts.
Copying a source span prevents new digits but does not establish its role.
No production integration follows from this experiment.

This answers [#849](https://github.com/schlessera/brain-kit/issues/849) under
[#838's lean protocol](https://github.com/schlessera/brain-kit/issues/838).
The [harness](../../evals/849-candidate-extraction/run.ts),
[compact results](../../evals/849-candidate-extraction/results-2026-10-11.json)
and [running instructions](../../evals/849-candidate-extraction/README.md)
retain the inputs, per-run outcomes, calibration and label verdicts needed to
check the comparison. Raw verbose Claude stdout and disposable brains remain
in external scratch, outside the repository.

## What was compared

The 24 preserved natural workloads in
`evals/cases/849-candidate-extraction.json` and eight added positive workloads
in `evals/cases/849-extra-positives.json` were label-checked. One ambiguous
case was dropped: **31 cases, 12 tuning and 19 held-out**, three repetitions
each. The reference date is `2026-07-12`; future calendar values are explicitly
hypothetical. The separate 24 preserved parser controls are not the semantic
evaluation set: date/timezone arithmetic and parser breadth are outside this
investigation's question.

| Arm | Execution |
| --- | --- |
| Current | Real `claude-sonnet-5-5` through the subscription-authenticated Claude Code CLI; reads the copied, unmodified `conference-research` or `research-opportunity` skill in a fresh disposable brain, uses real core/module CLI code, and reports extracted source spans. |
| Candidate | Regexes over-find typed source occurrences; the shipped core Jev client asks `jev-1.13.0` Choice questions for each role, including `none` and `unclear`; code copies and normalizes the selected occurrence. |
| Floor | Always `unclear`, including fields with announced values. |

The semantic source and context are identical across arms. The current arm
also has the preserved brain's criteria, identity and other local files needed
by the shipped skills. Only extraction is scored: company research, fit prose,
submission generation and complete workflow adherence are not equivalent
classifier tasks and are not claimed as measured outcomes.

Explicit absence, not disclosed and no stated contact mean `none`.
Unmentioned or ambiguous fields mean `unclear`. A stated semantic span remains
extractable when its timezone, currency or units require clarification.
Exact correctness also requires the right repeated occurrence. Wrong spans
count as both FP and FN. Structurally valid JSON inside a prose report is
scoreable; a prose preface alone is not an invalid extraction.

## Held-out results

Nineteen cases × three repetitions: **303 field decisions, 159 positives**.
There is no majority vote hiding a bad repetition.

| Arm | Extraction precision | Extraction recall | Exact role/occurrence | Invented field values | Literal inventions |
| --- | --- | --- | --- | --- | --- |
| Current | 159/159 (100%) | 159/159 (100%) | 297/303 (98.0%) | 0 | 0 |
| Code + Jev, floor 0.8 | 144/154 (93.5%) | 144/159 (90.6%) | 267/303 (88.1%) | **10: veto** | 0 |
| Always unclear | undefined: no predictions | 0/159 (0%) | 138/303 (45.5%) | 0 | 0 |

An invented **field value** includes asserting a value for a field with no
announced value, even if the literal was copied from elsewhere in the notice.
`inventedLiteral` separately detects text/occurrences absent from the source.
The candidate's ten inventions are unsupported event-end claims, not newly
generated date strings. The current arm's six exact errors classify
unannounced event dates as `none` rather than `unclear`; neither asserts a date.

| Field | Distinct held-out positives | Current P/R | Candidate precision | Candidate recall |
| --- | --- | --- | --- | --- |
| CFP deadline | 11 | 100% / 100% | 100% | 100% |
| Event start | 5 | 100% / 100% | 100% | 100% |
| Event end | 5 | 100% / 100% | **15/25 (60%)** | 100% |
| Bio limit | 5 | 100% / 100% | 100% | 100% |
| Talk duration | 5 | 100% / 100% | 100% | 100% |
| CFP URL | 5 | 100% / 100% | 100% | 100% |
| Contact email | 7 | 100% / 100% | 100% | **6/21 (28.6%)** |
| Salary | 7 | 100% / 100% | 100% | 100% |
| Application URL | 3 | 100% / 100% | 100% | 100% |

The unfloored candidate finds all 159 positives but adds 22 unsupported
values: 159/181 precision (87.8%), 100% recall, 187/303 exact decisions
(61.7%). Confidence filtering improves precision but does not eliminate the
event-end confusion; it removes correct contacts along with weaker guesses.

Both extractors feed the same small deterministic normalizer. These are
pipeline scores, not independently generated agent arithmetic: current
153/153 normalized precision and recall; candidate 138/145 precision (95.2%)
and 138/153 recall (90.2%). Unsupported timezone/currency/unit formats return
null; monthly and hourly pay retain their source period. No annual-hours or
timezone assumption is invented to make a parser succeed.

## Calibration and reliability

The predeclared floors were 0, 0.2, 0.4, 0.6 and 0.8. Exact candidate tuning
accuracy was respectively **127, 143, 164, 175 and 178 of 204**. The highest
accuracy wins, ties taking the smaller floor. **0.8 was selected before
held-out dispatch** and retained through final scoring. This global objective
weights uncertain fields alongside positives; the contact recall loss shows
why aggregate tuning accuracy does not establish extraction quality.

| Arm | Three-way field agreement | Invalid reports | Unclear decisions | Fallback calls | Owner/source edits |
| --- | --- | --- | --- | --- | --- |
| Current | 101/101 (100%) | 0 | 132/303 | 0 | 0 |
| Candidate, floor 0.8 | 99/101 (98.0%) | 0 | 132/303 | 0 | 0 |
| Always unclear | 101/101 (100%) | 0 | 303/303 | 0 | 0 |

Unfloored candidate agreement is 94/101 (93.1%). Explicit `none` decisions
are distinct from the `unclear` abstention count. No fallback model was called;
coverage requiring one is not secretly credited as a successful extraction.

## Labels, execution and isolation

Claude checked every original natural-workload golden and every added case
once: **24 ok, seven ambiguous, one wrong**. Full verdicts and resolutions are
in the results. Clear corrections change `held-no-event` event-start/end to
`unclear` and remove the unsupported 2,080-hour annualization in `held-hourly`.
`held-relative` is dropped: “next Saturday” is ambiguous as an acceptance day
versus a cutoff and conflicts with its intended edition. The remaining flags
are resolved by the explicit none/unclear policy and by separating semantic
selection from unsupported normalization. An “address” remains a speaking slot.
The preserved original data is unchanged; corrections are an explicit overlay.

There were **93 measured Claude CLI runs and 93 Jev client calls**, plus one
Claude label check and 43 discarded Claude dispatches (41 completed, two
interrupted). Discarded pilots exposed insufficient Bash restriction, warning
events mistaken for rate-limit failures, invalid absolute module keys, a
supplied year on an edition-unknown tuning case, and one run that had not read
the skill. Those outputs are excluded. Corrected current runs read the shipped
skill; real CLI config validation passes with local module keys. Two additional
CLI startup failures occurred before model dispatch. Two additional native
containment attempts produced one completed control and one interrupted attempt
without output. PR review is additional and recorded with the PR.

Every measured brain is outside the checkout, contains no symlink back to it
and reaches an independent runtime through a PATH shim. Native restricted file
tools confine reads/writes to that brain. A short tool hook enforces exact
product Bash commands and protects configuration/executable files, preventing
allowed CLI calls from loading agent-written code. API key variables are
removed for every Claude call; at most two Claude processes run concurrently.
All **93 retained measured stdout transcripts** were scanned: **zero accesses
to evaluation, golden, label-review or results paths**. This backs the current
arm's perfect positive extraction score. No owner prose, binary file or source
notice changed. The completed native control denied an outside Read, arbitrary
Bash and module-code Write while allowing an ordinary inside-brain Write.
The observed default-directory research writes are tracked
separately in [#1570](https://github.com/schlessera/brain-kit/issues/1570).

## Limits and what would justify another attempt

- Small authored sources, with eight deliberately straightforward added
  positives. Application URLs still have only three distinct held-out positives.
  Repetitions measure reliability, not additional independent examples.
- Pasted local notices stand in for fetched pages. Live retrieval, broad HTML
  parsing, relative dates, natural-language arithmetic and generated research
  quality are not measured. The agent's read of the installed skill is verified;
  native skill catalog routing is not a separate evaluated outcome.
- Normalization is a shared prototype after selection. Perfect numbers for a
  field do not establish a reusable production parser or justify a new seam.
- One label reviewer and one model version per arm; no human label adjudication
  or statistical equivalence claim. Cost is not an evaluation metric.

Keep the existing agent extraction path. Another attempt should distinguish
submission cutoff from event end and calibrate contact selection without
discarding announced programme/recruitment addresses. Any revised prompt or
field-specific floor must tune on tuning data and use fresh held-out cases.
Only a comparison without invented field values and without precision/recall
loss would justify a narrowly scoped integration; it would still require its
own issue and both concrete consumers before introducing a shared helper.
