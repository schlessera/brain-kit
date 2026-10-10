# Decision — audit repair suggestions come from real capabilities, not a model

The [#841](https://github.com/schlessera/brain-kit/issues/841) comparison
supports building `audit --fix` suggestions from the repair capabilities that
actually exist. Today, only the registry handler for `index-stale` exists. The
current completion prompt is worse than sending no prompt at all: on held-out
cases it gave correct guidance for 24 of 40 findings, the audit's own
providerless text for 34, and the capability-backed registry arm for 37. The
prompt never identified a repairable finding. It costs money and about 3 s per
call, and it adds nothing the deterministic paths do not already give.

This record changes no production behaviour. [#1408](https://github.com/schlessera/brain-kit/issues/1408)
owns the product change to `audit --fix`.

Measured on 2026-10-10 (UTC detection day) at main
`bae10edcf450a4b440cba3fdd2316d4724a75f90`, freeze
`931f75b3b90c2ec11744d085bd4882e97acbe799fa154f5ebabfcd80856b9711`.

## What was compared

Twenty-six authored cases (`scripts/evals/audit-capabilities/benchmark.json`):
six tuning and twenty held-out, two repetitions each, through the actual audit
command boundary.

| arm | what runs |
| --- | --- |
| `actual-current-message-only` | Today's `brain audit --fix` with a completion provider: `claude-sonnet-5-5`, Standard tier, 2,000-token limit, the shipped prompt unchanged. |
| `actual-providerless` | Today's `brain audit --fix` with no provider: the audit's own suggestion text, marked manual. |
| `capability-backed-registry` | The prototype: a suggestion per finding from the actual registry plan, type membership, validation and safe-path checks. It writes only when the case authorizes it. |

The same day's [keyless proof](../../scripts/evals/audit-capabilities/results/2026-10-10/keyless-proof.json)
passed every check on all 26 cases, and each case's detection matched it before
its arms ran.

gpt-6.1-sol, a different model family from the arm under test, annotated every
one of the 168 suggestions against the category rubric in
`scripts/evals/audit-capabilities/protocol.ts`, reading the complete fixture
sources. The judge was arm-blind: suggestions arrived under opaque keys in
three shuffled batches. On the 56 pairs where both repetitions produced
identical suggestions, it gave the same verdict 55 times.
[`analyze.ts`](../../scripts/evals/audit-capabilities/analyze.ts) scores the
[observations](../../scripts/evals/audit-capabilities/results/2026-10-10/observations.json)
from those [annotations](../../scripts/evals/audit-capabilities/results/2026-10-10/annotations.json).

## Results

[Analysis](../../scripts/evals/audit-capabilities/results/2026-10-10/analysis.json),
held-out split (20 cases × 2 repetitions, 40 findings):

| arm | correct guidance | repairable claimed | false auto-fix | writes | cost | p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- |
| current prompt | 24 / 40 (60%) | 0 / 12 | 0 | 0 | $0.146 | 2,870 / 4,888 ms |
| providerless | 34 / 40 (85%) | 0 / 12 | 0 | 0 | $0 | 28 / 72 ms |
| capability-backed | **37 / 40 (92.5%)** | **12 / 12** | **0** | 10 | $0 | 41 / 98 ms |

The tuning split (6 cases × 2, 16 findings) points the same way: 14, 14 and
16 of 16. Every capability-backed preview and authorized write matched its
authored full-file effect. The one held-out case without write authorization,
`nestor-preview-only`, was correctly left unwritten in both repetitions.

The current prompt never set `canAutoFix` and never returned a replacement
`fix`, so it made no false repair claim. Its failures are guidance errors:
- treating a quoted example marker as open work;
- advising removal of an unverified claim that records unfinished work;
- recommending that content be copied from a path outside the brain;
- ignoring a configured tag alias;
- describing a missing record as a missing line.

The model sees only the finding list, never the files
(`suggestFixes`, `packages/core/src/cli/commands/audit.ts:26-68`), so it cannot
know any of these things.

The capability-backed arm's three held-out misses are judge calls, not errors
in what it did:
- `nestor-preview-only` (both repetitions) reports `canAutoFix: true` with
  `executionAuthorized: false` and correctly does not write. The judge read the
  flag as a repair claim against a preview-only owner.
- `penelope-scalar-tags` (one of two repetitions) gives the generic tag-noise
  advice, and the judge split on it across the repetitions.

Spend: 52 paid calls, $0.195 at list price
(`results/2026-10-10/billing.json`), no unknown-usage attempt and no invoice
observed. The conservative per-call debit the spend guard settles is $0.445.

## What #1408 should take from this

- Stop asking a completion provider for `--fix` suggestions it cannot ground.
  The providerless text is already better, faster and free.
- Report repairability from the registered capability, not from a model flag.
  Keep `canAutoFix` (can be repaired) separate from execution authorization,
  as the prototype does. That distinction is exactly what the judge contested
  on `nestor-preview-only`, so name it plainly in the output.
- Extend coverage one capability at a time. Each new handler needs its own
  authored cases under this rubric.

## Limits

- Twenty-six authored cases. The decision rests on a large gap (60% against
  85–92.5%) and on the absence of any repairable-finding recognition, not on
  precise rates.
- One judge model. Its consistency across identical repetitions was 55 of 56,
  and its strictest calls are named above.
- The run used `measure.ts`. It reuses `live.ts`'s arms, provider wrapper and
  spend guard, but skips the native review and paid-policy admission that
  `live.ts main()` requires. It enforces the same-day keyless proof instead.
- A completion prompt that receives the full sources is a different arm, and it
  was not measured.
