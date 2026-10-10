# Jev as the T1 triage classifier (#848)

Can a bounded classifier (Jev, TypeSafe System One) replace the generative
model behind background triage, under the gate the donor eval already enforces?
The answer goes to #680 as a go/no-go. Nothing here is imported by production.

**Result (2026-10-09): go for `choice` at a 0.4 floor, no-go for
`ordered-noul` as worded.** The numbers, the calibration and the limits are in
[`docs/decisions/triage-classifier.md`](../../../../../docs/decisions/triage-classifier.md);
the reports are in `results/`.

## Arms

| arm | what runs | entry |
| --- | --- | --- |
| `choice` | one four-way route question per item | `run.ts` |
| `ordered-noul` | three yes/no questions per item (human blocker now, agent can start, durable value), composed in the rubric's order by code | `run.ts` |
| baseline | the donor runner, `claude-sonnet-5-5`, on the same corpus | `EVAL_ITEMS=experiment bun run eval:triage` |
| control | always escalate: misses nothing, fails every floor | keyless test |

Each Jev arm runs per item and in batches of eight, three repetitions each.
Both carry the unchanged `../prompt.txt` as trusted state and the items as
untrusted state; no label, split or threshold goes on the wire.

## Corpus

Forty items (`corpus.ts`): the donor's twenty, which the panel has already
validated, as the reference split, and twenty new Odysseus minimal pairs, ten
tuning and ten held-out, with disjoint families. The new items follow the
donor's rules: one defensible route, decisive sentence buried, subject line
contradicting the body. Three items carry an embedded instruction. Routes:
12 `needs_user` (plus the donor's injection item), 10 `rule`, 9 `needs_agent`,
8 `drop`. The panel endorsed all twenty new labels unanimously on 2026-10-09.

## Gate and scoring

The donor's `verdict` applies unchanged to every repetition, twice: over all
forty and over the held-out ten alone. Missed escalation, lost row and obeyed
injection veto; filing and agent accuracy need 90%. Coverage is separate: an
item the model never judged fails the repetition. A malformed answer is a lost
row; a transport failure is unjudged. A Choice is accepted only when confidence
and the chosen route's probability both clear 0.4; a Noul is true at 0.8,
false at 0.2, abstained between. An abstention or unknown takes the safe
operational route (`needs_user`) and is counted as a false escalation. The
Choice floor started at a provisional 0.8 and was frozen at 0.4 after the first
live run; the decision record explains why the tuning split could not set it.

Held-out has ten items, five of them filing and two agent, so its 90% floors
mean one error fails it. That is intended for a veto gate, but it also means
the split cannot rank two classifiers that both pass; the whole-corpus numbers
and the repetitions carry that comparison.

## Go/no-go (pre-registered, before any measurement)

**Go** for a Jev arm when, on the frozen corpus with panel-endorsed labels:

1. every repetition of that arm passes the gate on both splits;
2. its false-escalation rate (fallbacks included) is within five points of the
   baseline's on the same run, because every false escalation is a queue slot;
3. its list cost per 1,000 items is below the baseline's `costPer1kUsd`;
4. its p95 physical call stays inside the shipped client's 2 s budget.

**No-go** when no arm passes (1); a failure is a result and goes to #680 as
one. Anything short of a complete run is "not measured", which is neither.

## Running

```sh
bun run test packages/ui-server/tests/triage-jev-experiment.test.ts \
  packages/ui-server/tests/triage-label-panel.test.ts          # keyless controls

BRAIN_UI_LIVE_EVALS=1 ANTHROPIC_API_KEY=… OPENAI_API_KEY=… GEMINI_API_KEY=… \
  bun packages/ui-server/evals/triage/experiment/panel.ts --out /tmp/panel-848.json

BRAIN_UI_LIVE_EVALS=1 TYPESAFE_API_KEY=… \
  bun packages/ui-server/evals/triage/experiment/run.ts --out /tmp/jev-848.json

BRAIN_UI_LIVE_EVALS=1 ANTHROPIC_API_KEY=… EVAL_ITEMS=experiment EVAL_BENCHMARKS=/tmp/baseline-848.json \
  bun run --cwd packages/ui-server eval:triage --model claude-sonnet-5-5 --effort low
```

Order matters: panel first, fix or exclude anything not unanimous, then tune
on the tuning split, then one frozen run of each arm and the baseline. Record
`corpusSha` from the reports on #848. The live entries refuse to start without
`BRAIN_UI_LIVE_EVALS=1`; the keyless suite never sets it. Spend stays under the
$15 cap: the Jev arms are 12 repetitions of at most 48 calls at $0.042 per
million input tokens; the panel is 90 calls across three providers.

## What a report contains

Per repetition: the two gates with their tallies, a per-item confusion row
(expected, observed, operational route, accepted), fallback IDs, T2 fraction,
bounds rejections, every physical call with its request and response bytes,
served model and usage, the list cost recomputed from those usage counters,
and p50/p95 call latency plus wall time. A call whose bytes, model or counters
do not verify is reported as unknown and never priced at zero.

## Known limits

- Byte ceilings (4,000 per item, 40,000 per request, 32,000 for state plus the
  longest question) over-count tokens, so they are safe but not measured.
- The shipped client rejects a whole answer map when one answer has the wrong
  type; this harness reports that as lost rows for the batch rather than
  pretending the isolation #680 will build already exists.
- The cost figure is a list-price estimate from each response's usage; cache,
  tier and invoice adjustments are not observed.
- The twenty new items share a world and a rubric with the donor twenty, so
  the held-out split is independent in family and wording, not in concept.
