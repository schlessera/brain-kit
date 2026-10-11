# Candidate extraction: keep the agent

**2026-10-11 — No-go for replacing research extraction with this candidate.**
The shipped agent extracted every held-out positive correctly. Code plus Jev
invented ten event-end field values by assigning submission cutoffs to an
unannounced event end. That confusion alone vetoes replacement. The selected
confidence floor also dropped fifteen real contacts; that loss is an artifact
of floor selection, not an inherent inability to identify contacts.
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

Explicit absence, not disclosed, no announced dates, no decided deadline and
no stated contact mean `none`.
Unmentioned or ambiguous fields mean `unclear`. Dates pending agreement or
under discussion mean `unclear`; only explicit “no announced” or “no decided”
wording maps to `none`. A stated semantic span remains
extractable when its timezone, currency or units require clarification.
Exact correctness also requires the right repeated occurrence. Wrong spans
count as both FP and FN. Structurally valid JSON inside a prose report is
scoreable; a prose preface alone is not an invalid extraction.

## Held-out results

Nineteen cases × three repetitions: **303 field decisions, 159 positives**.
There is no majority vote hiding a bad repetition.

| Arm | Extraction precision | Extraction recall | Exact role/occurrence | Invented field values | Literal inventions |
| --- | --- | --- | --- | --- | --- |
| Current | 159/159 (100%) | 159/159 (100%) | 301/303 (99.3%) | 0 | 0 |
| Code + Jev, floor 0.8 | 144/154 (93.5%) | 144/159 (90.6%) | 267/303 (88.1%) | **10: veto** | 0 |
| Always unclear | undefined: no predictions | 0/159 (0%) | 132/303 (43.6%) | 0 | 0 |

An invented **field value** includes asserting a value for a field with no
announced value, even if the literal was copied from elsewhere in the notice.
`inventedLiteral` separately detects text/occurrences absent from the source.
The candidate's ten inventions are unsupported event-end claims, not newly
generated date strings. The current arm correctly uses `none` for explicitly
unannounced event dates; these were initially scored against inconsistent labels.
Its two exact errors are one `held-hourly` repetition marking unmentioned
application URL and recruitment contact as `none` instead of `unclear`.
Neither asserts a value or loses a positive.

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
values: 159/181 precision (87.8%), 100% recall, 193/303 exact decisions
(63.7%). Confidence filtering improves precision but does not eliminate the
event-end confusion; it removes correct contacts along with weaker guesses.

Both extractors feed the same small deterministic normalizer. These are
pipeline scores, not independently generated agent arithmetic: current
153/153 normalized precision and recall; candidate 138/145 precision (95.2%)
and 138/153 recall (90.2%). Unsupported timezone/currency/unit formats return
null; monthly and hourly pay retain their source period. No annual-hours or
timezone assumption is invented to make a parser succeed.

## Calibration and reliability

The predeclared floors were 0, 0.2, 0.4, 0.6 and 0.8. Exact candidate tuning
accuracy before label adjudication was **127, 143, 164, 175 and 178 of 204**.
The highest accuracy wins, ties taking the smaller floor. **0.8 was selected before
held-out dispatch** and retained through final scoring. After PR review corrected
the explicit-no-deadline tuning label, offline counts are **130, 146, 167, 178
and 175 of 204**; 0.6 would now win. We do not retrospectively change the frozen
floor after observing held-out results. The grid ends at its original winner,
so no continuous optimum is established. This global accuracy objective weights
uncertain fields alongside positives. Unfloored contact selection is perfect;
correct contact confidence overlaps incorrect absence confidence, so a single
global floor does not separate them cleanly. The contact recall loss reflects
calibration, while high-confidence event-end
inventions independently establish the no-go.

| Arm | Three-way field agreement | Invalid reports | Unclear decisions | Fallback calls | Owner/source edits |
| --- | --- | --- | --- | --- | --- |
| Current | 99/101 (98.0%) | 0 | 130/303 | 0 | 0 |
| Candidate, floor 0.8 | 99/101 (98.0%) | 0 | 132/303 | 0 | 0 |
| Always unclear | 101/101 (100%) | 0 | 303/303 | 0 | 0 |

Unfloored candidate agreement is 94/101 (93.1%). Explicit `none` decisions
are distinct from the `unclear` abstention count. No fallback model was called;
coverage requiring one is not secretly credited as a successful extraction.

## Labels, execution and isolation

Claude checked every original natural-workload golden and every added case
once: **24 ok, seven ambiguous, one wrong**. Full verdicts and resolutions are
in the results. The unsupported 2,080-hour annualization in `held-hourly` was
removed. The initial review recommended `unclear` for `held-no-event`; cross-family
PR review caught that this contradicted the explicit-nondisclosure policy.
Final adjudication restores `none` for its event-start/end and applies the same
policy to `tune-instruction`'s explicitly undecided deadline. Captured outputs
were rescored offline without new extraction calls.
`held-relative` is dropped: “next Saturday” is ambiguous as an acceptance day
versus a cutoff and conflicts with its intended edition. The remaining flags
are resolved by the explicit none/unclear policy and by separating semantic
selection from unsupported normalization. An “address” remains a speaking slot.
The preserved original data is unchanged; corrections are an explicit overlay.

There were **93 measured Claude CLI runs and 93 Jev client calls**, plus one
Claude label check and 136 discarded Claude dispatches (134 completed, two
interrupted). Discarded pilots exposed insufficient Bash restriction, warning
events mistaken for rate-limit failures, invalid absolute module keys, a
supplied year on an edition-unknown tuning case, and one run that had not read
the skill. PR review additionally exposed unprotected root Bun configuration
writes; all 93 earlier current-arm outputs were discarded and rerun with the
stronger guard. Those outputs are excluded. Corrected current runs read the shipped
skill; real CLI config validation passes with local module keys. Two additional
CLI startup failures occurred before model dispatch. Three additional native
containment attempts produced two completed controls and one interrupted attempt
without output. PR review is additional and recorded with the PR; one follow-up
review attempt was interrupted after a brief overlap with two extraction workers.
It was stopped to restore the two-process limit. Final review runs after extraction.

Every measured brain is outside the checkout, contains no symlink back to it
and reaches an independent runtime through a PATH shim. Native restricted file
tools confine reads/writes to that brain. A short tool hook enforces exact
product Bash commands and protects module code, skill files, brain config,
root dotfiles, `bunfig.toml`, `package.json`, `tsconfig*.json` and `node_modules`.
The earlier guard omitted root Bun configuration/dependency files. Although no
earlier transcript attempted those writes, all current cases were rerun after
closing that gap. API key variables are
removed for every Claude call; extraction uses at most two workers.
All **93 retained measured stdout transcripts** were scanned: **zero accesses
to evaluation, golden, label-review or results paths**. This backs the current
arm's perfect positive extraction score. No owner prose, binary file or source
notice changed. Native controls denied an outside Read, arbitrary Bash, module-code
Write and root Bun/package/TypeScript/dotfile/dependency Writes while allowing an
ordinary inside-brain Write. Denied files were absent and module contents unchanged.
The observed default-directory research writes are tracked
separately in [#1570](https://github.com/schlessera/brain-kit/issues/1570).

## Limits and what would justify another attempt

- Small authored sources, with eight deliberately straightforward added
  positives. The added cases are near-identical templates with names/numbers
  changed and add little linguistic diversity. Application URLs still have
  only three distinct held-out positives.
  Repetitions measure reliability, not additional independent examples.
- Pasted local notices stand in for fetched pages. Live retrieval, broad HTML
  parsing, relative dates, natural-language arithmetic and generated research
  quality are not measured. The agent's read of the installed skill is verified;
  native skill catalog routing is not a separate evaluated outcome.
- The report prompt supplies exact-substring/occurrence selection, injection
  handling and HTML-attribute preference beyond the shipped skill text.
  Current-arm accuracy therefore measures the skill with this evaluation
  scaffolding, not an unassisted skill invocation.
- Candidate literal invention is structurally prevented by copying regex spans;
  its zero count is not independent evidence of semantic accuracy. Unsupported
  field-value vetoes remain necessary.
- Committed rows contain selections gated at 0.8. Ungated candidate answers
  remain in scratch; the original and rescored calibration aggregates are
  committed, but alternate floors cannot be reproduced from these gated rows alone.
- Normalization is a shared prototype after selection. Perfect numbers for a
  field do not establish a reusable production parser or justify a new seam.
- Initial labels were not rerun through the original label-check prompt after
  correction. Cached review findings now require explicit per-case resolutions
  before a rerun proceeds. Cross-family PR review checks the final artifacts.
- One label reviewer from the current arm's model family and one model version
  per arm; no human label adjudication
  or statistical equivalence claim. Cost is not an evaluation metric.

Keep the existing agent extraction path. Another attempt should distinguish
submission cutoff from event end and calibrate contact selection without
discarding announced programme/recruitment addresses. Any revised prompt or
field-specific floor must tune on tuning data and use fresh held-out cases.
Only a comparison without invented field values and without precision/recall
loss would justify a narrowly scoped integration; it would still require its
own issue and both concrete consumers before introducing a shared helper.

Final Claude cross-family PR review approved the revised artifacts, rechecking
all 31 retained goldens: 30 ok, one tuning-only pending-date ambiguity resolved
by the policy above. This is model review, not human approval or hosted CI proof.
Total execution was **236 Claude CLI attempts** (93 measured, 136 discarded,
one label check, three containment and three review attempts), plus two startup
failures before model dispatch, and **93 Jev client calls**.
