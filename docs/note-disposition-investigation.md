# Note disposition: proposal boundary and offline controls

Investigation for [#840](https://github.com/schlessera/brain-kit/issues/840),
under [#838](https://github.com/schlessera/brain-kit/issues/838)'s evaluation
protocol. Source discovery used main
`3f0870d5338c9139f9bb53050847c23974662a00` on 2026-10-01.
The controls below are keyless experiments. No classifier, full-completion
quality benchmark, production write mechanism or adoption decision was measured.

## What actually runs

`brain process` reads the complete source note through containment, retrieves
up to five related search results, then makes one completion request for both
disposition and operations (`processNote`,
`packages/core/src/cli/commands/process.ts:79-135`). Related documents are
represented by snippets or summaries, not complete target reads
(`searchRelated`, `packages/core/src/cli/commands/process.ts:67-77`).
The prompt asks for combined replacement content despite that incomplete input.

The completion parser extracts JSON and normalizes missing action/reasoning
and a non-array operations field. It does not validate the action enum,
operation fields, output paths, selected target, taxonomy or content retention.
The command emits proposals and closes its database; it has no apply step
(`processCommand`, `packages/core/src/cli/commands/process.ts:138-210`).
`--keep-note` changes the prompt's archive instruction. It does not retain or
delete a file through a different executor.

The process-notes skill says `brain process` routes content, upgrades
frontmatter and removes the original inbox note. Its instructions also tell
the agent to append/delete for a merge. Those claims describe orchestration
that the command does not execute. A future revision must explicitly consume
proposals, show review requirements and delegate deterministic mutation to CLI
code rather than describing a proposal as a completed move.

`brain add` performs ingestion, with the smart branch handing off to an agent
(`addCommand`, `packages/core/src/cli/commands/add.ts:23-84`).
`brain archive` is a separate operation: it sets archived status, demotes
primary/unset relevance, preserves other bytes, and moves only active projects
to the archive directory (`archiveDocument`,
`packages/core/src/lib/archiver.ts:57-142`). It is not deletion and is not an
apply engine for arbitrary process operations. Existing ingestion, archiver,
taxonomy, indexing and safe-path primitives can be reused; no new generic seam
is needed. Search found no existing behavioral test of `processCommand` before
this experiment; ingestion/archive/search tests protect their own boundaries.

## Reproduction and controls

Run from a frozen dependency install with Bun 1.3.14:

```sh
bun run test tests/note-disposition-eval.test.ts
bun scripts/evals/note-disposition/run.ts
```

The real process command runs over a disposable indexed fictional brain with a
scripted completion provider. Its prompt contains a real highlighted target
snippet but omits the target's end marker beyond the snippet. An unsafe
`../outside.md` update is emitted unchanged; source and target bytes remain
unchanged. This observes proposal parsing, retrieval and non-execution, not
an actual escaping write or live model behavior.

Sixteen handwritten Odysseus fixtures use the pinned `2026-07-12` date:
five tuning and eleven held-out cases, with document groups confined to one
partition. They cover useful notes, duplicates, additions/negation, mixed
topics, no suitable target, missing targets, custom/unconfigured types,
unknowns, injection and irrelevant long context. These are draft goldens;
independent review and a larger representative held-out sample precede tuning.
Their expectation files being visible to a developer is not evidence of blind
model evaluation.

The deterministic baseline keeps everything except exact complete-body
duplicates, for which it proposes a retained-source update. It matches 13 of
16 draft dispositions. Always-keep would match 11 of 16. This small-set action
count establishes neither target precision nor quality equivalent to today's
completion. All sixteen oracle payloads pass the experimental guard. An oracle
is supplied fixture data, so that result measures guard compatibility, not JEV.

The private guard admits one contained content operation, current source/target
snapshots, configured types and complete verbatim source/target bodies. It
refuses malformed operations, unknown directories, stale targets, escapes,
source overwrite, unexpected keep operations and an archive without independent
authorization. Verbatim containment is deliberately conservative: it can reject
sound rewording and cannot detect a fabricated extra assertion or resolve a
contradiction. Classification and full-document review still matter. The
experiment never writes a proposal and proves no transaction/race boundary.

Four restored mutations reached their intended assertions:

| Mutation | Observed failure |
| --- | --- |
| Replace canonical containment with lexical resolution | A real symlink outside the fixture root became accepted instead of `operation escaped`. |
| Remove source-body retention check | The otherwise valid merge was accepted after dropping the complete source instead of `source content lost`. |
| Remove target-body retention check | The otherwise valid merge was accepted after dropping the complete target instead of `target content lost`. |
| Trust a receipt's keep label over its actual write proposal | An accepted merge mislabeled as keep stopped contributing to `unsafeAccepted`; the assertion expected one unsafe accepted proposal and received zero. |

`scoreReceipts` consumes externally collected observations without making
requests. It separates arm/partition/cache conditions, rejects duplicate IDs
and checksum mismatch, computes disposition/target precision and escalation,
rechecks proposals against full fixture documents, and counts all recorded
classification/generation/retry/fallback work. Unknown cost/token values stay
unknown, and absent arms are absent. It reports latency quantiles and incomplete
fixture coverage. Wrong-target or wrong-disposition accepted write proposals
veto adoption. The collector must supply complete request receipts; this scorer
cannot discover an omitted request or verify a billed account.

## Proposed separation for evaluation

Retrieval supplies a bounded candidate list with stable IDs and current hashes.
Code loads the source and candidate targets, preserves type/frontmatter and
captures full documents before generating any merge. Missing/stale/oversized
targets cannot become partially informed replacement requests. The source is
untrusted data, even when it contains instructions about archiving.

Classification asks bounded disposition and target-with-none questions. Unknown,
contradictory, multi-topic, invalid, missing or below-threshold answers retain
the note and offer the existing LLM path under its ordinary authority. Keep
never requests content generation. The experimental routing test's threshold
is illustrative; production thresholds require separate calibration and cannot
be copied from sync or answer rendering.

Generation follows a validated merge/promote selection and receives complete
source and target documents. Its result is a proposal, never an executed change.
The selected target ID must bind the update path, and promotion must bind a
configured type and its allowed directory. A full-document result is evaluated
for preserved facts, negations, metadata and provenance, not merely its label.
Unrestricted split generation remains outside this candidate's scope.

The proposed apply contract requires separate operation authorization, source
and target hashes rechecked under the existing brain lock, safe no-clobber
creation, preserved frontmatter, complete validated content, compensation on
multi-file failure, and indexing after authoritative Markdown changes. Any
archive happens only after its corresponding content write is verified and the
user has explicitly authorized that bounded archive. Reuse the actual archiver's
semantics. Classification probabilities grant no archive or write permission.
The skill reviews/chooses proposals and reports actual CLI outcomes. This is a
contract proposal for review, not a shipping schema or an implemented apply path.

## Evidence required before adoption

Do not adopt an unattended hybrid on these controls. At the keyless preparation
stage, precision, escalation, retention, malformed-operation rate, model work
saved, tokens, cost and latency were unmeasured. The offline report still prints
those live metrics as null; the separate measured comparison below supplies
observations without establishing production readiness.

Before tuning, independently review goldens and freeze task-specific gates:
zero accepted wrong-target writes, lost source/target facts, unauthorized effects
or malformed operations; all keep/uncertain paths retain original bytes. Compare
current completion, the mechanical baseline and the hybrid on identical full
documents. A minimum recommended precision is 100% among retained write routes
on the held-out set; sample size and error bounds must be reported, not treated
as a universal guarantee. Confidence is not the correctness gate.

Record account/provider/model access and total spend authorization on #840 before
any live call. Verify current model availability/pricing, freeze prompts and
thresholds after tuning, then run held-out repetitions without adjusting them.
Include all retries, fallback and generation work; input/output/cache usage,
billed/effective cost, end-to-end p50/p95 latency, throughput and state-size
sensitivity under warm/cold conditions. Compare complete documents and manually
review semantic retention. Report a go/no-go with observed spread and limitations.
Implementation follow-ups and contract/versioning rulings belong on the issue
tracker after that result; this preparation adds none to production.

TypeSafe's primary [introduction](https://docs.typesafe.ai/introduction),
[confidence](https://docs.typesafe.ai/confidence) and
[JEV 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
were checked on 2026-10-01. They document typed judgments without prose
generation, confidence derived from the option distribution, and weaknesses
with adversarial/irrelevant state and structural identities. These support the
bounded experiment's design, not a performance prediction. D42's progressive
enhancement and [deterministic sync](decisions/deterministic-sync.md)'s
keep-both fallback remain binding; their measured thresholds and historical
prices are not transferred here.

## Multi-target comparison instrument

The original sixteen cases above remain offline controls. The separate
`benchmark.json` adds twenty-six authored cases, six tuning and twenty
held-out, with competing targets, realistic observations and recurring
procedures. Entity and representation-template identifiers are separated across
partitions. Complete expected files retain original source bytes and existing
frontmatter. These author goldens require the standing opposite-family review
before live execution; literal expected-file agreement is stricter than semantic
equivalence and cannot replace independent review of actual output documents.

`live.ts` compares the actual `brain process --keep-note`, unique exact-body
matching, and bounded JEV disposition/target/type judgments followed by focused
full-document generation. The current path retains its actual retrieval snippets
and proposal-only semantics. Experimental full-document projections preserve
metadata without claiming a production apply engine. An uncertain classifier
route uses the actual current command as fallback; its calls are charged too.
A confident keep requires no generation. The approved provider-native model IDs
are `claude-sonnet-5-5` and `jev-1.13.0`.

Before dispatch, the instrument requires an issue-linked Claude-family review
receipt matching both the fixture checksum and a protocol checksum that includes
classifier/generation source and the actual current command. It reserves an
upper request charge before each physical call and stops after unknown usage.
Every provider attempt is retained, including the core JEV transport's retry.
Claude's direct Messages API instrument uses API billing under the standing
exception for direct instruments. These are plain completions, with the current
command's original prompt, rather than an agent loop that would add different
instructions. Review calls run separately on the serialized subscription and
must also be included in the issue and combined spending receipts.

Public prices were checked against TypeSafe's models page and Anthropic's pricing
page on 2026-10-07: JEV costs $0.042 per million input tokens; Sonnet 5.5 costs
$2 input/$10 output per million tokens, with $0.20 cache reads and $2.50/$4
five-minute/one-hour cache writes. Recorded charges are derived from actual
provider-reported usage at these published prices; no invoice is observed.
Correction, 2026-10-10: Anthropic's pricing pages now agree that Sonnet 5.5
cache reads cost $0.10 per million (0.05x input). On 2026-10-07 the model table
showed $0.20 while the caching section said $0.10 (#1239). The stored amounts
here used $0.20, overstating the cache-read component by half its value; they
are kept unchanged as historical diagnostics. The live helpers now read the
shared, dated rates (`SONNET55_USD_PER_MTOK`, `scripts/measure-sonnet55-cost.ts:14`).
Missing usage stays unknown. The instrument sets no cache-control hints and
retains every reported cache counter; repeated requests do not imply a warm
cache. Revalidate availability and prices when resuming the comparison.

Tuning alone selects a confidence threshold with nonempty, error-free proposed
write routes. Its physical calls are attributed once to the corresponding
hybrid observations; their latency remains part of the task. The threshold
receipt precedes every held-out call. Two complete repetitions of all three arms
are required before summaries can be interpreted. Full documents, raw proposals,
transport failures, exact outcomes, routing precision, abstention, all calls and
cache/token charges, p50/p95, throughput, per-pass spread and state-size subgroups
remain available for the measured decision. A small authored holdout establishes
only the observed sample, not a production error bound. Inventions can pass the
literal-retention guard, so independently inspect all proposed output documents
as well as exact golden agreement before any adoption conclusion.

Keyless controls run with:

```sh
bun run test tests/note-disposition-live.test.ts tests/note-disposition-eval.test.ts
```

The live entry point is deliberately excluded from ordinary tests:

```sh
BRAIN_LIVE_EVALS=840 BRAIN_EVAL_REMAINING_USD=<checked-remaining-total> \
  BRAIN_EVAL_ISSUE_SPENT_USD=<prior-issue-spend-including-review> \
  bun scripts/evals/note-disposition/live.ts <fresh-output-directory> <review.json>
```

The review receipt contains `fixtureSha`, `protocolSha`, `reviewerFamily:
"Claude"`, `reviewerModel: "claude-sonnet-5-5"`, `approved: true`, concrete `findings`, and the published
`issueReceiptUrl`. Recreated/changed inputs or protocol code require another
review identity. Partial or capped output does not satisfy the complete
comparison, and the issue remains open in that case.


The [2026-10-07 cap clarification](https://github.com/schlessera/brain-kit/issues/838#issuecomment-6038531493) applies the $15/$150 ceilings to actual additional billed charges. API-price equivalents for subscription work are separate diagnostics. Review and any reruns still belong in the issue receipt and combined ledger; do not deduct an equivalent estimate as though it were an observed subscription charge. Direct Messages API and TypeSafe request reservations use verified token pricing as conservative charge allowances.

`review.ts` supplies the required complementary Sonnet 5.5 review. It gates the prompt on the existing subscription/settings checks, isolates runtime state, removes unrelated provider credentials, disables tools and automatic memory, and aborts after 180 seconds. Its native stdout tee preserves exact bytes before SDK parsing, including error results, partial final frames and split Unicode characters. Usage is priced independently of the SDK dollar fallback; absent cache TTL produces a price interval. Raw rate-limit overage flags are retained. Missing usage or missing overage evidence remains unknown, never an invented zero. A confirmed withheld prompt records that no model request was released. The protected raw artifact stays outside the repository; public review evidence includes findings, frozen hashes and sanitized billing/usage receipts.

The complementary review rejected the first freeze on 2026-10-07. Its findings corrected two fictional ledgers, added affirmative and one-off minimal pairs, and tightened scoring: rejected proposals cannot count as exact successes, accepted non-golden writes count as unsupported effects, and retention checks use the actual written target. The raw first-review receipt is preserved separately; no live comparison used that rejected freeze.

Six tuning items select only among preregistered thresholds at or above 0.7; this is effectively untuned. If no nonempty error-free write route exists, every classification falls back to the actual current command. Duplicate goldens require merge by protocol although keep is safe. Contradiction goldens keep the note because this verbatim-retention guard cannot replace old conflicting sentences. The event-triggered pen-knot ritual is the most ambiguous promotion.

Disposition, target selection and safety are primary. Exact-file agreement is a strict-format secondary because the hybrid promotion filename is fixed while current invents a filename. Projected metadata does not measure a real writer's fidelity. The current baseline uses lexical retrieval, no embeddings and a disabled reranker; the indexed source can occur in its own snippets. Nominal entity/template separation does not make recurring task structures independent. The large-state group contains one fixture, and two repetitions with default sampling parameters provide directional observations, not a production error bound.

Claude Code's automatic session-title helper is an additional physical model request. The isolated review environment pins both `ANTHROPIC_DEFAULT_HAIKU_MODEL` and the legacy `ANTHROPIC_SMALL_FAST_MODEL` to Sonnet 5.5, as supported by the installed CLI resolver and the official [model configuration](https://code.claude.com/docs/en/model-config). Native model usage must still confirm the exact served model; a main-model initialization row alone is insufficient.

The second review also rejected its freeze. The corrected fixture now checks body/raw consistency across every case. Merge goldens and the generation prompt share a single-newline separator; complete-file comparison additionally reports blank-line and allowed ritual-filename differences separately. The unsupported-effect gate compares those format-normalised files, while strict exact files remain visible. Wrong promotion taxonomy, invented prose, metadata changes and loss still fail. Disposition accuracy uses accepted proposals; the raw model label is retained separately. Exact duplicates are protocol-forced labels, and the ambiguous pen-knot case is reported by category. The preregistered threshold floor and tiny tuning screen provide no reliable population calibration evidence. Both rejected review receipts and their hashes remain historical evidence.


## Measured comparison — 2026-10-07

**No-go for production classifier adoption.** The hybrid makes useful safe
proposals on this authored sample, but its quality advantage over the mechanical
baseline is small and reverses under a defensible alternate interpretation of
two labels. The experiment supports continued controlled investigation, not
unattended processing or a production write engine. Classifier probabilities
still authorize neither writes nor archives. The proposal/generation/apply
contract above remains the concrete candidate; no machine contract ships here.

The fourth complementary Claude-family review approved fixture SHA
`7d2a33ac9b9067b95e5ba77a2df7df137550f88884b9a886a01ea7eb5a4032cc`
and protocol/source SHA
`2356f4cb536e2f3efbf6f9cc5f2ae3ece02d0b047debd0f18eccccc542e31be2`
at experiment head `2aa2fa23c1e2fb46a97f84c2db21c2bd4ddbc8a6`.
The [approval receipt](https://github.com/schlessera/brain-kit/issues/840#issuecomment-6040336992)
preceded all comparison calls. The six tuning classifications selected 0.7
before querying held-out cases; no input, prompt or threshold changed afterward.
All 156 observations completed: 26 fixtures, two repetitions, three arms.
The [frozen protocol and runtime](../scripts/evals/note-disposition/results/2026-10-07/protocol.json),
[tuning receipt](../scripts/evals/note-disposition/results/2026-10-07/calibration.json),
[complete projections and proposals](../scripts/evals/note-disposition/results/2026-10-07/observations.json),
[every physical call](../scripts/evals/note-disposition/results/2026-10-07/physical-calls.json),
[scorer output](../scripts/evals/note-disposition/results/2026-10-07/summary.json),
[independent assessment and sensitivity](../scripts/evals/note-disposition/results/2026-10-07/audit.json)
and [all four sanitized review receipts](../scripts/evals/note-disposition/results/2026-10-07/reviews.json)
are retained. The audit includes SHA-256 identities of the original five run
artifacts. Physical-call receipt multisets reconcile with all observations;
tuning calls occur exactly once. All 137 physical responses were HTTP 200 with
the authorized served model. There were no retries, transport errors, incomplete
completions or unknown-usage stops.

Headline evidence uses only 20 unique held-out fixtures, repeated twice.
The fixed goldens expect 24 keeps, ten merges and six promotions; an always-keep
policy scores 60%, with no write opportunity to evaluate.

| Held-out metric | Current completion | Mechanical | Hybrid |
| --- | ---: | ---: | ---: |
| Accepted disposition / exact files | 20/40 (50%) | 26/40 (65%) | 27/40 (67.5%) |
| Keep recall | 18/24 (75%) | 24/24 (100%) | 18/24 (75%) |
| Merge recall | 2/10 (20%) | 2/10 (20%) | 7/10 (70%) |
| Promotion recall | 0/6 | 0/6 | 2/6 (33.3%) |
| Accepted writes / unique fixtures | 2 / 1 | 2 / 1 | 9 / 5 |
| Accepted write/target precision | 100% | 100% | 100% |
| Rejected proposals | 12 | 0 | 8 |
| Unsupported split proposals (rejected) | 2 | 0 | 2 |
| Unsafe writes / unsupported effects / loss | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Current-command fallbacks | — | — | 17/40 (42.5%) |
| Physical calls | 40 | 0 | 64 |
| Standard/list usage estimate | $0.142056 | $0 | $0.080009256 |
| End-to-end p50 / p95 | 2.236 / 4.140 s | 0.798 / 1.047 ms | 1.918 / 4.917 s |
| Sequential observations per second | 0.360 | 1236.393 | 0.465 |

The hybrid used 40 classifier calls, seven focused-generation calls and 17
actual-current fallbacks on the held-out set. It saved 16/40 Claude calls (40%)
and 43.7% of the standard/list token-price estimate, while increasing total
physical calls by 60%. Its median was 14.3% lower, but its p95 was 18.8% higher;
this is not a general latency improvement. Across tuning and held-out together,
the hybrid used 52 classifier calls, 11 generation calls and 22 fallbacks,
versus 52 Claude calls for current completion. Keep routes generated no content.

Excluding `water-check` and `guest-confirmation`, accepted disposition accuracy
is current 20/36 (55.6%), mechanical 26/36 (72.2%), hybrid 24/36 (66.7%). If safe
keep is also accepted on those two debatable labels, scores become 22/40 (55%),
30/40 (75%) and 28/40 (70%). The fixed primary goldens remain unchanged.
Excluding only protocol-forced duplicate labels gives 47.4%, 63.2% and 65.8%.
These sensitivities are sufficient to reject an adoption claim based on
headline accuracy alone.

GPT-family inspection of the Claude-generated proposals and complete projections
confirmed every admitted write exactly matches its reviewed full-file golden.
Original sources, complete targets, metadata and negations remain intact; no
invented prose, cross-target operation or archive was admitted. All 19 admitted
write observations across both partitions are exact, including nine held-out
hybrid writes. However, the current command's ten held-out retention refusals
and the hybrid's six are **literal guard refusals**, not ten/six observed
semantic data losses. Several preserve facts with bullets, headings or
paraphrase; the duplicate raft control fails solely because its output omits the
terminal newline. Rejected proposals do not count as correct dispositions or
exact successes. Zero admitted loss cannot establish that current generation
semantically loses every rejected source, or that the guard recognizes all
possible inventions. Raw content and refusal reasons remain available for that
distinction. No actual apply engine or disk write was evaluated.

Current and mechanical held-out dispositions repeat identically. Hybrid differs
on `water-check` only: merge in pass zero, current-fallback keep in pass one.
Hybrid held-out exact scores are 14/20 and 13/20, with five and four writes;
current is 10/20 both passes and mechanical 13/20 both. The entire-run current
pass estimates are $0.096348/$0.097028; hybrid $0.060190742/$0.055298742.
The one large-state fixture is correctly kept in every arm/pass; its two
hybrid observations total 0.541 s versus 3.693 s for current. This is a subgroup
description, not a scaling curve. Every reported cache read/write counter was
zero, so no warm-cache improvement was measured.

Five unique admitted hybrid write cases provide very weak precision evidence.
Even an illustrative one-sided 95% binomial bound with five independent,
representative cases and zero failures permits a failure rate up to 45.1%.
Those independence/representativeness assumptions do not hold here, so this is
not a population confidence interval. The two repetitions are correlated; eight
unique held-out fixtures expect writes. Six tuning items with a preregistered
floor supply no reliable population calibration. Full-target reads, explicit
category instructions and stronger verbatim generation are confounded with JEV.
The lexical current baseline retrieves the entire tiny candidate collection
within its five-result limit, and diagnostic fixture filenames are visible to
it. Uniform metadata is projected, not written by a real production writer.

The 137-call standard/list usage estimate is **$0.308865484**: 52 current calls
($0.193376), 22 fallbacks ($0.104032), 11 generations ($0.009412) and 52 JEV
classifications ($0.002045484). Claude usage totals 40,360 input/22,610 output
tokens; JEV 48,702 input/5,736 output, with free output at its verified input-only
price. This is a usage-derived API billing estimate, not an observed invoice or
an asserted universal upper bound. Requests omitted `service_tier` and returned
tier metadata was not retained. The current official
[service-tiers reference](https://platform.claude.com/docs/en/api/service-tiers)
excludes Sonnet 5.5 from legacy Priority Tier; requests also set no tool, speed
or geography premium. This supports standard/list comparison, without an
account-specific billing claim. Later collectors should pin and retain the
applicable tier/rate metadata explicitly.

Four input reviews consumed $1.653608 in separately calculated API-price
equivalents. Their observed additional subscription charge was $0 on first-party
OAuth routing and inactive-overage evidence, without claiming a final invoice.
The first review's unexpected automatic-title Haiku call is retained in history
and its diagnostic amount; subsequent reviews pinned both helper selectors to
Sonnet 5.5 and observed only that canonical model. Actual-charge reservations
and subscription diagnostics are kept separate under the maintainer's cap
clarification. No additional paid run is required to reach this no-go.

Implementation therefore does not adopt JEV or an unattended apply path. The
source-confirmed JSON extraction defect has its own supporting task
[#1211](https://github.com/schlessera/brain-kit/issues/1211), and
[#1226](https://github.com/schlessera/brain-kit/issues/1226) owns preserving pricing
modifiers in future collector receipts. Full-target generation
and a separately validated, explicitly authorized apply boundary remain
concrete candidate tasks under the contract above; classifier adoption requires
broader independently reviewed data and an ablation that isolates full-target
access from routing. None of those future production changes is implemented or
authorized by a classifier probability in this spike.
