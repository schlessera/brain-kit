# Decision — Jev-assisted tag alias discovery is not built in its current shape

The [#844](https://github.com/schlessera/brain-kit/issues/844) spike does not
support building Jev-assisted tag alias discovery as specified. Two results
point the same way, and neither one needs a model arm.

- **The candidate stage already meets a no-go gate.** One of the no-go
  conditions in `protocol.ts` is a candidate volume that needs more Jev calls
  than the corpus has documents, without a candidate rule that keeps every
  held-out positive retrievable. Both halves hold. On the example corpus, one
  run needs 768 Jev calls for 24 documents, and the rule still misses one
  held-out synonym.
- **The cross-family review approved none of the protocol's seven packets.**
  Five of the seven independently report the same blocker: the comparison
  promises both pair orientations, but no code implements them.

The live lexical/current/hybrid comparison was not run. The harness has no
live entry point for either model arm, so there is no measured model quality
or cost for them. This record changes no production behaviour.

Measured on 2026-10-10 on main `9adc62e7`. The freeze is
`d5e1cd558203899686a381d1ecbea39f23e030a981e57374498f18bb6f331e37` (fixture
`59fc2f13…`, protocol `e5a20fee…`, Bun 1.4.2, SDK 0.3.293, native 2.1.293).
Bindings, grants and receipts are in
[`results/2026-10-10/admission.json`](../../scripts/evals/tag-aliases/results/2026-10-10/admission.json).

## Results against the pre-registered gates

The gates in `protocol.ts` were proposed before any live run, and the
maintainer has not ratified them. They were not changed after measuring.

| gate | result |
| --- | --- |
| no-go: held-out false merge | Lexical baseline has one (`sparta-lexical-trap`). Hybrid not measured. |
| no-go: hybrid recall not above lexical | Not measured. Lexical held-out recall is 1/5. |
| no-go: candidate volume over document count without a rule keeping every held-out positive | **Met.** 128 capped pairs × 2 orientations × 3 repetitions = 768 calls for 24 documents (959 of 990 pairs admitted before the cap). Held-out candidate recall is 4/5 (`ithaca-disjoint-context` missed). |
| go conditions | Not evaluable without the model arms. |
| cost ceiling | Not set by the maintainer. |

[Keyless results](../../scripts/evals/tag-aliases/results/2026-10-10/keyless.json)
(lexical arm and candidate stage):

| split | positives | candidate recall | lexical recall | lexical false merges |
| --- | --- | --- | --- | --- |
| tuning | 4 | 4/4 | 1/4 | 1 (`ogygia-lexical-trap`) |
| held-out | 5 | 4/5 | 1/5 | 1 (`sparta-lexical-trap`) |

## Cross-family review

The cases and code are GPT-authored, so the protocol requires a Claude
review. Every source and case packet must return `APPROVED` before any
scoring. The review ran claude-sonnet-5-5 through the actual paid-admission
path: one Root-issued policy and one consumed one-use grant per packet, a
full-context reservation, and literal capture of every physical request.
All seven packets returned `NOT_APPROVED`. The texts are in
[`results/2026-10-10/review/`](../../scripts/evals/tag-aliases/results/2026-10-10/review/).

Several blockers came back from more than one packet independently:

- **No orientation code.** "Both orientations" is required but not
  implemented (5 of 7). The Jev request uses the stored pair order
  (`question`, `scripts/evals/tag-aliases/prototype.ts:78-83`).
- **Metrics do not match the gates** (5 of 7). `metrics` counts a false merge
  by majority vote across repetitions, but the go gate vetoes on any one
  repetition. Failed cases also leave the recall denominator
  (`perCase`, `scripts/evals/tag-aliases/metrics.ts:10-20`).
- **Some cases never reach the judge** (3 of 7). Several hard negatives and
  sparse unknowns share no content word and never become candidates, so the
  judge is never tested on them.
- **Held-out leakage.** The candidate stoplist contains held-out-only names
  and verbs.

Partitioning also biases the review toward refusal. Each packet holds only
part of the core sources, and the prompt says every packet at the freeze must
approve. Each reviewer therefore declined to approve sources it could not
see, even when it found no blocker in what it could see. A future review
should ask for a verdict scoped to each packet's contents.

## What the admission path showed

This was the first live use of the #1451 paid-admission tooling. With every
guard unmodified, it worked end to end for the review:

- policy, ledger and intent validation;
- grant consumption, and USER release only with the frozen prompt and the
  exact fixture-instruction block;
- full-context reservation and settlement from the literal SSE usage;
- quota evidence (overage inactive throughout);
- evidence bundling.

Forcing only the leading-`APPROVED` check true makes `validateReviewEvidence`
accept all seven bundles. The verdicts alone refused admission.

Two environment findings came out of the run:

- **A stray `/tmp/.git` broke the first attempt.** An empty `/tmp/.git`
  directory on the host made Claude Code treat the `/tmp` fixture as a git
  repository and add a `gitStatus` context block. The reservation then
  refused it before forwarding ("Unreviewed native USER payload"). Nothing was
  dispatched, but the grant was spent. Running the review under a private
  `/tmp` (bwrap) fixed it. Fixtures hard-code `/tmp`, so any host-level `/tmp`
  state changes the native user payload.
- **The results directory broke the packet builder.** `review-packet.ts` read
  every entry of the instrument directory as a file, so the
  `results/` directory raised `EISDIR`. It now reads regular files only.

The comparison could not be run because neither model arm has a live entry
point:

- **Current arm.** Live scoring still hard-refuses
  (`runNative`, `scripts/evals/tag-aliases/native.ts:41-46`), although #1275
  is closed.
- **Hybrid arm.** `observedClient` points the Jev client at a loopback
  sentinel only (`observedClient`, `scripts/evals/tag-aliases/jev.ts:17-20`),
  and nothing implements calibration or the comparison loop.

Spend: seven physical requests, all on included subscription usage, so the
actual additional charge is $0. The list-price equivalent is $5.22, and no
invoice was observed. The root debit rule and every reservation are recorded
in `admission.json`.

## What would reopen this

- A candidate rule that keeps every held-out positive while needing fewer Jev
  calls than the corpus has documents. Without it, the no-go stands whatever
  the judge's quality.
- An orientation-aware comparison loop, metrics that implement the gates as
  written, and a review scoped per packet. Each needs a fresh freeze and a
  fresh review.
- A ruling on whether the current-arm refusal can lift now that #1275 is
  closed.

## Limits

- Twenty-three author-provisional cases, each in a two-document brain. The
  review questions several labels (`guest-care`/`hospitality`,
  `ithaca-disjoint-context`).
- The gates are proposed, not ratified.
- One review model and one run per packet. The verdicts are consistent across
  packets but are not repeated measurements.
