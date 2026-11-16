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

Seventeen keyless tests cover the request schema, the signals, `decide`, the
judge boundary, the live judge's wire shape, model pin and spend cap, the
labelled set's integrity, the recorded offline table and a replay of the
recorded live answers.
They live in the experiment tier because every assertion is about this
harness. Mutation receipts are recorded in the pull request.
