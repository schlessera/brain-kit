# Decision — CLI code owns conservative mechanical hygiene repairs

**Go for a bounded CLI repair command; no-go for the Jev gate.** The lean
[#842](https://github.com/schlessera/brain-kit/issues/842) comparison supports
moving date normalization and supported hand-authored Status table repairs
out of the agent. Code scored 96/102 exact held-out source maps with no vetoes,
against 75/102 and 15 vetoed runs for the shipped skill. Jev could only decline
the code's proposals; it reduced exactness to 90/102 without improving safety.

This is a conservative subset, not a complete replacement for Phase 3.
Canonical conflicts and human dispositions remain outside this decision.
No production behaviour changes in this PR.

Measured on 2026-10-11 from main `898df4fb9daf44b24394f98595f1212a702ac229`
with the standalone [harness](../../evals/842-mechanical-hygiene/run.ts).
The [results JSON](../../evals/842-mechanical-hygiene/results-2026-10-11.json)
contains every run's score, changed paths, output hash, model judgments and
label-review verdicts. Raw stdout and disposable brains remain in external
scratch, as required by the evaluation instructions.

## Arms and cases

| Arm | Execution |
| --- | --- |
| Shipped skill | Unmodified `content-hygiene` installed into each brain's `.claude/skills/`, through subscription-authenticated Claude Code 2.1.295 and `claude-sonnet-5-5`. Full workflow, then a separate repeat invocation. |
| Code | Bounded planner plus real safe file writes and readback. Valid reversed date-only fields, and literal Markdown-link tables with supported columns and values. |
| Jev plus code | Same planner/applier, gated by `jev-1.13.0` Choice through the shipped core client. Jev cannot add or broaden an edit. |

All arms use identical case files and mtime values, with three repetitions.
The 42 preserved Odysseus cases plus negation and archived injection cases give
10 tuning and 34 held-out cases. Held-out contains four positive date cases,
six positive table cases and 24 no-write cases. The reference date is
`2026-07-12`; only brain CLI children receive that clock. Physical writes and
provider clocks remain real. Generated hygiene logs and disposable database /
scratch state are excluded from source-byte scoring; an input hygiene file
remains protected.

The prototype reuses table detection (`indexTableLag`,
`packages/core/src/lib/hygiene.ts:522-564`), scalar table rendering
(`renderRegistry`, `packages/core/src/lib/index-registry.ts:117-185`) and
the surgical frontmatter editor (`editFrontmatter`,
`packages/core/src/lib/frontmatter-edit.ts:216-224`). It intentionally refuses
wiki links and an entire index containing an unsafe row.

## Held-out quality and reliability

Each denominator is 34 cases × 3 repetitions. A vetoed run is counted once,
even when it has several veto reasons; majority voting does not hide it.

| Arm | Exact source maps | Positive repairs exact | Untouched files preserved | Vetoed runs | Repeat no-op | Case agreement | Invalid | No-write misses |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shipped skill | 75/102 (73.5%) | 18/30 | 87/102 | 15 | 102/102 | 29/34 | 0 | 12 |
| Code | **96/102 (94.1%)** | **24/30** | **102/102** | **0** | 102/102 | **34/34** | 0 | 6 |
| Jev plus code | 90/102 (88.2%) | 18/30 | 102/102 | 0 | 102/102 | 34/34 | 0 | 12 |

There are no fallbacks. “No-write misses” means an expected repair was left
unwritten, including a planner refusal; expected no-ops are not abstentions.
Agreement means identical complete source maps across all three repetitions.
An unchanged repeat can preserve an incorrect first edit: idempotence alone
is not correctness.

The skill never repaired reversed dates. Its vetoes include edits to fenced
example tables, duplicate/unknown-column or target boundaries, multiple-column
disagreements and indexes whose linked detail is excluded. It correctly repaired
the two corrected-label cases the code refuses. Code's six misses are precisely
those wiki-link and mixed-row cases. Jev additionally declined both timezone
date repairs in every repetition. On tuning, code scored 30/30, Jev 27/30 and
the skill 20/30. The confidence floor was selected only on tuning from
0, 0.4, 0.7 and 0.9, breaking ties toward the lowest value: **0**, frozen before
held-out judgments. Raising it did not recover Jev's `leave` decisions.

## Label review and isolation

Claude checked all 44 original goldens against their complete files and the
skill. It accepted 42 and disputed two. Both were corrected before scored runs:

- `ambiguous-wiki-link`: the shipped resolver uniquely resolves `[[raft]]`
  (`createWikiLinkResolver`, `packages/core/src/lib/indexer/links.ts:46-105`).
  The Status repair is eligible.
- `mixed-safe-and-ambiguous-rows`: repair the safe Raft row and preserve the
  Mast row with its additional Title disagreement. Phase 3 works per row.

No genuinely ambiguous cases remained, so none were dropped. The review prompt
stated the preserved corpus's conservative eligibility rubric, which is stricter
than literal skill wording on some duplicate, unknown and excluded-detail cases.
Those vetoes mean outside the benchmark's eligible set; they do not all prove a
literal skill-instruction violation.

Current-path brains and a separate product copy were outside the checkout,
with no symlinks back and no goldens/results in the brains. Bash allow rules
named exact product commands; file writes used scoped tools in `dontAsk` mode,
following the [Claude Code permission syntax](https://code.claude.com/docs/en/permissions).
All **264 qualified stdout JSON transcripts** were searched for evaluation,
case and result paths: **zero hits**. One optional filtered-list command was
denied; that workflow completed. No unexpected non-Markdown writes were requested.

Counts before PR review: **287 Claude invocations and 150 Jev client calls**.
They include three unnecessary successful retries caused by initially treating
allowed rate-limit telemetry as an error; the first label verdicts were retained.
Sixteen preliminary current-path calls were excluded because shell scratch writes
blocked Phase 4. Qualified runs pre-created scratch and explicitly used Write for
the arrays. Nine shortened-question Jev repeat checks were excluded and repeated
with the exact initial question/state; all corrected checks were no-ops. Every
attempt remains counted. The results record the subsequent cross-family PR review.

## Limits and smallest integration

This is a small authored corpus with related templates. The author saw the
goldens; held-out separates confidence calibration, not blind fixture development.
The planner received fixture mtime metadata. Offset boundary inputs were tested,
not a separate worker timezone matrix. No scale, stale-input race, concurrent
editor, crash recovery or hygiene-log fidelity claim follows. The archived
injection can be skipped before reading; it is not a broad injection defence.
Costs and latency were not evaluated.

The smallest integration is one explicit providerless CLI planner/apply operation
for this supported grammar, with `--json` and dry-run output, followed by the
existing reconciliation. Re-read every consulted input and use the existing
unchanged-source writer (`replaceIfUnchanged`,
`packages/core/src/lib/hygiene.ts:1108-1118`) before application. Keep registry
ownership, inbox/archive exclusions and all unhandled cases visible as log-only.
The skill delegates these two mechanical operations; canonical judgment remains
with it. That follow-up needs the additive contract documentation and normal
product tests, including the full reviewed corpus. Jev is unnecessary here.
