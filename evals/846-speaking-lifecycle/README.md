# Speaking lifecycle lean evaluation

Live experiment for [#846](https://github.com/schlessera/brain-kit/issues/846),
under [#838](https://github.com/schlessera/brain-kit/issues/838). No production
change. `cases.json` extracts the 19 natural-message corpus cases from
`evals/cases/846-speaking-lifecycle.json` and adds 11 discriminating cases.
Historical receipt fields and retired harness plumbing are not carried over.
The inputs use ordinary submission summaries and the shipped skills' tables.
Each case has three tracked submissions across two assemblies.

Set `EVAL_SCRATCH` and `TMPDIR` to writable directories outside this checkout.
Load `TYPESAFE_API_KEY` from the environment. Sign in to the Claude Code CLI
with the subscription; the harness removes both Anthropic key variables from
every Claude child. Do not run these live commands inside the test runner.

```sh
bun evals/846-speaking-lifecycle/run.ts --labels
# Resolve any review disagreements in cases.json before continuing.
bun evals/846-speaking-lifecycle/run.ts
bun evals/846-speaking-lifecycle/run.ts --rescore
bun run test experiments/lean-speaking-score.test.ts
```

The harness installs the unchanged speaking skills in each disposable brain,
provides the real core CLI for archiving, runs at most two Claude processes,
and writes one results JSON. Raw CLI reports and changed Markdown stay in
scratch. The explicit-owner arm receives the reviewed structured decision:
it measures mechanical updates, not interpretation of a message. All arms
see the same initial brain and source. Only the primary message is exercised;
historical secondary messages and repeated workflow checkpoints are not run.

Jev uses two Choices through core's client: outcome and joint submission /
assembly target, including `none`. Owner-specified withdrawal, delivery and
closure remain explicit operations; classification never grants permission.
Dates and labelled conditions are copied by code. There is no confidence gate
or tuning of a floor (the recorded threshold is null).

Scoring reads the files, independently of the final classification report.
It checks active/archive status, submission summary outcome/date, status and
proposal rows, mixed conference summaries, accepted focus, delivery registry,
conditions/deadlines, archive relevance and protected content. Formatting,
case and sentence punctuation are tolerated; prose generation is excluded.
Vetoes are reported per repetition, without majority-vote suppression.
Agreement measures both classification pairs and scored field effects.
Submission-target accuracy is also reported separately for outcome messages:
the current arm's final-report instruction can be read as requesting `none`
for non-outcome actions, even when its actual files record the right delivery
or closure. Those report targets are not evidence of wrong-target writes.
