# Decision — make explicit opportunity lifecycle updates deterministic

The [#845](https://github.com/schlessera/brain-kit/issues/845) comparison supports
**go for scoped explicit-input command development**, after fixing the prototype's
two observed defects. The harder evidence is three unwarranted writes against
the skills' eight, and repeat agreement on 40 of 40 cases against 31 of 40.
The strict rubric gives Jev plus code 81 of 90 held-out exact outcomes (90%)
against the skills' 66 (73.3%), but the gap disappears under the sensitivity
checks below. This does not establish a quality advantage for Jev or authorize
shipping this prototype. All arms have zero destructive-error vetoes.

Measured on 2026-10-11 against main
`898df4fb9daf44b24394f98595f1212a702ac229`, using
[`run.ts`](../../evals/845-opportunity-lifecycle/run.ts),
[`cases.json`](../../evals/845-opportunity-lifecycle/cases.json) and
[`results-2026-10-11.json`](../../evals/845-opportunity-lifecycle/results-2026-10-11.json).
No production behaviour or compatibility contract changes in this spike.

## What was compared

Forty independent checkpoints: ten tuning and thirty held-out, with three
repetitions of every arm. Every run starts with identical case files, explicit
confirmed facts and at least three tracked opportunities. The fixture day is
2026-07-12. Checkpoints derive from the preserved Odysseus corpus, with additional
negation, unrelated-input, ambiguous-target, quoted-injection and explicit
closure cases. Cancellation, offer and closure each have three held-out positives.

| arm | what runs |
| --- | --- |
| Current skills | Claude Code on `claude-sonnet-5-5`, reading the shipped `interview-scheduled` and `research-opportunity` skills installed inside a disposable brain. File edits and the shipped config/pipeline commands are available; research and prep prose are excluded. |
| Jev plus code | The shipped core Jev client on `jev-1.13.0` asks two Choice questions: event and existing opportunity. A small experiment-only updater applies explicit confirmed facts, then runs the shipped pipeline. |
| Pipeline alone | The shipped `brain jobs pipeline --json`; it regenerates the derived view and makes no lifecycle update. This is a diagnostic floor, not a proposed replacement. |

All Jev answers are attempted: the confidence floor is fixed at zero, with no
threshold selected from held-out observations. The updater refuses missing
booking facts, contradictory timezone/clock facts, unknown targets and missing
rounds. It preserves authored prose and prior calls as history. Both model arms
receive the same explicit facts; extraction of those facts from free prose is
not measured.

## Results

Exact means every selected semantic field/file obligation passes, together with
zero vetoes. It does not require byte-identical Markdown. Mapping includes correct
`none`/`unclear`; a clarification can name a known target. Vetoes are edits to the
wrong opportunity or loss of retained timeline/prep prose. Each repetition is
counted individually, with no majority vote.
The current-path prompt does not define `none` versus `unclear`; Jev's criteria
do. These are end-to-end handler outcomes, not Jev-only classification scores.

| arm | held-out exact | held-out mapping | held-out vetoes |
| --- | --- | --- | --- |
| Current skills | 66 / 90 (73.3%) | 77 / 90 (85.6%) | 0 / 90 |
| Jev plus code | **81 / 90 (90%)** | **87 / 90 (96.7%)** | **0 / 90** |
| Pipeline alone | 6 / 90 (6.7%) | 6 / 90 (6.7%) | 0 / 90 |

The link rubric requires an existing prep's Related links and its status backlink
to be complete after an update. The skill explicitly gives minimum content and a
backlink action, but its existing-prep update sentence is less explicit about
repairing these omissions. Four other skill failures only differ in the no-write
label vocabulary. Both sensitivities matter:

| held-out exact under alternate rubrics | current skills | Jev plus code | pipeline alone |
| --- | --- | --- | --- |
| Exclude `links` | 77 / 90 (85.6%) | 81 / 90 (90%) | 6 / 90 (6.7%) |
| Merge `none`/`unclear` on no-write goldens | 70 / 90 (77.8%) | 81 / 90 (90%) | 27 / 90 (30%) |
| Apply both relaxations | **81 / 90 (90%)** | **81 / 90 (90%)** | 27 / 90 (30%) |
| Unwarranted writes among 27 no-write runs | **8 / 27** | **3 / 27** | 0 / 27 |

The relaxed metric still requires unchanged brain content on a no-write golden.
It does not count a wrongly applied event as correct merely by ignoring mapping.

The candidate's nine failures are reproducible in all three repetitions:

- Two cancellations leave another call booked. The updater records that next
  call but omits the confirmed cancellation reason from the new timeline entry
  (`two-rounds-offset-order-2`, `module-directory-3-confirmed`).
- Duplicate focus entries require conservative clarification in the approved
  golden. The updater instead changes both (`ambiguous-focus-0`). Jev identifies
  the booked event correctly but does not see the focus document; this guard
  belongs in the mechanical updater.

The candidate is worse on cancellation: 3 / 9 exact against the skills' 6 / 9.
It reaches 27 / 27 on scheduling, 9 / 9 on rebooking, 9 / 9 on offers and 9 / 9
on closure; the skills reach 23 / 27, 5 / 9, 8 / 9 and 9 / 9 respectively.
On `none` and `unclear`, the candidate reaches 6 / 6 and 18 / 21, against the
skills' 3 / 6 and 12 / 21. Those class counts remain in the results.

The skills miss the rubric's related-file links in eleven held-out runs, and make
eight edits where the approved golden requires no write. They also make three
unnecessary clarifications for an unrelated message. One offer run refuses to
act because it incorrectly claims the installed skills are unavailable.
These checks overlap; the total is twenty-four failed runs, not their sum.
Tuning exact outcomes are 21 / 30 for the skills, 30 / 30 for the candidate and
0 / 30 for the pipeline baseline.

| reliability across all 40 cases / 120 runs | current skills | Jev plus code | pipeline alone |
| --- | --- | --- | --- |
| Identical mapping, checks and vetoes across three repetitions | 31 / 40 | 40 / 40 | Not informative |
| Also identical selected frontmatter values | 28 / 40 | 40 / 40 | Not informative |
| Invalid answers | 0 / 120 | 0 / 120 | 0 / 120 |
| Abstentions (`unclear`) | 16 / 120 | 18 / 120 | 0 / 120 |
| Fallbacks | 0 | 0 | 0 |

Field agreement includes the literal `next_step` value, so harmless phrasing
differences can reduce it. Correct abstentions are useful; the candidate's three
missing abstentions on duplicate focus entries are failures. No latency, money
or cost ranking is measured. Counts cover provider invocations, including
discarded preparation, label checks and review; they are not Claude's internal
turns.
Total dispatch was **259 Claude CLI invocations**: 120 scored current-path runs,
134 excluded setup/scope runs, three label checks and two review rounds. Jev made
**130 HTTP requests**: 120 scored and ten preparation. The harness increments
arm dispatches; label and review invocations are added to the same running count
by their manual CLI caller. Fallbacks are structurally zero: no fallback path
exists in this spike.
Held-out agreement is 24 / 30 for the skills and 30 / 30 for each other arm;
field agreement is 23 / 30, 30 / 30 and 30 / 30. Of the skills' sixteen held-out
abstentions, twelve are correct and four are unnecessary. All eighteen candidate
abstentions are correct; the goldens call for twenty-one.
Pipeline-only agreement is trivially 40 / 40 for a no-update baseline and is
not evidence of model reliability.

Jev's raw event choice is correct in only **72 / 90 (80%)**. The code improves
this to 87 / 90: twelve correct refusals come from missing contact/timezone,
conflicting offset or absent prior round; three more use Jev's untracked-target
choice to refuse the event. Only the three ambiguous-target refusals originate
as Jev `unclear` event choices. The experiment does not isolate Jev's added value
with an oracle-mapping/code-only ablation.

## Label check and isolation

Claude checked every final golden before its measurement. Three CLI label calls
produced 46 item verdicts. The first pass flagged four ambiguous labels and one
wrong label. We removed those five original cases. The wrong label depended on
a retired event-receipt requirement; after correcting it, the follow-up verdict
reversed to ambiguous, so the unstable case was excluded. Three replacements
make cancellation/focus and offer/sibling retirement explicit. Four further
held-out cases strengthen cancellation, offer, closure and custom-directory
coverage. All seven additions passed. Verdicts, reasons and excluded ids remain
in the results; the preserved original corpus is unchanged.
This judge is from the author's different model family, but shares the current
arm's Claude family. Added messages explicitly settle cancellation/focus and
sibling-retirement policy; they test following those confirmations. Some offer
focus expectations also go beyond an explicit sentence in the shipped skill.

Current-path brains and a dereferenced copy of product dependencies live outside
the worktree, with no links back. A PATH shim exposes only the four exact product
commands; file tools are restricted to the brain, and config writes are denied.
Claude Code's native modes automatically permit some read-only Bash commands,
so `--allowedTools` alone is insufficient. A small native `PreToolUse` permission
hook denies every other literal Bash command.
([Claude Code permissions](https://code.claude.com/docs/en/permissions))

All 120 final stdout JSON transcripts were scanned for `evals/`, case/result
paths and the worktree identifier: zero matches. Their tool calls show zero
outside file access. All 85 attempted non-product Bash commands were denied;
395 product Bash calls were allowed. Both the brains and copied runtime have
zero symlinks. Every final CLI initialization reports `apiKeySource: none`.
The one refusal that did not read a skill remains a scored failure, not an
excluded run. Raw transcripts and changed-file snapshots stay outside the tree.
Scenario-name hints remain in the unrelated note and attachment manifest. They
were not goldens or external paths, but could reveal a scenario class. Across all
120 transcripts there are **zero reads of those two files and zero tool-result
exposures of their hint text**. The earlier claim that all hints were scrubbed
was incorrect; the final dataset keeps the measured inputs unchanged.

Early preparation calls and both runs made before that literal-command hook
were excluded: 134 Claude invocations in total. Their raw outputs remain outside
the tree. The final comparison uses only the enforced run. Scoring corrections
for equivalent date/time wording, retained bullet contacts and retired pipeline
cells were applied uniformly to saved outputs; they did not change model answers
or the fixed confidence policy. Candidate outputs were replayed from the same
three saved Jev answers after correcting contact/timeline section placement in
the updater. No new provider answer was selected to improve a score.

## Smallest integration and limits

Add one explicit-input jobs lifecycle command in separate scoped work: a
validated event, existing opportunity and confirmed facts drive status,
timeline, contact, prep deadline, focus and pipeline updates. Resolve paths from
the configured taxonomy/module and use the product's normal safe-path and write
helpers. Fix cancellation-reason retention and define/refuse ambiguous focus
before shipping. Jev's two Choice questions can provide an optional mapping
step, with `none`/`unclear` preserved. Research, questioning and prep prose stay
with the agent; its benefit needs a separate ablation before adoption. An additive
public command would need its own contract work.

- Forty authored checkpoints share scenario families; repetitions are not
  independent new examples. These percentages do not estimate population error.
- Section-placement and scorer corrections followed inspection of saved outputs.
  This is formative held-out evidence, not an untouched final validation set;
  production adoption needs a fresh validation set after those fixes.
  The updater and scorer were co-developed against this rubric, so candidate
  exact outcomes are optimistic about unseen inputs.
- The approved refusal goldens are deliberately conservative. In particular,
  duplicate focus and missing timezone labels impose clarification even where
  the shipped skill leaves some policy implicit.
- Scoring covers selected facts and literal retained prose, not a full human
  review of every generated sentence. Contact deduplication, arbitrary malformed
  Markdown/frontmatter, binary files, symlinks, concurrent writes and production
  path safety are not proven by this prototype.
- Explicit facts are supplied to both model arms. No confidence calibration or
  automatic extraction from an ordinary conversation is established.
- Tuning contains only positive events. Both Jev's instructions and the refusal
  guards were authored against the brief's known failure families, not learned
  on representative tuning data. Jev ignored the missing/conflicting-fact
  instruction on all twelve fact-validity runs.
  The fixed confidence floor establishes no generalization guarantee. The offer
  plus deadline but no next-step refusal rule remains untested after its disputed
  case was dropped.
- All prestates already have `updated: 2026-07-12`. A date-bump obligation is
  unmeasured; the vacuous check was removed during review.
- The real CLI runs on the measurement day's clock; the prompt and event facts
  use 2026-07-12. The derived pipeline's own generation timestamp is not scored.
- The restricted current arm can edit the same brain files the skill needs,
  but has no general shell, network research or prose-writing task. Its measured
  scope is the coordinated mechanical update, not the complete user workflow.
- Raw agent transcripts and after-file snapshots remain in scratch as requested;
  public readers can inspect the compact Jev answers and derived rows, but cannot
  independently rerun the retrospective transcript audit without those raw files.
  The harness now derives the sensitivity, class, reliability and audit sections
  directly from retained scratch outputs.
