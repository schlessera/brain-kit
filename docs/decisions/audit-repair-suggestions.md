# Decision — audit repair suggestions come from real capabilities, not a model

The [#841](https://github.com/schlessera/brain-kit/issues/841) comparison
supports building `audit --fix` suggestions from the repair capabilities that
actually exist. Today that is only the registry handler for `index-stale`.
The current completion prompt is worse than sending no prompt at all. On
held-out cases it gave correct guidance for 28 of 40 findings. The audit's own
providerless text gave correct guidance for 34, and the capability-backed
registry arm for 38. The prompt never identified a repairable finding. It costs
money, takes about 2.7 s per call, and adds nothing the deterministic paths do
not already give.

This record changes no production behaviour. [#1408](https://github.com/schlessera/brain-kit/issues/1408)
owns the product change to `audit --fix`.

Measured on 2026-10-10, the UTC detection day, on main
`7e398dc207f2c4725f6c364331c3cd5d3112954d` plus this branch's `measure.ts` and
its pointer edit to `docs/audit-capability-investigation.md`.
The freeze is `a19c26bd155c89d73a973af17c1e1d3f013535f89c33332905f2c0e5145c6661`
and is recorded in `results/2026-10-10/freeze.json`.

## What was compared

Twenty-six authored cases (`scripts/evals/audit-capabilities/benchmark.json`):
six tuning and twenty held-out, two repetitions each, run through the actual
audit command boundary.

| arm | what runs |
| --- | --- |
| `actual-current-message-only` | Today's `brain audit --fix` with a completion provider: `claude-sonnet-5-5`, Standard tier, 2,000-token limit, the shipped prompt unchanged. The model saw only the finding list ([`suggestFixes` as measured](https://github.com/schlessera/brain-kit/blob/7e398dc207f2c4725f6c364331c3cd5d3112954d/packages/core/src/cli/commands/audit.ts#L26-L68), removed by #1408). |
| `actual-providerless` | Today's `brain audit --fix` with no provider: the audit's own suggestion text, marked manual. |
| `capability-backed-registry` | The prototype: one suggestion per finding, built from the actual registry plan, type membership, validation and safe-path checks. It writes only when the case authorizes it. |

The [keyless proof](../../scripts/evals/audit-capabilities/results/2026-10-10/keyless-proof.json)
taken the same day passed every check on all 26 cases. Each case's detection
matched it before that case's arms ran.

Correctness was judged by gpt-6.1-sol, a different model family from the arm
under test, against the category rubric in
`scripts/evals/audit-capabilities/protocol.ts`, with the complete fixture
sources in front of it. Each of the 112 distinct suggestions (per case and per
input visibility) got one verdict, broadcast to every identical occurrence, so
repeated outputs cannot disagree. Where identical suggestion text on the same
case still got conflicting verdicts across visibility groups, the stricter
verdict applies everywhere. That happened once (`penelope-scalar-tags`, the
providerless and capability arms), and `annotations.json` marks it.

The judge was told what each suggester could see. A suggester that truthfully
says it cannot see a file is not penalized for that, only for wrong guidance.
The judge was also told that repair flags are scored separately:
- `canAutoFix: false` is never a guidance error, because `analyze.ts` counts
  missed repairs itself.
- `canAutoFix: true` is an error only when no repair exists.
- A repair that is marked available but left unexecuted because it is not
  authorized is correct.

The [prompt](../../scripts/evals/audit-capabilities/results/2026-10-10/judge/prompt.md),
inputs, raw reports and member map are kept in `results/2026-10-10/judge/`.
[`analyze.ts`](../../scripts/evals/audit-capabilities/analyze.ts) scores the
[observations](../../scripts/evals/audit-capabilities/results/2026-10-10/observations.json)
from the [annotations](../../scripts/evals/audit-capabilities/results/2026-10-10/annotations.json).

## Results

[Analysis](../../scripts/evals/audit-capabilities/results/2026-10-10/analysis.json)
of the held-out split (20 cases × 2 repetitions, 40 findings). Latency is arm
time after fixture preparation and detection.

| arm | correct guidance | repairable claimed | false auto-fix | writes | cost | arm p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- |
| current prompt | 28 / 40 (70%) | 0 / 12 | 0 | 0 | $0.139 | 2,733 / 4,592 ms |
| providerless | 34 / 40 (85%) | 0 / 12 | 0 | 0 | $0 | 3 / 9 ms |
| capability-backed | **38 / 40 (95%)** | **12 / 12** | **0** | 10 | $0 | 12 / 24 ms |

On the tuning split (6 cases × 2 repetitions, 16 findings), per-finding correct
guidance is 11, 14 and 16 of 16. The current prompt's `unclosed-metadata`
answers cover both findings with each of two suggestions, and duplicate
coverage does not count. Every capability-backed preview and authorized write matched its authored
full-file effect. The one held-out case without write authorization,
`nestor-preview-only`, was correctly left unwritten in both repetitions.

The current prompt never set `canAutoFix` and never returned a replacement
`fix`, so it made no false repair claim. Its errors are guidance the person
would follow wrongly:
- treating a quoted example, or a copied instruction that is explicitly not
  authorization, as work to do;
- allowing a TODO that records unfinished work to be removed;
- advising regeneration before the invalid child metadata the rubric says
  must be corrected first;
- recommending that content be copied from a path outside the brain;
- asserting a cause for a failed module check that the evidence does not show.

The model never sees the files, so it cannot know any of this.

On held-out cases, both deterministic arms give the same generic tag-noise
advice on `penelope-scalar-tags`. The apparent singleton there comes from a
malformed scalar `tags:` value that the advice does not mention. The
providerless text also misses the invalid-metadata prerequisite on
`antinous-unknown-type` and `elpenor-inherited-name`. On tuning, it points at
the wrong frontmatter for an unclosed quote. Those two `penelope-scalar-tags`
findings are the capability arm's only misses.

Spend: 52 paid calls, $0.185 at list price
(`results/2026-10-10/billing.json`). There was no unknown-usage attempt and no
invoice was observed. The spend guard's conservative debit is $0.426 for the
whole run, between $0.004 and $0.017 per call.

An earlier run the same day was discarded. Its harness timed fixture
preparation into arm latency and skipped the per-call freeze re-check, and its
judge applied visibility and the repair flags inconsistently. That run ranked
the arms in the same order.

## What #1408 should take from this

- Stop asking a completion provider for `--fix` suggestions it cannot ground.
  The providerless text is already better, faster and free.
- Report repairability from the registered capability, not from a model flag.
  Keep "can be repaired" (`canAutoFix`) separate from "may run"
  (authorization), as the prototype does.
- Close the guidance gaps both deterministic arms share: request the metadata
  correction before regeneration when validation rejects a child, and point at
  the file that failed validation.
- Extend coverage one capability at a time. Each new handler needs its own
  authored cases under this rubric.

## Limits

- Twenty-six authored cases. The decision rests on a large gap (70% against
  85–95%) and on the prompt never recognizing a repairable finding, not on
  precise rates.
- One judge model, with the rules stated above. Those rules were tightened
  once after a first pass double-counted the repair flags, and one conflict
  was resolved by the consistency rule. The inputs and raw reports of the final
  pass are kept.
- The run used `measure.ts`. It reuses `live.ts`'s arms, provider wrapper,
  spend guard and per-call freeze re-check. It skips the native review and
  paid-policy admission that `live.ts main()` requires, and enforces a
  same-day keyless proof instead.
- A completion prompt that receives the full sources is a different arm. It
  was not measured.
