# Import enrichment comparison

Live experiment for [#850](https://github.com/schlessera/brain-kit/issues/850),
following [#838](https://github.com/schlessera/brain-kit/issues/838). No product
code changes. The issue specifies no deterministic baseline.

`run.ts` uses the semantic portion of the preserved cases and the additional
minimal pairs. The preserved scripted fault controls are excluded: their labels
describe injected provider responses, rather than live semantic judgments.
The label check and dropped/fixed cases are recorded in the results file.

Set `EVAL_SCRATCH` to an external scratch directory and `TMPDIR` to its `tmp`
subdirectory. Load `TYPESAFE_API_KEY` from the environment. Claude calls use the
logged-in subscription, with both Anthropic API-key variables removed by the
harness. Each case/repetition gets a disposable brain with the shipped
`brain-import` skill installed under `.claude/skills/`. Claude's restricted
file tools operate within that brain; the current arm can read, edit and write.
Restricted mode suppresses project skill discovery, so the prompt explicitly
reads and executes the installed skill. Verbose JSON verifies that Read in
every retained current run; an installed-but-unread skill does not qualify.
The focused summary call has only Read. At most two Claude CLI processes run
concurrently; rate limits back off and subscription exhaustion stops dispatch.
`calls.claude` counts CLI invocations, including the label check and the
interrupted initial invocation; `calls.jev` counts physical HTTP attempts.

For a fresh dataset, run one Sonnet 5.5 label check from a disposable brain,
with Read only and the same key removal. Ask it to check every semantic golden,
flag wrong/ambiguous labels and give reasons. Put its verdicts, `dropped` ids
and `fixed` corrections in `$EVAL_SCRATCH/labels.json`; apply clear corrections
to the case data. For this reviewed dataset, absent scratch labels fall back to the committed
`labelCheck`; clear corrections are already applied in the case JSON.

```sh
bun evals/850-import-enrichment/run.ts
# Resume interrupted work without repeating finished cases:
bun evals/850-import-enrichment/run.ts --resume
```

The type confidence floor rejects every wrong accepted tuning type. The tag
threshold maximizes tuning micro F1, choosing the lowest on ties. Both values
are selected before held-out classification. Repetitions are scored individually.
Tag omissions on invalid answers remain false negatives. Abstention reduces
coverage; proposed tags do not imply a completed write. `fileFieldsCorrect`
checks actual type/tags, preserving protected owner fields. Body rewrites,
unapproved paths and changes to protected metadata bytes are separate vetoes.
The manifest is outside this experiment's scope.

The skill sometimes reports whether a summary is still needed after writing
it. The scorer retains that report but scores its actual generation decision
from before/after file contents. Nonempty supplied summaries are retained.
`summaryNeedOnAccepted` reports summary need on non-abstained sources;
`summaryNeedCorrect` includes declined generation and thus also measures coverage.

A GPT-family judge scores each distinct `(case, summary)` against source text,
salient facts and prohibited claims; exact golden wording is not required.
Put `family`, `rubric` and `verdicts` (`id`, `summary`, `supported`, `complete`,
`reason`) in `$EVAL_SCRATCH/summary-judgments.json`, then run (absent scratch judgments reuse committed `summaryJudge`):

```sh
bun evals/850-import-enrichment/run.ts --analyze
bun run test experiments/850-import-enrichment-score.test.ts
```

The single results JSON holds reports, changed files, judgments and metrics;
raw Claude transcripts stay in scratch. `fullCorrect` requires raw semantic
labels, summary-need, actual fields, required supported/complete summaries and
zero write vetoes to agree. CLI ancillary model usage is disclosed in the
decision; the requested enrichment and summary model is Sonnet 5.5.
