# Lean opportunity lifecycle comparison

Run manually with provider credentials in the environment. Ordinary CI only
imports the offline scorer. `run.ts` compares the shipped skills through Claude
Code, Jev Choice plus the small explicit-facts updater, and the shipped
`brain jobs pipeline` command alone. Each case starts from an identical brain,
including at least three tracked opportunities. Three repetitions execute tuning
before held-out. No confidence floor is selected: the fixed floor is zero.

Set `EVAL_SCRATCH` to a fresh directory **outside** the worktree and `TMPDIR` to
its `tmp/` child. Copy the installed dependencies there, dereferencing workspace
links; provide a `bin/brain` PATH shim running that copied product CLI. The shim
must accept only `config check --json`,
`config get modules.@schlessera/brain-module-jobs`, `jobs pipeline`, and
`jobs pipeline --json`. There must be no links back to the worktree. The harness
copies the two shipped skills into each current-path brain's `.claude/skills/`.

```sh
mkdir -p "$EVAL_SCRATCH/tmp" "$EVAL_SCRATCH/bin"
cp -rL node_modules "$EVAL_SCRATCH/node_modules"
# Install the product-only brain shim in $EVAL_SCRATCH/bin, pointing at
# $EVAL_SCRATCH/node_modules/@schlessera/brain/src/cli/brain.ts.
set -a
. ~/.env
set +a
bun run evals/845-opportunity-lifecycle/run.ts
```

`EVAL_CLAUDE_MODEL` (default `claude-sonnet-5-5`) replaces only the current-path
model; any other model writes `results-<model without claude->-2026-10-11.json`
instead of the Sonnet results. Seed scratch `jev-<rep>-<index>.json` files from a
stored results file to replay the candidate without new Jev requests.
`EVAL_CLAUDE_WORKERS` (default 2) bounds concurrent Claude sessions.

Every Claude process removes the Anthropic API-key variables and uses the
logged-in subscription. Restricted file tools cannot leave the brain, and Bash
is limited to the four product commands. Native modes also auto-approve some
read-only shell commands, so a tiny native permission hook denies every Bash
call except those four literal strings. `dontAsk` plus explicit Edit/Write
approvals permits content updates; config writes are denied. This is ordinary
tool enforcement, with no sandbox launcher or evaluation admission framework.
Verbose stdout JSON and changed-file
snapshots stay in scratch; scan them for evaluation/case/result access before
accepting the comparison. A subscription limit stops further dispatch; transient
rate limits retry with backoff. Saved complete outputs permit continuation
without repeating calls. Start with fresh scratch for a new measurement.
The cache selects the last completed non-transient-error attempt; each retry
resets the brain. The final report derives class, reliability, mapping,
sensitivity and isolation sections from the saved outcomes. Optional
`execution-notes.json` and `review-verdict.json` in scratch provide human-written
historical measurement/review annotations. Complete Jev Choice answers are
included in the compact results; raw agent transcripts and after-files remain
in scratch.

`cases.json` derives independent checkpoints from the preserved authored corpus:
the previous checkpoint's illustrative snapshot supplies the prestate, never the
answer. The four seeded groups contribute booking and rebooking; all fresh groups
were considered. Six added messages cover negation, unrelated input, ambiguous
targets, injection and explicit rejection. Five disputed cases are excluded;
three replacements provide the previously missing explicit confirmations.
Four further held-out checkpoints strengthen cancellation, offer, closure and
custom-directory coverage.
The original corpus is unchanged. Label verdicts are retained in the cases and
compact results, including the inconsistent partial-draft verdict.
Scenario-name hints remain in `notes/unrelated.md` and `attachments/manifest.txt`.
The published audit found no reads of those files or tool-result exposures of
their hint text. Removing explicit case-id prose did not scrub every hint.

Exact means all selected semantic fields/file obligations pass, rather than
byte-identical Markdown. The scorer accepts ISO dates or day/month wording and
CEST for Europe/Berlin. It checks mapping, deadlines, call details including
format/duration, related links,
focus, pipeline, untouched unrelated content and literal authored history/prep
retention. A wrong opportunity edit or lost retained content is a veto.
Agreement means identical mapping, check vector and vetoes across all three
repetitions; generated prose can vary. Field agreement additionally requires
identical selected frontmatter values, including the text of `next_step`.
Counts are Claude CLI invocations and Jev
HTTP attempts, including preparation and retries, rather than hidden CLI turns.
The decision's sensitivity table excludes links and merges no-write label names:
the strict 90% versus 73.3% gap becomes a 90% tie. Refusal success largely comes
from the code guards; raw Jev event accuracy is 80%. Tuning contains only positive
events. `updated` bumps are unmeasured because prestates share the event day.
