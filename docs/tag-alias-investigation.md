# Tag alias investigation (#844)

A spike harness for one question: does a Jev same-concept judgment over
code-generated candidate tag pairs find true aliases that lexical variant
detection misses, without merging related, hierarchical or homonymous tags?
It changes no production detector, vocabulary or tag writer, and nothing in
it has been run against a paid model yet. Everything below is keyless.

## Arms

| Arm | What it is | Status |
| --- | --- | --- |
| lexical | `findVariantGroups` treated as an alias proposal. This is what ships today. | Measured keyless (`scripts/evals/tag-aliases/keyless.ts`). |
| current | The installed `audit` skill's tag-noise judgment, run by the real core Claude runner in report-only mode (`native.ts`, `current.ts`). | Transport proven offline against a scripted upstream; never run live. |
| hybrid | Code-owned candidates (`candidates` in `prototype.ts`) judged by the core Jev Choice client (`jev.ts`), admitted by `proposal` only above a threshold frozen on the tuning split. | Client proven against injected transport; never run live. |

All three start from the same disposable keyless index. A proposal is
report-only in every arm; `applyReviewed` writes only after an explicit review
that binds every current usage file and the full config snapshot, then calls
the shipped conditional writer. Chains, cycles, conflicting aliases, replay and
concurrent edits keep the writer's existing behaviour (`tests/tag-alias-experiment.test.ts`).

## Corpus

`fixtures.ts` holds 23 author-provisional Odysseus pairs: ten Ogygia tuning
cases (4 same, 5 different, 1 unknown) and thirteen Ithaca/Pylos/Sparta
held-out cases (5 same, 7 different, 1 unknown). Both splits contain spelling,
synonym, acronym, hierarchy, related, homonym and sparse cases; held-out adds
an acronym collision, negation, a quoted injection and one synonym whose two
contexts share no vocabulary (the known candidate miss). No positive pair has
byte-identical contexts, so a judge cannot recover the label by comparing the
two bodies for equality; a test enforces that.

Known limitations: every body is a single sentence, every case is its own
two-document brain, and the splits share one authored grammar. Candidate-stage
behaviour on these fixtures therefore does not predict behaviour on real
documents, and the labels still need the cross-family review the epic
requires before a paid run. Record that review as the reviewer model, verdict
and the SHA-256 of `fixtures.ts` on the issue.

## Keyless results

From `bun scripts/evals/tag-aliases/keyless.ts` at this revision:

| Split | Positives | Candidate recall | Lexical recall | Lexical false merges |
| --- | --- | --- | --- | --- |
| tuning | 4 | 4/4 | 1/4 | 1 (`rowing`/`roving`) |
| held-out | 5 | 4/5 (misses `night-watch`/`guard-shift`) | 1/5 | 1 (`hosting`/`hoisting`) |

Lexical detection finds only the spelling variants and treats near-spellings
of unrelated words as aliases; that is the baseline the hybrid has to beat.

Candidate volume on the real example corpus (`packages/core/fixtures/corpus`,
45 tags, 24 documents, 990 possible pairs): the any-shared-word rule admits
959 pairs, so the 128-pair cap, not the rule, bounds the work. Co-occurrence
alone admits 74 pairs; a Jaccard overlap of at least 0.15 admits 129. At the
cap, one full run is 128 pairs x 2 orientations x 3 repetitions = 768 Jev
calls for a 45-tag brain. The candidate rule is the open design problem the
issue calls "minimal candidate/context strategy"; the report records the
per-rule breakdown and the lowest admitted overlap so a stricter rule can be
compared against the same fixtures.

The earlier "hybrid" column in this report was scripted from the gold labels
and has been removed: it restated candidate recall as model recall.

## Metrics and gates

`metrics.ts` aggregates per case. Repetitions of one pair vote; a pair whose
repetitions disagree is listed as unstable rather than counted three times.
Candidate misses stay in the denominator. `calibrate` scans
.7/.8/.9/.95/1 on tuning only and returns the lowest threshold with at least
one true proposal and no false one; a missing threshold admits nothing.

`gates` in `protocol.ts` records the proposed go/no-go before any live run: zero
held-out false merges, hybrid recall at least two cases above lexical, no
unstable proposal, one cited document per tag, and a cost ceiling the
maintainer sets. The gates are not moved after measuring.

## Live run (not yet performed)

The 2026-10-10 cross-family review and its outcome are recorded in
[the decision record](decisions/tag-alias-discovery.md); the model arms
were not run.

`native.ts` and `jev.ts` retain literal request and response bytes, usage,
model identity, EOF and child closure for every physical call; `relay.ts` is
the loopback tee for the native arm; `freeze.ts` binds source, runtime and
fixture identity. `review-packet.ts` and `review-evidence.ts` implement the
cross-family review admission. Live dispatch refuses until the native
auxiliary transport/accounting and original effect qualifications are verified
and `BRAIN_TAG_ALIAS_DISPATCH` is set explicitly. The core permission baseline
is the settled explicit default under #1301; no evaluation-specific override
is introduced.

Reproduce the keyless native transport controls in a networkless namespace:

```sh
python3 scripts/evals/tag-aliases/launch.py read /tmp/tag-alias-controls/read.json
python3 scripts/evals/tag-aliases/launch.py proposal /tmp/tag-alias-controls/proposal.json
python3 scripts/evals/tag-aliases/launch.py write-denial /tmp/tag-alias-controls/write-denial.json
python3 scripts/evals/tag-aliases/launch.py review /tmp/tag-alias-controls/review.json
```

These prove the transport and the report-only tool policy; they prove nothing
about model quality.


The private paid entry under #1298 requires the existing #844 root allocation,
a protected source/input/protocol/runtime/proof/prompt policy and a consumed
one-use grant before USER release. The exact unchanged fixture instruction
block is bound separately. Each physical attempt reserves the full supported
million-token context plus its exact output maximum before forwarding; wire
size is only a transport bound. The serialized root window, current source and
original grant are rechecked, and missing or contradictory usage/pricing,
in-flight requests and incomplete streams stop admission with unknown holds.
Explicit paid overage requires consistent native quota evidence. Native and
physical literal bytes, all observed pricing fields, natural EOF, reader close
and actual owned child drain support review admission; offline provenance
cannot acquire semantic approval by relabelling. Actual invoices remain
unknown without separate evidence. This preparation supplies no new allocation,
paid result, gate ratification, alias authority or adoption decision.
