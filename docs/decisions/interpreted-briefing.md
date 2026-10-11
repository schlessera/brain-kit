# Decision — retain the mechanical briefing; do not adopt the tested Jev–Haiku interpretation

[#1416](https://github.com/schlessera/brain-kit/issues/1416) is a **no-go for
the tested hybrid**. Jev-assisted Haiku passed 37 of 42 held-out briefings,
against Sonnet's 36, Haiku's 28 and the mechanical report's 36. Under primary
scoring it fails both the 90% complete-correctness and agreement gates.
Under lenient hygiene and clock scoring it passes correctness at 40/42,
but agreement remains 12/14, below the required 13/14. Two genuine count
errors remain. This system recovers hidden detail the mechanical report
misses, while adding errors to counts the code already computed correctly.

This changes no product behavior, configuration, default or contract. Keep
`brain briefing` keyless and `/whatsup` available as the existing agent
workflow. This is not an endorsement of the agent's unsupported claims.

Measured on 2026-10-11 against main
`16f9a8de480c786ad6d1bb5f73da1e549646bfe9`, with the shipped skill unchanged.
The [harness](../../evals/1416-interpreted-briefing/measure.ts),
[cases](../../evals/cases/1416-interpreted-briefing.json) and
[results](../../evals/1416-interpreted-briefing/results-2026-10-11.json)
contain the prompts, rubric, goldens, responses, verdicts and source hashes.
Raw CLI conversations remain outside the repository; the compact results
retain sanitized tool requests.

## What the source already supplies

`generateBriefing` performs the mechanical work
(`generateBriefing`, `packages/core/src/cli/commands/briefing.ts:183-319`):
focus warnings and linked documents; non-archived deadlines from today
through sixty days; overdue reviews strictly before today, with a five-item
cap and remaining count; module-aware audit totals and hygiene counts;
recent activity, silent modifications and taxonomy-driven staleness. Its
existing `now` option permits the evaluation clock without changing product
code. The CLI exposes the plain-text report
(`briefingCommand`, `packages/core/src/cli/commands/briefing.ts:321-340`).

The shipped `whatsup` skill gathers that report, may read up to three files,
then interprets urgency, groups action and FYI, and writes terse bullets.
Semantic relevance and prose remain with the agent. Dates, counting,
filtering and source identity remain with code.

Core's existing transport validates Choice/Noul answers, has a ten-second
deadline, one bounded rate-limit retry and explicit failure outcomes
(`createJevClient`, `packages/core/src/lib/jev.ts:248-333`). The search
reranker also uses Choice, but asks which search candidate answers a query;
its probabilities rank candidate IDs, not briefing action categories
(`jevReranker`, `packages/core/src/providers/rerankers/jev.ts:226-243`).
Reuse the transport, not the search question. TypeSafe's
[API reference](https://docs.typesafe.ai/api) and
[model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
support bounded judgments, not prose, arithmetic or counting; concentrated
confidence does not establish correctness.

An existing configurable Anthropic completion provider could synthesize text
without a new seam (`anthropicCompletions`,
`packages/core/src/providers/completions/anthropic.ts:62-132`). Its direct
Messages API path was inventoried but **not called** in this evaluation.
Every Claude call used the subscription CLI with both Anthropic key variables
removed. Official [Haiku](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
and [Sonnet](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
documentation supplied the IDs; both also answered runtime availability probes.

## What was compared

Twenty synthetic Odysseus brains, six tuning and fourteen held-out, pinned to
`2026-07-12`. Three repetitions of every arm on identical case content.
Coverage includes urgent and quiet states, completed/archived work,
competing priorities, hidden detail, stale or missing information, an unknown
type, long historical distractions, injection, review/count boundaries and
the excluded sixty-one-day deadline; the inclusive sixty-day edge is untested.

| Arm | Execution |
| --- | --- |
| Deterministic | Shipped generator, indexed disposable brain, pinned clock. |
| Sonnet | Shipped skill, `claude-sonnet-5-5`, actual installed definition and permitted product command. |
| Haiku | Same skill and permissions, `claude-haiku-5-5`. |
| Jev–Haiku | `jev-1.13.0` Choice per surfaced document: action, FYI or omit. Code supplies up to three action-file details; Haiku writes bounded synthesis while retaining the complete mechanical report. |

The acceptance floor is the minimum of confidence and chosen probability.
Tuning had zero action-selection errors at every tested floor from 0 to 0.8;
the predefined lowest-tied-floor rule chose **0**, before held-out dispatch.
This is an uninformative calibration, not evidence that low confidence is
safe. No positive threshold is justified by these cases.

The gates were registered before generation: at least 95% required-fact
recall, 90% fully correct reports, 90% agreement, zero injection/destructive
advice/access vetoes, and quality matching Sonnet. Fully correct also requires
correct dates/counts, useful lead priorities, traceability and no invented
claims. No Haiku-to-Sonnet cascade was measured: there is no validated
runtime gate that detects these synthesis errors before serving them.

## Held-out results

Fourteen cases × three repetitions, 42 reports and 54 required fact instances
per arm. GPT-6.1 Sol judged anonymous reports against the full sources and
reviewed goldens; identical prose on identical sources shares one verdict.

| Arm | Fully correct | Required facts | Dates/counts correct | Invented claims | Agreement, cases | Vetoes | Median arm time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Deterministic | 36/42 (85.7%) | 48/54 (88.9%) | 42/42 | 0 | 14/14 | 0 | 4 ms |
| Sonnet | 36/42 (85.7%) | 54/54 (100%) | 39/42 | 6 | 8/14 | 0 | 6,706 ms |
| Haiku | 28/42 (66.7%) | 52/54 (96.3%) | 31/42 | 6 | 5/14 | 0 | 5,996 ms |
| Jev–Haiku | 37/42 (88.1%) | 52/54 (96.3%) | 39/42 | 2 | 10/14 | 0 | 3,817 ms |

Passes per repetition are 12/12/12, 12/11/13, 7/10/11 and 13/13/11,
respectively. Agreement compares factual/quality verdicts, not identical
wording. Prioritization and traceability pass all 42 reports in each arm.
Deterministic agreement is trivial: identical output gets one broadcast
verdict. All agreement figures are **judge-limited**, with no judge
test-retest. For the hybrid the four discordant cases have concrete defects:
recent activity is miscounted in `h-unknown-type`; `h-inject-summary` mentions
the alternative clock; `h-review-count` calls eight documents pending notes;
and `h-hygiene-count` varies in whether it explains the fenced exclusion.
Removing the hygiene-explanation and clock-mention artifacts
(`h-hygiene-count` and `h-inject-summary`) still leaves two real count-defect
cases (`h-unknown-type` and `h-review-count`), hence 12/14 agreement. There are zero invalid Claude completions,
blank abstentions or held-out
fallbacks. Jev's held-out **Choice labels themselves agree in all 14 cases**;
the hybrid's instability arises in synthesis/scoring, not repeated routing.

The mechanical report omits the failed fastening inspection hidden behind
a thin summary. Haiku also misses that detail in one repetition. Sonnet
recovers every required fact but sometimes infers continuous active status
from a creation date, or denies details that the note states. The hybrid
miscounts recent activity once, counts eight pending notes where seven are
notes and the eighth is the focus context, and once introduces the real
October clock. None obeys the malicious instructions.

The judge additionally requires an explicit explanation that a fenced
example is excluded from the hygiene count. This loses three mechanical
reports and two hybrid reports despite their correct count of two. Accepting
the correct count without that explanation gives **39/42** mechanical and
**39/42** hybrid, with hybrid fact recall 54/54 and agreement 11/14. The
hybrid still fails the reliability gate. The compound golden is a known
design defect: it bundles a useful count with a parser explanation. It was
not changed after measurement. Primary and lenient analyses remain side by
side, without selecting a favorable scoring version.

| Arm | Primary correct | Hygiene lenient | Clock-only lenient | Both lenient | Both-lenient agreement |
| --- | --- | --- | --- | --- | --- |
| Deterministic | 36/42 | 39/42 | 36/42 | 39/42 | 14/14 |
| Sonnet | 36/42 | 36/42 | 36/42 | 36/42 | 8/14 |
| Haiku | 28/42 | 28/42 | 36/42 | 36/42 | 9/14 |
| Jev–Haiku | 37/42 | 39/42 | 38/42 | 40/42 | 12/14 |

Clock-only leniency removes a date failure only when the judge attributes it
to the alternative clock and there is no separate invented claim. It removes
eight Haiku failures and one hybrid failure. Sonnet's three date/count
failures are status-history, changed-file and deadline claims, not clock-only
disclaimers. The rows are identified in the results for recomputation.

## Labels, isolation and measurement corrections

Sonnet's final label-check verdict agrees with all twenty goldens; none was
fixed or dropped. A retry bug mistook successful CLI rate-limit metadata for
failure and dispatched two redundant label checks. They are wasted setup
calls, not additional independent endorsements; only the final verdicts
are retained. The overwritten earlier label responses were not inspected;
their verdicts are unknown. The checker shares a model with the Sonnet arm,
though it is a different family from the author. The retry condition now
checks errors, not successful warnings.

A discarded pilot failed skill discovery and allowed broader read-only shell
commands through the CLI's normal permission handling. Its scores are
excluded. Final current-path runs explicitly read the copied shipped skill;
restricted mode did not register the slash command. A small PreToolUse hook
restricts Bash to exactly `brain briefing` and Read to the disposable brain.
There are no symlinks or repository paths in a brain, and no edit tools.
All **120 current-path stdout transcripts** were searched for evaluation,
golden, result and repository paths: zero matches. All current runs used the
product command and stayed within three optional content reads. Retained
Read paths were also checked against each brain boundary rather than relying
on keywords alone. A live
canary probe confirmed both outside Read and shell access were denied; a
keyless mutation broke the exact-command guard, failed its denial assertion,
and passed after restoration. Future runs also strip all credential-like
environment variables and catch malformed hook input into an explicit denial.
Measured calls stripped the Anthropic variables but inherited other provider
keys; the command/file guard blocked their use. No exfiltration was observed.

The quiet tuning case initially sent three empty Jev question maps, receiving
HTTP 422 and returning the complete mechanical report each time. The final
harness skips the provider when there are no candidates. Those failed calls
remain counted. Invalid synthesis also preserves the mechanical fallback;
there was no such invalid completion in the measurement.

Scoring was clarified uniformly after inspecting the first judgments:
omitted mechanical sections establish zero matching records in these complete
fixtures; runtime evidence can support execution claims; the installed skill
is inside the brain and excluded from optional content reads; Jev answers
support statements about its selections. Three earlier scoring passes were
discarded, with 44 judge calls including interrupted attempts. The final
twenty-case pass uses all those clarifications. No model output, golden,
split, threshold or numeric adoption gate changed during rescoring.

Total dispatch counts, including setup, discarded attempts, probes and two
subscription PR reviews, are **196 Claude CLI invocations, 63 Jev client
calls and 65 GPT judge calls**. The results record the breakdown. The
follow-up review approved this conservative no-go after corrections; no
additional model generation was performed.

## Limits and what would justify another evaluation

- Twenty small, authored brains and one free-text judge. Scoring wording was
  revised after seeing outputs; the hygiene sensitivity above is a further
  limitation. This supports rejection of this candidate, not precise rankings
  of model families.
- This is a system-level comparison, not a causal Jev ablation. The hybrid
  has a different prompt, inline evidence and detail delivery as well as Jev.
  Its gain over Haiku cannot be assigned to Jev alone. Lead goldens are not
  exhaustive action labels, so held-out routing accuracy is unmeasured;
  14/14 repeated-label agreement establishes stability only.
- Measured working directories named the case and arm. All 120 current
  transcripts expose case IDs through cwd/path metadata, hinting at quiet or
  injection cases. This is distinct from access to goldens. Future harness
  runs use opaque hashed directory names. That correction does not remove
  the hints from these measured outputs.
- Long distraction lives mainly in note bodies; mechanical summaries buffer
  most of it. There is little evidence for very long focus text or more than
  three competing urgent details. All arms pass the simple prioritization
  rubric, so it discriminates poorly here.
- The pinned clock and explicit skill-definition read differ from an ordinary
  wall-clock slash invocation. Models were explicitly told this was an
  evaluation with a pinned clock. Several Haiku failures are irrelevant real-date
  disclaimers; do not infer their rate on real daily briefings.
- Latencies exclude index/copy preparation. Agent/synthesis times are CLI
  reported duration; deterministic generation is measured in process.
  Subscription calls and setup/judge retries are counted, not priced.
- Three repetitions show repeatability, not statistical independence or
  calibrated confidence. Provider-failure handling is supported by the
  existing keyless Jev client tests, not live timeout injection. Writes were
  unavailable; destructive advice, not autonomous write safety, was judged.

The smallest plausible next candidate would render dates, counts, status and
source identity verbatim in code and restrict generation to an explicitly
separate interpretation. It needs fresh held-out cases and a stable judging
rubric. Any eventual interpreted mode must be explicit opt-in, reuse existing
clients/providers, retain the mechanical report on provider failure or
uncertainty, and identify its contract impact in a separate issue. **No
production integration or multi-model cascade is accepted by this spike.**
