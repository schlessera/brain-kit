# Candidate extraction spike

`run.ts` compares the shipped conference/job research skills on Sonnet 5.5,
regex candidates plus the shipped core Jev client on Jev 1.13.0, and an
always-unclear floor. It reads the 24 preserved natural workloads plus eight
added positive cases; the label review drops one ambiguous case. The preserved
24 parser controls remain available but are not the semantic evaluation set.

Prepare an independently installed runtime **outside the checkout** by copying
`packages/`, `package.json` and `bun.lock`, excluding existing `node_modules`
and build outputs, then running `bun install --frozen-lockfile` there. Set
`EVAL_RUNTIME` to that directory and `EVAL_SCRATCH` to another external directory.
Load provider credentials in the calling shell, then run:

```sh
TMPDIR="$EVAL_SCRATCH/tmp" bun evals/849-candidate-extraction/run.ts
```

Claude uses the logged-in subscription; its API credentials are removed on
every invocation. At most two Claude processes run together. The optional
`run-notes.json` in scratch records discarded calls and label resolutions;
it is copied into the single committed results JSON. On a new scratch directory
the harness first checks every golden through Claude. Resolve flagged labels
in the case data and scratch `label-verdicts.json` before proceeding.

Every current run gets a fresh disposable brain with copied shipped skills,
local module entries and a CLI shim to the independent runtime. Native
`--restricted` confines file tools. A short tool hook restricts Bash to the
three exact product commands and protects module, skill and configuration files
from edits, including root Bun configuration and dependency files. Earlier
current-arm runs used a narrower guard and were discarded. Native
`acceptEdits` alone does not enforce a Bash whitelist. No repository path,
goldens or results are installed in the brain. Raw verbose stdout JSON remains
in scratch; the harness scans it for evaluation/label/result path access.

Three repetitions run per case and arm. The confidence floor maximizes exact
role/occurrence accuracy on tuning, ties choosing the lower floor; it freezes
before held-out dispatch. A wrong span counts as both FP and FN. Explicit
absence and unmentioned uncertainty count separately in exact accuracy;
always-unclear has undefined extraction precision and zero recall.
An asserted value for an unannounced field is an invented field-value veto;
literal invention (text or occurrence absent from the source) is counted
separately. A copied cutoff can still invent an event-end field value.

Both extractors feed the same deliberately small normalizer. Normalized scores
measure this pipeline, not independently generated agent arithmetic. Unsupported
units/timezones/currencies abstain; hourly/monthly pay keeps its stated period.
The normalizer is a prototype, not a general date/currency library or a shipped
production helper. No fallback model is dispatched.

Completed scratch rows are reused on restart. Remove them to request a new live
measurement; do not reuse rows after changing the inputs or extraction prompt.
Scoring-only changes can reanalyze them without provider calls. Run the offline
scorer tests with `bun run test experiments/849-candidate-scoring.test.ts`.
When adjudicating labels after held-out dispatch, retain the pre-dispatch floor
in scratch `run-notes.json` as `originalFrozenCalibration.floor`; this run's
results record both original and rescored tuning counts. This avoids changing
the intervention after inspecting held-out results.
