# Decision — routing-only smart capture

This record documents the [#1593](https://github.com/schlessera/brain-kit/issues/1593)
evaluation under [#838](https://github.com/schlessera/brain-kit/issues/838)'s
lean protocol. It follows [smart-capture.md](smart-capture.md), which rejected
replacing the whole `--smart` path and asked for a fresh test of the narrower
split proposed in [#1588](https://github.com/schlessera/brain-kit/issues/1588):
code plus Jev decides type and append target, and the LLM keeps tagging.

**No-go for adopting the split as frozen.** On fresh held-out cases the
candidate never appended to a wrong record and lost no content. Its routing
still fell below the shipped skill: 72/78 types and 75/78 targets correct,
against 78/78 for both. Every miss went the cautious way: a new inbox note
instead of an append or a more specific type. But the epic's question is
whether the candidate matches the current path, and on routing it does not.
This changes no shipped behavior, and it does not settle any of #1588's
production choices.

The [results file](../../evals/1593-routing-only-capture/results-2026-10-11.json)
holds every Jev judgment, tag reply, write, review and summary. Measured on
2026-10-11 from main `62085604` plus this spike's harness commit.

## What was compared

The [harness](../../evals/1593-routing-only-capture/run.ts) runs three arms on
identical inputs, in separate disposable brains seeded with the same ten
records, three repetitions each:

- **Current:** the shipped `add` skill (`packages/core/skills/add/SKILL.md`) on
  subscription-authenticated `claude-sonnet-5-5`, Claude Code 2.1.295, set up
  as in the #839 harness. It gets the shipped CLI through a filtering shim,
  Bash limited to `brain add`, `brain search`, `brain tags` and help, and a
  sandbox denying reads of the checkout, raw transcripts and other brains.
  Smart capture delegates to this skill today (`if (flags.smart === true)`,
  `packages/core/src/cli/commands/add.ts:25-33`).
- **Candidate:** [route.ts](../../evals/1593-routing-only-capture/route.ts).
  - **Code** handles three cases. An exact append-match title uses the
    shipped rule (`export function classifyContent`,
    `packages/core/src/lib/ingestion.ts:81-117`). A `Capture as <type>.`
    request sets the type, and a `Tags:` line sets the tags.
  - **Jev** `jev-1.13.0` answers two Choices: type, and target among all eight
    append-match records plus `none`. Each Choice has its own floor.
  - **Tags.** A new document without explicit tags gets them from one
    tool-less Sonnet 5.5 call, which is told the decided type.
  - **Writer.** A deterministic writer reads only the `tags` array from that
    reply. It appends only to a shortlisted append-match record that it
    revalidates on disk. Anything else goes through shipped ingestion with an
    explicit type, so it never appends.
- **Baseline:** the shipped title matcher and keyword tagger, otherwise the
  inbox.

Inputs the experiment had to supply:

- **Type meanings.** They come from the fixture's capture policy, as in #839.
  The runtime taxonomy carries none (`export const typeSpecSchema`,
  `packages/core/src/lib/config.ts:50-84`).
- **Candidate boundary.** The target shortlist is every append-match record.
  With eight records there is no retrieval step, so this run does not measure
  retrieval.
- **Tag handoff.** A tool-less tag prompt is an experimental step. It is not
  the skill's own tag selection.
- **Appends.** An append keeps the record's metadata and tags, so the goldens
  for appends are the record's existing tags.

## Cases and labels

The [cases](../../evals/cases/1593-routing-only-capture.json) were written
fresh for this spike: 14 tuning and 27 held-out, with none copied from #839.
They cover exact and case-folded titles and near-title collisions. They also
cover a project update that names its owner contact, semantic updates,
mentions that are not updates, negated targets and types, quoted injections
naming a target or a type, explicit type and tag requests, unknown content,
and exact titles of non-append records.

GPT-6 (`gpt-6.1-sol` through Codex) checked every label once. It accepted 35
and flagged 6 as ambiguous:

- One target ambiguity, `h-context-stores` (temporary duty or an update to
  Telemachus's record). It was dropped before scoring.
- Five tag ambiguities. Those cases keep their type and target labels but are
  left out of tag metrics.

No label changed. The verdicts are kept in the case file. That leaves 26
held-out cases, so 78 outcomes per arm.

"Held-out" means held out from calibration. The author wrote the cases and the
candidate's rules together, so this is not a blind test. The author (Claude
Opus 5.5) is the same family as the current arm, and the label check is from
another family.

## Floors

The floors were set on tuning only and frozen before any held-out call.

- **Target.** The rule takes the floor with no wrong-target append and the
  most correct targets, ties going to the higher floor. Floors 0 to 0.4 each
  made three wrong-target appends on tuning; 0.6 made none and got 42/42.
- **Type.** With the target floor fixed, the rule takes the floor with the
  most correct types, ties going to the lower floor. 0.6 scored best (42/42).

Both frozen floors are 0.6, reached by separate rules. #839's shared floor was
not inherited. No Jev tag floor exists, because Jev does not tag.

## Held-out results

Tag metrics are micro-averaged over every emitted tag. Out-of-vocabulary tags
count as false positives.

| Arm | Type | Target | Tag precision / recall | Wrong-target appends | Content loss | Agreement (full / routing) |
| --- | --- | --- | --- | --- | --- | --- |
| Current skill, Sonnet 5.5 | 78/78 | 78/78 | 46.8% / 98.5% | 0 | 0 | 24/26 / 26/26 |
| Code + Jev routing, LLM tags | 72/78 | 75/78 | 76.7% / 100% | 0 | 0 | 24/26 / 26/26 |
| Deterministic baseline | 36/78 | 60/78 | 7.8% / 36.4% | 0 | 0 | 26/26 / 26/26 |

**The candidate's misses** fall on two cases, in all three repetitions each:

- **`h-collision-stores`:** "Telemachus finished this season's jar tally for
  the stores inventory…". Jev chose the right target, Stores inventory, but at
  confidence 0.52–0.57, under the floor. The capture became a new note. That
  is a missed append and a type miss, not a wrong write.
- **`h-nonappend-title`:** a reaffirmation that starts with the exact title of
  an opinion record. Opinion records do not accept appends, which the
  candidate got right. Jev then chose `note` instead of `opinion`, twice under
  the type floor and once above it.

The candidate's eight question-level abstentions are these sub-floor answers.
No reply was invalid, nothing was left unwritten and no fallback failed.

**Tags.** All 74 of the current arm's false positives are out of vocabulary.
They come from `brain add`'s keyword fallback, which 34 of its 120 writes hit.
Within the vocabulary its precision is 100%.

The candidate's tag step emitted no out-of-vocabulary tag. It did over-tag
inside the vocabulary: `ithaca` on 17 outcomes and `sailing` on 3, for 76.7%
precision. Its higher all-tag precision comes from avoiding the keyword
fallback. Within the vocabulary it trades precision (76.7% against 100%) for
recall (100% against 98.5%, one missed tag). That is a trade-off, not a clear
improvement in tag judgment, and it does not offset the routing gap.

**Literal capture.** The current arm did not keep the literal capture string
in 13 held-out and 4 tuning writes. It removed routing phrases, quotation
marks or `Tags:` lines, or split off a title line.

GPT-6 checked all 17 against their inputs and the original files and found no
lost content. One verdict was rechecked by hand. These are reported as
literal-form differences, not losses. The judge knew the arms' outcomes.

**Enforcement.** This is mechanical, not a measure of model quality. All 120
candidate writes touched only the routed target, or one new file when no
target was routed. The tag step had no tools, and the writer used no field
from it except `tags`. Unit tests check the shortlist guard, the
explicit-type override, the writer's refusal of a non-shortlisted target,
exact empty tag sets and the calibration rules, and each one failed under a
targeted mutation.

**Regression input.** On #839's 19 held-out cases (57 outcomes, earlier
inputs, not new evidence), the candidate's routing at the frozen floors scored
56/57 types and 57/57 targets, with no wrong target.

## Calls and reliability

The run made 177 Jev requests: 120 on the fresh cases and 57 on the
regression inputs. It ran 204 Claude Code processes, 84 tag steps and 120
current-arm captures, which made 418 model requests. All of them used the
subscription with API-key variables removed. No rate limit, overage or
retry occurred.

All current-arm transcripts were scanned for tool inputs naming the checkout,
the cases or the results, and there were none. Unlike #839, no separate
isolation control was run, so OS-level containment is not independently
proven here.

## Limits

- The sample is small and authored, with correlated repetitions: 26 held-out
  cases and ten records, eight of them append targets.
- The routing rules and the cases were designed together.
- Type meanings come from the fixture policy, not from runtime config.
- The tag handoff is one experimental prompt, and append tags are kept by
  construction.
- Only literal violations got a semantic review. Duplication, prose quality,
  frontmatter fidelity beyond tags and non-Markdown side effects were not
  evaluated.

Both model arms are near ceiling on routing, so the six-outcome gap rests on
two decisive cases. It is still a consistent gap with no counterweight on
routing.

## What this leaves for #1588

The routing-only split does not meet the epic's parity bar as frozen, so this
spike does not recommend implementing #1588. Any of these could justify
re-evaluating:

- target evidence that resolves an owner-contact versus project collision
  above a safe floor
- production type descriptions that measurably fix type choice
- a tag step that keeps current recall without in-vocabulary over-tagging

Each would need fresh held-out cases.

Whether to close #1588, and its production questions (type descriptions,
which code writes, the opt-in, thresholds), stay with the maintainer. Neither
this result nor closing this spike authorizes implementation.

The harness was reviewed by GPT-6 before merge; its findings and their
resolution are recorded on the PR.
