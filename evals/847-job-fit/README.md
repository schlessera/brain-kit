# Lean job-fit evaluation

Opt-in only. The harness uses the shipped core Jev client, shipped job scorer
and an unchanged copy of the research-opportunity skill installed in each
disposable brain. It runs two local Claude CLI workers at most, three
repetitions per model arm, and saves raw reports and resumable state outside
the repository. Claude subprocesses remove both Anthropic key variables and
use the logged-in subscription. There is no generation fallback.

Load the environment keys, set `EVAL_SCRATCH` to an external directory with
space for brain copies, and set `TMPDIR` to its `tmp` directory:

```sh
export EVAL_SCRATCH="$HOME/runs-lean/847"
export TMPDIR="$EVAL_SCRATCH/tmp"
set -a
. "$HOME/.env"
set +a
bun evals/847-job-fit/run.ts
```

The label check runs once when scratch state has no verdicts. Review a flagged
label before continuing. This recorded run checked all 29 semantic goldens,
dropped the ambiguous `held-future-duty` case, and scored the remaining 28.
The historical extraction controls are retained in the input file but are
outside this semantic comparison.

The confidence grid is 0, 0.4, 0.6, 0.8, 0.9 and 0.95. Selection uses only
tuning: fewest unsafe dealbreaker passes, highest queue agreement, then lowest
floor. Both selected probability and confidence must meet it. Held-out results
use that selection unchanged. Candidate exclusions retain literal configured
markers; their false exclusions count as errors.

Both semantic arms receive the same criteria prose, precedence and current-exclusions clarification. The skill gets a report-format adapter defining relocation polarity and queue
labels, a fictional company packet instead of external research, and all local
file/CLI tools needed by the shipped workflow. Keyword scoring sees the shipped
`ScoreJobInput`, while both semantic arms also see the full posting and packet.
This is the product input boundary difference, not identical visibility.

Run scoring tests offline with:

```sh
bun run test experiments/job-fit-lean.test.ts
```

The results JSON records each scored repetition, invalid answers, review routes,
confidence gates, tuning calibration, label verdicts and call counts. Repeated
observations are not independent samples. Raw reports and complete generated
files stay in scratch.

Claude counts CLI invocations, not individual agent turns. The candidate hard
location guard differs from shipped scoring, which only removes location points.
Jev uses the user-specified version pin and a 60 s transport budget. Pipeline
file presence and permission denials are recorded, but label non-access through
Bash or the package symlink was not verified.
