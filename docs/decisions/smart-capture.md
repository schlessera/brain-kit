# Decision — bounded smart capture routing

This record documents the [#839](https://github.com/schlessera/brain-kit/issues/839)
lean comparison under [#838](https://github.com/schlessera/brain-kit/issues/838).
**No-go for replacing the full smart-capture path with this configuration.**
Routing matched on this authored set, and all-tag precision improved, but tag recall
fell from 92.4% to 72.7%. The candidate misses six useful tags consistently,
including weaving for an unattended loom and hospitality for Circe's guests.
Precision and recall have no agreed exchange rate in this brief; this record
uses the conservative, post-measurement standard that neither may regress for a full replacement. By a micro-F1 criterion
alone the candidate wins (84.2% against 65.6%), so the no-go is conservative,
not a claim that the candidate is worse on every quality measure.

The single [results file](../../evals/839-smart-capture/results-2026-10-11.json)
contains all observations, judgments and label verdicts. Measured on
2026-10-11 from main `16f9a8de480c786ad6d1bb5f73da1e549646bfe9` plus this
spike. This changes no shipped behavior.

## What was compared

The [harness](../../evals/839-smart-capture/run.ts) uses the shipped `add` skill
on subscription-authenticated `claude-sonnet-5-5`, a code-plus-Jev candidate
on `jev-1.13.0`, and an always-inbox baseline with the existing title matcher
and keyword tagger. All arms receive the same initial files, taxonomy,
vocabulary, capture policy and text, in separate disposable brains.

Smart capture delegates to `/add` (`if (flags.smart === true)`,
`packages/core/src/cli/commands/add.ts:25-32`). The deterministic matcher is
`classifyContent` (`export function classifyContent`,
`packages/core/src/lib/ingestion.ts:81-136`). Configured types have directories
and structural flags but no semantic description (`export const typeSpecSchema`,
`packages/core/src/lib/config.ts:50-92`). This experiment supplies descriptions
in a shared capture policy, rather than pretending names alone establish their
meaning.

The current arm installs the shipped skill in `.claude/skills/add/`. Restricted
Claude Code does not register the local slash command, so the unchanged skill
text is also supplied as a system instruction. It uses the actual shipped CLI,
compiled outside the checkout, through a PATH shim. The available product
commands include capture, search, read-only tags and help. File tools are
restricted to each brain; native shell filesystem restrictions are configured to hide the
checkout, raw transcripts and other brains, with no unsandboxed retry.
Restricted mode ignores ordinary user/project/local settings; the harness also
passes an empty setting-source list. No brain links back into the checkout. Search uses full text without sqlite-vec.
Dates are pinned to `2026-07-12`; timeout clocks remain real.

The candidate handles exact first-line titles, explicit type requests and
literal/explicit tags in code. Jev supplies dynamic type, target from the four
existing append-match records plus `none`, and six binary tag Choices. The
candidate preserves literal content and old bodies through the shipped
frontmatter/ingestion helpers. It explicitly preserves an empty selected tag
set rather than invoking ingestion's keyword fallback. Appends retain existing
metadata and tags. No title, summary or rewritten prose is generated.

## Labels and tuning

Thirty cases were authored for this spike. Sonnet checked every golden once:
29 were accepted and `opinion-sirens` had an ambiguous `sailing` tag inferred
from the word "crew". That whole case was dropped before measurement. No other
golden changed. The verdicts, including the dropped case, remain in results.
There are 10 tuning and 19 held-out cases, with three repetitions per arm.
"Held-out" means withheld from confidence calibration: the author saw all inputs
while designing prompts and explicit matching rules. This is not a blind test
of prompt generalization. Type and target saturate for both model arms, so
these cases cannot establish routing parity beyond this set. The label checker
is from the same model family as the current arm.

The confidence screen considered 0, 0.4, 0.6, 0.8, 0.95 and 1 on tuning only.
It required no wrong-target appends and maximized the sum of type, target and
exact tag-set correctness, breaking ties toward the lower floor. The selected
0.6 scored 84/90 with no wrong target; 0 and 0.4 each made three wrong-target
selections. The frozen 0.6 was applied before any held-out call. This is a small
safety screen, not a population calibration claim. Confidence is distribution
concentration, not a correctness guarantee ([TypeSafe confidence documentation](https://docs.typesafe.ai/confidence)).

## Held-out quality and reliability

Nineteen cases × three repetitions = 57 outcomes per arm. Tag metrics are
micro-averaged over every emitted tag; out-of-vocabulary tags are false positives.

| Arm | Type correct | Target correct | Tag precision / recall | Wrong-target appends | Destructive content loss | Agreement |
| --- | --- | --- | --- | --- | --- | --- |
| Current shipped skill, Sonnet 5.5 | 57/57 | 57/57 | 50.8% / 92.4% | 0 | 0 | 16/19 |
| Code + Jev, floor 0.6 | 57/57 | 57/57 | 100% / 72.7% | 0 | 0 | 19/19 |
| Always inbox + existing title matcher | 24/57 | 48/57 | 11.4% / 45.5% | 0 | 0 | 19/19 |

All 59 current and 234 baseline false-positive tags are outside the configured
vocabulary. Within vocabulary, every arm has 100% precision, with recall still
92.4%, 72.7% and 45.5% respectively. The candidate's precision gain comes from
suppressing the CLI's keyword fallback, including preserving empty tags, rather
than from better semantic routing. Its literal-tag rule also bypasses the floor.
The shared 0.6 floor couples write-target caution to binary tag selection; a
binary Choice uses confidence = 2 × maximum probability − 1, so a positive
needs probability at least 0.8 to reach confidence 0.6 ([the documented Choice formula](https://docs.typesafe.ai/confidence#choice)). This configuration,
not Jev's general usefulness, is the rejected candidate.

Agreement means identical type, target and tag set in all three repetitions;
all arms agree on held-out type and target across repetitions. The pure
always-inbox type floor is 18/57; exact-title matching lifts the baseline to
24/57. The candidate correctly selected all 15 positive append outcomes and
all 42 `none` outcomes, as did the current skill. The baseline missed all nine
semantic append outcomes.

All scored provider answers were parseable and all scored captures produced
one valid typed document. Current and baseline had no no-write abstentions.
Jev had 61 below-floor question answers on held-out, including unused judgments
that deterministic rules override. These are counted as question abstentions,
not 61 failed captures. Type/target fallback is inbox/none and tag fallback is
absence; no generative fallback ran. Current tag counts were 61 true positives,
59 false positives and 5 misses; candidate counts were 48, 0 and 18; baseline
counts were 30, 234 and 36.

The same six candidate misses occurred in every repetition: `context-week`
(weaving), `ritual-sirens` (sailing), `network-new` (hospitality), `note-negation`
(sailing), `explicit-opinion` (weaving), and `near-title-none` (sailing). Three
were low-confidence positive tag judgments; three chose `no`. Lowering the
shared floor after seeing held-out would contaminate this result, and was not
done. The raw judgments remain available for a separately authored follow-up.
Several sailing labels are debatable: `note-negation` is a loose mast association,
and keeping sailing for the mast/crew maneuver in `ritual-sirens` while dropping
`opinion-sirens` exposes uneven specificity in the label review. Excluding those
two measured cases as a sensitivity check leaves current recall 53/57 (93.0%)
and candidate recall 45/57 (78.9%); the no-go direction remains. This changes no
headline, threshold or provider output.

The current arm did not preserve the literal capture string in 15 held-out
and 6 tuning outcomes. The GPT-family author compared every flagged write
against its input and original files: all retained the requested substantive
facts and old bodies. They removed routing phrases, transferred explicit tags
to metadata, or honored "keep only the observation". These are literal-form
violations, reported separately from destructive content loss. The per-write
semantic judgments and reasons are in results. A different-family judge is
needed here because exact string comparison cannot adjudicate retained meaning;
the author is from a different family than the current Claude arm. This review
does not score general prose quality or duplication. The author also served as
semantic judge with knowledge of outcomes; that overlap limits independence,
even though the judge and current arm are from different model families.

On tuning, current type/target correctness was 28/30, with two wrong-target
appends; the candidate had 30/30 for each and no destructive veto at the selected
floor. The baseline had 12/30 type and 27/30 target correctness. Tuning results
do not count as held-out evidence.

The 87 scored current stdout streams were retained outside the checkout.
All 87 streams were rescanned for tool inputs. A whole-stream grep for
`evals/|839-smart-capture.json|results-2026|worktrees/` found no matches;
`worktrees/` covers this checkout path. Additional scans found no raw/discarded
transcript paths or accesses to another brain. A separate access control refused both Read
and Bash attempts at the case path. The control deliberately allowed a `cat` read for that diagnostic session;
the actual tool result still reported a permission denial in dontAsk mode.
Read reported its working-directory restriction. Neither tool returned file
data. The exact source of the Bash denial is uncertain, so independent proof
of the native OS denyRead layer and broader filesystem containment is not claimed.
No perfect current routing score depends
on access to goldens. One label-check session and 87 Jev requests were made;
setup retries and interrupted sessions are included in the cumulative Claude
CLI count in results. Interrupted setup makes that counter a lower bound; it
counts sessions, not every internal helper/model request. No Claude API key or direct Anthropic API call
was used.

## Limits and integration boundary

The authored sample is small, correlated across repetitions and structurally
similar across splits. Four short existing records and six tags do not measure
retrieval at scale. The shared policy supplies custom type meanings that the
runtime taxonomy does not currently carry. Exact strings measure literal
capture preservation; only flagged rewrites were checked for substantive loss.
Frontmatter fidelity, non-Markdown side effects, duplicates, general rewriting
quality and authorization are not evaluated.

Initial current-arm setup attempts were excluded: local skill registration
was unavailable, and read-only Bash required native filesystem isolation.
Seven later permission-denied samples were rerun after permitting the product's
read-only tag/help commands and documenting available tools. Twenty-one successful tuning samples
were retained from the narrower-permission setup; the other two tuning cells
(`explicit-tags` repetitions 1 and 2) completed after resume. All held-out samples use the corrected permissions. These are
harness setup failures, retained outside the tree, not model-quality results.
The candidate's stored judgments were replayed after fixing empty-tag writes;
the confidence floor and provider judgments were unchanged.

A future integration must retain Markdown authority, runtime/config taxonomy,
explicit user choices and safe exact-title append behavior. Classification does
not grant write permission. This comparison introduces no generic seam, changes
no CLI/MCP/frontmatter contract and selects no default provider migration.

The smallest potential integration is an opt-in bounded type/target proposal,
with the existing deterministic writer and unchanged safe exact-title append
rules. This run does not authorize it: the brief evaluates the full combination,
and a routing-only cut was not separately adopted. Re-evaluation should use a
new held-out set and tuning-only separate tag/type/target floors, and show tag
recall parity while retaining precision and zero destructive vetoes. No
implementation task or rollout follows this no-go.

The final harness fixes resume metadata, source preservation and unused retry/clock
edge cases after measurement. The stored scored model outputs and floor are
unchanged. No retry was needed in the scored provider sample.

Sonnet 5.5 reviewed the complete proposed PR, requested bookkeeping/reporting
corrections, and approved the corrected code and record in a focused follow-up.
An intervening follow-up process exited on SIGTERM without a verdict. Only the
five write-scorer cases have unit coverage; route selection, summary replay and
semantic-review overrides are not unit-tested.
