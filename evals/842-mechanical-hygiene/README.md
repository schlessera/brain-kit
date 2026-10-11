# Mechanical hygiene spike

`run.ts` is an opt-in live evaluation, separate from ordinary offline tests.
It reads the preserved 842 cases and two added held-out boundaries. The code
planner produces bounded date and table edits. The Jev arm can decline those
edits; it cannot introduce new ones. The current arm runs the unmodified
installed `content-hygiene` skill through Claude Code on Sonnet 5.5.

Choose an empty scratch directory **outside the checkout**, set `LEAN_SCRATCH`
to its absolute path and `TMPDIR` to its `tmp` child. Load provider keys from
the environment, then run:

```sh
mkdir -p "$TMPDIR"
bun evals/842-mechanical-hygiene/run.ts --labels
# Inspect labelCheck; correct clear errors and exclude genuinely ambiguous inputs.
bun evals/842-mechanical-hygiene/run.ts
```

`LEAN_RESULTS` optionally selects a new results file. The default is
`results-2026-10-11.json`; completed rows are reused on resume. A new measurement
needs a fresh results file and scratch directory. `--code-only` runs the code
and Jev arms before the current arm. All three arms have three repetitions.
Each current run has a separate second invocation to check repeat no-op.

Only the brain CLI child uses the pinned `2026-07-12` clock; provider clocks
stay real. Date normalization uses the UTC mtime day, including timezone
boundary inputs. Physical writes retain real mtimes. Generated hygiene logs
and disposable database/scratch files are excluded from source-byte scoring;
any hygiene file supplied as input remains protected. Logs are not evaluated.

The harness copies product packages/dependencies into scratch, installs the
shipped skill in each brain's `.claude/skills/`, and creates a PATH shim.
Brains contain no link to the checkout, goldens or results. Current runs have
scoped file permissions, an explicit checkout read denial, exact product Bash
commands and `dontAsk` mode. Every Claude subprocess removes both Anthropic
credential variables; it uses the logged-in subscription. Two workers run at
most two Claude processes. Rate limits back off; a subscription usage-limit
response stops dispatch. Call counts include attempts.

Raw stdout JSON and per-arm brain copies stay in scratch. Inspect current
transcripts for access to `evals/`, case/result paths and denied tools before
accepting their score. The committed JSON contains labels, per-run scores,
changed paths, output hashes, model judgments and a held-out summary. Exactness
uses whole source file maps; vetoes cover ineligible files, lost metadata/body
and unsupported rows. A successful repeat means the complete scored map is
unchanged, independently of whether its first repair was correct.
