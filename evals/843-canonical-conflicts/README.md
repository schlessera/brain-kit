# Lean canonical conflict evaluation (#843)

Explicit live measurement, outside ordinary CI. Uses the shipped core Jev
client and an unchanged copy of `content-hygiene`, executing Phase 2 only in
fresh disposable brains. Claude Code authenticates with its logged-in
subscription; both Anthropic API credential variables are removed on every
spawn. At most two Claude children run at once; rate limits back off and
subscription exhaustion stops dispatch. No provider fallback is configured.

```sh
set -a; . "$HOME/.env"; set +a
export EVAL_SCRATCH="<absolute scratch directory outside the checkout>"
export TMPDIR="$EVAL_SCRATCH/tmp"
mkdir -p "$TMPDIR"
bun evals/843-canonical-conflicts/run.ts --labels
# Inspect verdicts; fix clear label errors and record/drop ambiguous cases.
bun evals/843-canonical-conflicts/run.ts --run
bun evals/843-canonical-conflicts/run.ts --review
# Recompute active-case summaries from saved responses; makes no model calls.
bun evals/843-canonical-conflicts/run.ts --summary
```

The one results JSON checkpoints completed case/repetition outcomes. Delete
it and use a fresh scratch directory for a new experiment; rerunning `--run`
resumes completed outcomes. The call count includes dispatches/retries by the
harness; Jev's core client can internally retry a rate-limited HTTP attempt.
Raw Claude CLI outputs stay in the external scratch directory. The JSON keeps
the scoreable conflict reports and the complete typed Jev responses.

`cases.json` preserves the semantic workload from the shared case file and
adds ten discriminating cases. It retains dropped cases for traceability;
`results.labelActions` describes the review and `results.dropped` excludes it
from all three arms. The archived deterministic extractor is ported directly
in the small script: only Count/Date pairs with identical explicit single-valued
scope can produce a positive. Semantic pairs abstain without Jev. The candidate
uses the same extraction and exclusion rules, then sequential same-subject and
contradiction Choices. Repetition 2 reverses the Jev pair orientation.

The confidence floor grid is 0, .2, .4, .6, .8. Tuning chooses fewest vetoes,
then most true positives, then three-class correctness, then lowest floor.
The selected floor is applied unchanged to held-out. Unknown is scored as a
separate class; a yes on unknown is a false-positive veto. Agreement requires
all three repetitions to match label and validity. Every false report counts,
including minority repetitions; there is no majority vote.

Offline scoring tests: `bun run test experiments/843-canonical-conflicts-score.test.ts`.
