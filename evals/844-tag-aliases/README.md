# Lean tag alias comparison

Issue [#844](https://github.com/schlessera/brain-kit/issues/844), under the
[#838 lean protocol](https://github.com/schlessera/brain-kit/issues/838).
The experiment proposes aliases; it never applies them to product data.

Use Bun and an authenticated Claude Code subscription. Load `~/.env` in the
calling shell; `TYPESAFE_API_KEY` supplies Jev. The harness removes
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from every Claude invocation.
Choose a fresh scratch directory outside the checkout and put `TMPDIR` there.

```sh
bun evals/844-tag-aliases/run.ts labels --scratch "$EVAL_SCRATCH"
bun evals/844-tag-aliases/run.ts run --scratch "$EVAL_SCRATCH"
```

Inspect the label verdicts before running. The run checks unique matching case ids and unanimous agreement. Fix clear errors or drop ambiguous
cases, then repeat the label check in fresh scratch if inputs changed. All
33 labels in this run were agreed. Raw CLI outputs and case brains remain in
scratch; only the single compact results JSON is committed. Completed calls
are reused when resuming an interrupted run with unchanged inputs.

Each current run installs the unchanged shipped `audit` skill in
`.claude/skills/audit`, builds a keyless index with the product CLI, and asks
Sonnet 5.5 for its tag-noise judgment in report-only mode. Read, skill discovery
and the audit/tag reports are allowed. A structured answer makes the pair
proposal mechanically scoreable. Other audit phases are excluded.

Candidate retrieval admits lexical variants, tag acronyms, a shared tag
component of four or more letters, or two shared context words after a generic
English stop list including common note-writing verbs. Actor names count as shared words. Every pair is also judged diagnostically, including
retrieval rejects: core Jev Choice receives each orientation in a separate
request. A proposal requires retrieval, orientation agreement on `same`, and
both confidences at the tuning-selected floor. The fixed grid selects zero
tuning false merges, then maximum recall, then the lowest floor. No safe floor
means no alias proposals. Held-out data never selects that floor.

Three repetitions retain every case. A filtered negative counts as a correct
rejection; a filtered positive is a recall miss; a filtered unknown is not an
explicit correct abstention. Any `same` on a negative or unknown vetoes the
arm, regardless of other repetitions. Agreement means identical final
verdicts in all three repetitions. Invalids and explicit abstentions are
separate; no fallback model is called. The lexical baseline runs the shipped
`findVariantGroups` with each case’s tag config.

At most two Claude processes run concurrently. Rate limits back off; a
subscription usage limit stops new dispatch. The simple 350-call cap includes
CLI invocations and Jev HTTP attempts (including the client’s retry), not the
agent’s internal turns. No cost is measured. This pair fixture study does not
measure retrieval over a large real vocabulary or validate unattended writes.

After opening the PR, save `gh pr diff` as `pr.diff` in scratch and run
`run.ts review --scratch "$EVAL_SCRATCH"` for the cross-family review. Its
findings and the updated call count join the same dated results JSON. A rerun uses the current UTC date. Review reads that day’s results. The review prompt travels through stdin to avoid operating-system argument limits.

Offline scoring tests:

```sh
bun run test ./experiments/844-tag-aliases.test.ts
```
