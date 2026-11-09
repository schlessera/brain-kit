# Propagation triage evaluation (#3445)

Explicit live measurement under [#838](https://github.com/schlessera/brain-kit/issues/838)'s
lean protocol. Nothing here changes production detection, review, or frontmatter
semantics. The authored Odysseus observation day is `2026-07-12`.

```sh
bun run test experiments/3445-propagation-triage.test.ts
bun evals/3445-propagation-triage/run.ts --offline
# Requires TYPESAFE_API_KEY and an authenticated local Claude Code subscription.
bun evals/3445-propagation-triage/run.ts --run --max-usd 15
bun evals/3445-propagation-triage/run.ts --summary
# Same complete texts plus explicit computed source diffs; a separate comparison.
bun evals/3445-propagation-triage/run.ts --with-diff --offline
bun evals/3445-propagation-triage/run.ts --with-diff --run --max-usd 15
bun evals/3445-propagation-triage/run.ts --with-diff --summary
# Recompute a recorded run on a later date without any provider calls.
bun evals/3445-propagation-triage/run.ts --summary --results evals/3445-propagation-triage/results-with-diff-2026-11-03.json
```

The harness checkpoints one dated results JSON; rerunning resumes completed
case/arm/repetition rows. A new measurement needs a separate output file/date.
It refuses to mix changed cases, skill, question, schema or requested models
with earlier observations. Raw Claude transcripts stay in temporary directories
outside the checkout; only typed labels, reasons, reported model IDs and usage
enter the public results. No production or private corpus is read.

The `--with-diff` comparison preserves the original run as a control. It adds
`changesSinceReference` to both provider arms: one code-computed unified diff
per source, from the supplied reference snapshot to the current source, plus
the derivative's reference date and explicit availability. Missing history
produces no inferred diff. Fixtures associate the old snapshot with that date;
this does not implement Git history discovery or prove that a date identifies
the version used by a real generator. Both comparisons together share the $15
guard. The variant calibrates on its own tuning rows before its held-out calls.
The original control runs one current-arm child at a time; the diff comparison
runs at most two isolated current-arm children. Their dollar reservations are
recorded before dispatch. No latency comparison is made across those schedules.

## Inputs and comparison

There are 36 authored cases: 12 tuning and 24 held-out, balanced across
`still_current`, `needs_update` and `uncertain`. Each case supplies the complete
available source-before/source-current/derivative text, declared generation
scope (or an explicit absence), all configured sources, and an observation day.
Golds and authored reasons are excluded from provider state. Missing history,
unknown scope and unresolved references remain explicit. The author knows all
cases; held-out prevents threshold fitting, rather than making fixture authorship
blind. These short documents do not establish long-document performance.

`label-review.json` records a Claude-family reading independent of the GPT-family
author. It uses the same Sonnet model as the comparison arm, so shared model
blind spots remain possible. The one required clarification was applied before scored calls;
the original disputed verdict and the author's resolution remain visible.

Each arm gets three repetitions:

- **Candidate:** one `jev-1.13.0` Choice through the shipped core client, with
  complete case state and the fixed rubric in `run.ts`. Unexpected response
  model identity, timeout, missing key or malformed response forwards as an
  invalid/uncertain fallback. No replacement provider is configured.
- **Current review judgment:** `claude-sonnet-5-5` through subscription-authenticated
  Claude Code, with the unchanged shipped audit skill and the same complete case
  state/rubric. Only the propagation review/propose step runs; tools are disabled.
  This measures a structured semantic recommendation using the shipped skill,
  **not** a full agent sweep or an existing auto-dismiss feature. Detection,
  provenance retrieval, document collection and editing are supplied or excluded
  equally. Both Anthropic API credential variables are removed from each child.
- **Deterministic:** every detected propagation finding goes to the owner. It
  makes no semantic assertion, represented by `uncertain` plus fallback. Its
  three-class accuracy is intentionally not the main comparison; its forwarding
  recall and zero acknowledgements represent the shipped behavior.

The candidate's floor grid is `0, .4, .6, .8, .9, .99, 1.01` (the last disables
all acknowledgements). On tuning only, selection minimizes false acknowledgements,
then maximizes correct still-current acknowledgements, then three-class correctness,
then chooses the lowest tied floor. The floor is saved before the first held-out
request. No prompt, model, floor or labels are tuned on held-out answers.
Both measured floors are zero, which filters no choices. It is not an observed
confidence safeguard. One Sonnet diff-tuning response was invalid and is counted
as a fallback; all held-out responses were valid. CLI usage names include Haiku
on 199/216 invocations in addition to the requested Sonnet; they do not provide
per-label model attribution.

## What counts

Only an accepted `still_current` proposes avoiding owner review. All other labels,
invalid answers and below-floor still-current answers forward the finding. False
acknowledgements include **both** `needs_update` and `uncertain` golds and veto
unattended adoption; minority repetitions count, with no majority vote hiding them.
Precision, coverage of true still-current cases, forwarding recall, three-class
correctness, invalids, fallbacks and agreement are recomputed from saved raw rows.
Agreement requires three distinct repetitions with identical label, validity and
fallback state. Repetitions are not independent authored examples.

The offline mechanics separately apply the shipped surgical frontmatter editor
to real disposable files, rebuild their disposable index and run the shipped
audit before/after. They try **all** cases, including deliberately stale ones,
to demonstrate the warning-clearance limitation. They check that only the
derivative's `updated` changes, preserving its body, other bytes and other
frontmatter fields. They keep remaining non-propagation findings in the results.
Changed fields are derived from actual readback, and the offline gate requires
exactly the derivative path and its `updated` field to change. The byte grammar
uses unquoted dates; the authored corpus uses LF and does not establish coverage
of other quoting/newline styles. `--offline` reruns these inexpensive checks
rather than reusing them.
This is not a claim that a date-only edit is semantically correct or authorized.

The spend guard uses CLI-reported subscription list-price usage and conservative
Jev input-byte reservations (two possible HTTP attempts). Unknown CLI usage costs
the full per-call cap for guard purposes. This is a bounded-run safeguard, not an
invoice, a cost comparison, or accounting for T3 review subscription usage.

## Verification

Six offline tests cover nontrivial scoring/calibration, repetition accounting,
real index/audit behavior, source-byte preservation, source-diff correctness and
unavailable history. The guard mutation changed
false-acknowledgement counting to exclude `uncertain` golds: the named
`an acknowledgement on unknown is a veto` test failed on the expected assertion
(expected one false acknowledgement, received zero). Restoring the predicate
passed the initial five tests. The additional diff test also passes. The
independent label review found no false-safe golds.
