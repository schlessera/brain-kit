# Decision — Jev Choice is the T1 triage classifier

The [#848](https://github.com/schlessera/brain-kit/issues/848) comparison
supports Jev (`jev-1.13.0`) asking one four-way route Choice per item as the
bounded T1 classifier for [#680](https://github.com/schlessera/brain-kit/issues/680).
The arm needs an acceptance floor of 0.4 on both its confidence and the chosen
route's probability; below it, an item escalates to `needs_user`. The
decomposed arm, three ordered yes/no Nouls composed by code, is rejected as
worded. A generative classifier is not needed for T1 routing. This record
changes no production default; #680 owns the integration.

Measured on 2026-10-09 against corpus `89209c39506d`.

## What was compared

Forty items (`packages/ui-server/evals/triage/experiment/corpus.ts`). The
reference split is the donor eval's twenty, already validated by a label panel
for the donor. The new items are twenty Odysseus minimal pairs, ten tuning and
ten held-out, with disjoint families. Routes: 13 `needs_user` (one carries an
embedded instruction), 10 `rule`, 9 `needs_agent`, 8 `drop`.

| arm | what runs |
| --- | --- |
| `choice` | One four-way route question per item, per call (batch 1) or eight items per call (batch 8). |
| `ordered-noul` | Three yes/no questions per item: human blocker now, agent can start, durable value. Code composes them in the rubric's order. |
| baseline | The donor runner, `claude-sonnet-5-5` at low effort, batches of five. |

All arms see the unchanged `../prompt.txt` rubric. Every repetition is scored by
the shipped gate (`verdict`, `packages/ui-server/evals/triage/score.ts:128-143`):
zero missed escalations, zero lost rows, zero obeyed injections, and filing and
agent accuracy of at least 90%. The gate applies twice, over all forty items and
over the held-out ten alone. A Jev answer below the floor, or an unknown answer,
takes the safe route `needs_user` and counts as a false escalation if the gold
route was something else.

The three-family [label panel](../../packages/ui-server/evals/triage/experiment/results/2026-10-09-panel.json)
(Sonnet 5.5, gpt-6.1-sol, Gemini 3.8 Flash, three repetitions each) endorses 39
of 40 labels unanimously, including all twenty new ones. Donor item `h1b` is
contested 2–1. The majority keeps its stored label, `needs_user`, and no label
changed.

## Results

[Jev runs](../../packages/ui-server/evals/triage/experiment/results/2026-10-09.json),
three repetitions per configuration:

| arm | floor | gate | missed esc. | false esc. | fallbacks | $/1k items | p95 call |
| --- | --- | --- | --- | --- | --- | --- | --- |
| choice, batch 1 | 0.8 | fail ×3 | 0 | 6 | 12 | 0.062 | 300–357 ms |
| choice, batch 8 | 0.8 | fail ×3 | 0 | 4–6 | 9–11 | 0.018 | 280–344 ms |
| ordered-noul, batch 1 | 0.8 / 0.2 | fail ×3 | 0 | 19–20 | 25–27 | 0.070 | 281–327 ms |
| ordered-noul, batch 8 | 0.8 / 0.2 | fail ×3 | 0 | 18–19 | 23–24 | 0.026 | 295–396 ms |
| **choice, batch 1** | **0.4** | **pass ×3** | **0** | **0** | 2 | **0.062** | 268–321 ms |
| choice, batch 8 | 0.4 | pass ×3 | 0 | 0–1 | 3–4 | 0.018 | 287–294 ms |

[Baseline](../../packages/ui-server/evals/triage/experiment/results/2026-10-09-baseline.json),
four repetitions: recall 95.8%, two missed escalations, no false escalations,
100% filing and agent accuracy, five lost rows, $1.548 per 1,000 items, about
3.2 s per call. **It fails the gate.** Repetitions 1, 3 and 4 pass. In
repetition 2 one batch of five never parsed, and the scorer counts its two
`needs_user` rows as missed escalations, so both hard failures are one lost
batch. The runner does not keep raw responses, so why the batch did not parse
is unknown.

Against the criteria registered before measurement
(`packages/ui-server/evals/triage/experiment/README.md`), Jev Choice at 0.4:

1. passes every repetition on both splits;
2. has a false-escalation rate within five points of the baseline's (0% at
   batch 1, at most 3.7% at batch 8, against 0%);
3. costs less per 1,000 items than the baseline ($0.018–0.062 against $1.548);
4. keeps its p95 call inside the shipped client's 2 s budget.

## Why the floor is 0.4, and how it was chosen

Before any floor applies, Choice answers 38–39 of 40 items correctly in every
repetition. Its only errors are donor items `h1b` and `h3b`, routed to `rule`
or `needs_agent` instead of `needs_user`. Every one of those answers had
confidence 0.36 or lower. The provisional 0.8 floor caught them, but it also
sent 9–12 correct answers to the fallback, and those false escalations failed
the accuracy floors.

The protocol called for calibrating on the tuning split alone. That was not
possible: the tuning split had no wrong answers at any floor from 0 to 0.6, so
it gave no lower bound. The floor was set from the reference split instead:
0.4 is the first value on the 0.1 grid above every observed error. The held-out
split was error-free at every floor up to 0.6, so it did not drive the choice,
but it was visible during calibration. A fresh held-out set, scored blind at
0.4, would make the result stronger. The floor is then frozen in
`protocol.ts`, and a separate run produced the 0.4 rows above.

## Why Noul is rejected

The decomposed arm fails on its questions, not its floors. Its "agent can
start" question scores 0.48–0.79 on plain filing items. Every expected `rule`
item therefore lands between the floors and falls back. Its "human blocker
now" question scores only 0.25–0.46 on several real escalations (`h1b`, `h3b`,
`h9`), so it is safe only because of the fallback. No pair of floors repairs
both problems. A rewritten question set would need its own measurement.

## What #680 should take from this

- **Pin** `jev-1.13.0` and the four-way Choice question with the criteria in
  `experiment/adapter.ts`. A model change requires rerunning `run.ts`.
- **Floor**: accept a Choice only when confidence and the chosen route's
  probability are both at least 0.4. Otherwise, and for any missing, malformed
  or unknown answer, route to `needs_user`.
- **Batching**: one item per call is the cleaner choice. At about $0.06 per
  1,000 items it has no false escalations. Eight per call is cheaper and still
  passes, but adds occasional false escalations.
- **Summaries are separate.** Jev returns a route, not a summary. The
  generative baseline writes a summary for every item in the same call. If
  only items routed past T1 need one, that is 55% of this corpus (22 of 40);
  if every non-dropped item does, 80%. Using the baseline's own per-item cost
  as a rough upper bound, summaries add $0.85–1.24 per 1,000 items. Jev plus
  summaries stays below the baseline's $1.548. That bound is an estimate, not a
  measurement.
- **Budget**: the cost figures are list-price estimates from returned usage.
  They exclude cache, tier and invoice adjustments, which no response reported.

## Limits

- Forty items is small. The decision rests on safety behaviour (no missed
  escalation, hard items falling back) rather than on precise accuracy.
- The twenty new items share a world and a rubric with the donor twenty. The
  held-out split is independent in family and wording, not in concept.
- The paid runs did not pass through the per-request budget admission described
  on #848. Total spend for all #848 runs was under $3 at list prices, against a
  $15 cap.
- The panel report records token counts but no list price.
