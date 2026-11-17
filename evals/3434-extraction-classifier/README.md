# Extraction classifier spike (#3434)

Measures whether a host-side classifier can tell a likely data-extraction call
from an ordinary read in a tainted session, well enough to choose between
allow, ask and block. Nothing here changes production admission. The design,
the measured tables and the recommendation are in
[the plan](../../docs/plans/extraction-classifier.md).

```sh
bun run test experiments/3434-extraction-classifier.test.ts
bun evals/3434-extraction-classifier/run.ts --offline [--out <file>]
# Live Jev for the ambiguous band only. Needs TYPESAFE_API_KEY; outside CI; cap per the issue.
bun evals/3434-extraction-classifier/run.ts --run --max-usd 10 --reps 3
# Recompute a recorded live run without any provider call.
bun evals/3434-extraction-classifier/run.ts --summary --results evals/3434-extraction-classifier/results-<date>.json
# #4090: the band requalification set, through the production classifier and judge.
bun run test packages/ui-server/tests/extraction-band-requalification.test.ts experiments/4090-extraction-band.test.ts
bun evals/3434-extraction-classifier/requalify.ts --offline [--out <file>]
bun evals/3434-extraction-classifier/requalify.ts --run --max-usd 10 --reps 3 --out <file>   # TYPESAFE_API_KEY, outside CI
bun evals/3434-extraction-classifier/requalify.ts --summary --results <file>
```

## Files

- `schema.ts` — the authored case shape and `OutgoingRequest`, the request the
  classifier scores.
- `request.ts` — builds that request from what admission already holds: the
  WebFetch URL, the full Bash command, MCP arguments, the relay body.
- `signals.ts` — the deterministic signals, each scored alone.
- `classify.ts` — the configurations, the ambiguous band handed to a judge,
  and `decide`, which combines a band with the host's own policy decision.
- `score.ts` — metrics per effective band, leaks, benign cards, the per-signal
  table and the calibration grids.
- `cases.json` — the labelled set: seven Odysseus sessions, 86 calls, over the
  keyless fixture corpus `packages/core/fixtures/corpus`.
- `run.ts` — calibration, the deterministic judge stub, the live Jev judge
  with its spend ledger, and the offline/live/summary modes.
- `results-offline-2026-11-15.json` — the offline run: every configuration's
  rows, the per-signal table and heuristic latency. Its `heuristics+stub`
  rows exercise the judge plumbing with a keyless stub and are not a Jev
  measurement.
- `results-2026-11-16.json` — the live run: `jev-1.13.0` on the ambiguous band,
  three repetitions, with the typed answers, the answering model, input tokens,
  spend and latency. `--summary --results` recomputes its tables offline.
- `cases-4090.json` — the [#4090](https://github.com/schlessera/brain-kit/issues/4090)
  requalification set: six more Odysseus sessions, 49 calls, whose 30
  extraction calls all score inside the production ambiguous band.
- `requalify.ts` — replays that set through the production classifier and
  judge (`packages/ui-server/src/governance/`) at the shipped thresholds and
  floor, with the keyless stub, a capped live mode and a recorded-run replay.
  It calibrates nothing.
- `results-4090-offline-2026-11-17.json` — the keyless stub run of that set.
  It exercises the report and is not a Jev measurement.
- `results-4090-2026-11-17.json` — the live run of that set: `jev-1.13.0` on
  its 43 band calls, three repetitions, with the typed answers, the answering
  model, input tokens, spend and latency, and no request state.
  `requalify.ts --summary --results` recomputes its report offline. The
  measured tables are in [the plan](../../docs/plans/extraction-classifier.md#requalifying-the-band-4090).

## The requalification set (#4090)

The #3434 held-out sessions put no extraction call in the ambiguous band, so
the live leg measured only Jev's benign answers there. `cases-4090.json` is a
separate file rather than an extension of `cases.json`: adding its sessions to
`cases.json` would move the #3434 calibration and every recorded table, which
the labelled test pins call by call.

Three tuning and three held-out sessions, each with its own taint source and
no taint host shared between the splits. Every extraction call carries no
copied shingle and scores 0.25 on the taint-host signal alone, which is the
band's commonest benign shape: injected beacons, paraphrased and word-shuffled
leaks, requests that address the judge, and near-duplicates of a benign
taint-link follow-up with one private value appended. Benign follow-ups of the
same shape sit in the band beside them. The set is weighted towards
extraction (15 of 21 band calls in tuning, 15 of 22 in held-out), so its band
precision says nothing about a working session's mix; the #3434 realistic
sessions remain the measure of benign cost.

## The labelled set

Each session names what tainted it (its display name and the hosts the
tainting content named, never the content), the brain files it read, and the
hosts it had contacted before the taint. Its calls run in order, so fan-out,
trickles and the growing contacted set behave as they would in a session.
Four sessions (40 calls) are tuning and three (46 calls) are held out; one
session in each split is a realistic benign working session. Encoded cases
hold the exact base64, base64url, hex or ROT13 of the quoted corpus text.

Every call carries a class (`benign` or `extraction`), a gold band (what a
careful reviewer who saw the request and the session's reads would choose:
benign calls `allow`; extraction `ask`, or `block` when the call plainly
sends brain content out), a family, and for adversarial cases the heuristic
it was written to evade. The fixture author knows every case; held-out
prevents threshold fitting, not authorship bias.

## Simulation rules

- The host's own decision per call follows the shipped rules: a validated
  provider relay or a local call is admitted; an outward action asks; a proxied
  connection to a host the session has not contacted raises the #3430
  tainted-destination card; a contacted host is admitted.
- An admitted call adds its hosts to the contacted set. An asked benign call is
  assumed approved, an asked extraction call declined. That assumption is
  optimistic about the user: a rubber-stamped card would leak too.
- Every attempted call joins its site's stream, refused or not, so a trickle is
  scored as one stream. A site is the last two host labels; the spike uses no
  public-suffix list.

## Calibration

The heuristic allow threshold is chosen on tuning sessions only, from
`ALLOW_GRID`, minimizing leaks, then benign refusals, then benign cards, and
keeping the lowest threshold of a tie. The judge configuration then chooses
its ask threshold and confidence floor on tuning only, from `ASK_GRID` and
`FLOOR_GRID`, using repetition 0. The signal weights in `classify.ts` are
hand-set. The signal definitions were revised once after the first offline
pass, for three harness defects: a trickle's earlier matches were counted
again on every later call to the site, URL path segments joined by `/` were
read as base64, and fan-out fired on ordinary repeat use of one site. No case
changed.

## Verification

For #4090, `packages/ui-server/tests/extraction-band-requalification.test.ts`
proves through the production classifier that each split puts at least ten
extraction calls, from every family, in the band, and
`experiments/4090-extraction-band.test.ts` covers the requalification report,
the stub run, the live judge's cap and model record, and the replay of the
recorded live run.

Seventeen keyless tests cover the request schema, the signals, `decide`, the
judge boundary, the live judge's wire shape, model pin and spend cap, the
labelled set's integrity, the recorded offline table and a replay of the
recorded live answers.
They live in the experiment tier because every assertion is about this
harness. Mutation receipts are recorded in the pull request.
