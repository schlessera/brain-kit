# Bundled model prices

`model-prices.json` supplies offline estimates before any remote catalog has
been cached. Rates are USD per token. `fetchedAt: 0` and source
`fetchedAt: null` mean no remote fetch occurred; they are not check dates.

## Claude rates checked 2026-10-11

Source: [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing),
with model lifecycle checked against
[deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations).
The following values are USD per **million** tokens; divide by 1,000,000 for
the stored values. Cache writes use the five-minute duration.

| Model | Input | Output | Cache read | Cache write |
| --- | ---: | ---: | ---: | ---: |
| `claude-fable-5-1` | 10 | 50 | 0.25 | 12.50 |
| `claude-opus-5-5` | 4 | 20 | 0.20 | 5 |
| `claude-sonnet-5-5` | 2 | 10 | 0.10 | 2.50 |
| `claude-haiku-5-5` | 0.10 | 0.50 | 0.01 | 0.125 |
| `claude-sonnet-4-6` | 3 | 15 | 0.30 | 3.75 |
| `claude-opus-4-6` | 5 | 25 | 0.50 | 6.25 |
| `claude-sonnet-4-5` | 3 | 15 | 0.30 | 3.75 |
| `claude-haiku-4-5` | 1 | 5 | 0.10 | 1.25 |

These are base rates, following the
[cost-tracking decision](../../../docs/decisions/cost-tracking.md#scope-boundaries).
Haiku 5.5 uses these prices for prompts up to 100,000 tokens. Longer prompts
cost $0.50 input, $2.50 output, $0.05 cache read and $0.625 cache write per
million tokens. The service has one rate per model and cannot select that
tier; long-context and one-hour cache tiers remain outside v1. Snapshot
resolutions always carry `source: "snapshot"` and `estimate: true`.

Other providers' entries are retained from the previous snapshot; the Claude
check date does not attest to those rates.

## Refreshing

Before a release, compare the bundled Claude coverage and rates with the
provider's pricing and lifecycle pages. Retain older entries for historical
model IDs. Transcribe base input/output, cache-read and five-minute cache-write
rates, including model-specific cache multipliers, into per-token USD. Update
the dated table above and the independent offline expectations in
`../tests/model-pricing.test.ts`; keep the snapshot's remote-fetch timestamps
unset. Run `bun run test packages/ui-server/tests/model-pricing.test.ts` from
the repository root. This check reads public documentation and makes no paid
inference call.
