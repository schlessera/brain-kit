# Decision — retain the shipped tool and skill surface

The live [#587](https://github.com/schlessera/brain-kit/issues/587) comparison
does not justify shipping a pre-turn Jev router. Keep the existing eager
bridge tools, deferred core tools and full skill listing. Hard pruning made
required tools unavailable in six of eighteen tool-needing turns. Hint and
load-set preserved those calls, but this small comparison demonstrated no
quality improvement or first-frame latency improvement. The research threshold
of 0.6 is not a calibrated production setting.

This decision was measured on 2026-10-07. It changes no production default,
permission policy, public contract or skill content. The pi backend was not
measured; analogous listing controls would need proof in its own runtime.

## Evidence and frozen comparison

The [complete observations](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/results.json)
retain every scored call, answer, round-trip counter, router outcome, physical
Jev response and native exit. The [recomputed table](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/summary.json)
contains each case's three-repetition spread; the
[protocol](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/protocol.json),
[manifest](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/manifest.json),
[full review input](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/review-input.json)
and [successful complementary review](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/review.json)
preserve the exact experiment boundary. Complete raw native transport,
initialization, account and error receipts remain private; published account
fields describe only the selected routing mechanism.

The measured source is `380ad6eaf2f05807e15a67410cae64daaba7be5b`, with 356
source/corpus hashes. Review input SHA-256 is
`aaf86185df19d116fce867997d902db2357d4e295fd65e6389296d97adddbfbd`;
protocol SHA-256 is
`9f74e62fb141dc93be6b4085cc3706e3de4271223cef989e6778502e09c9b3a3`.
An OpenAI-family author prepared the natural goldens and protocol. The
complementary `claude-sonnet-5-5` reviewer returned successful **APPROVED**
for that exact freeze after the implementation audit and full offline controls.
The [public approval receipt](https://github.com/schlessera/brain-kit/issues/587#issuecomment-6042071090)
predates scored dispatch.

The comparison ran under Bun 1.3.14, Agent SDK 0.3.283 and bundled Claude Code
2.1.283. Main and auxiliary model aliases were pinned to `claude-sonnet-5-5`;
classifier requests were pinned to `jev-1.13.0`. This older CLI successfully
used the canonical model but reported unknown fallback pricing and 200k/32k
metadata. Those fields are observations, not independently verified model
limits. The runtime upgrade and remeasurement are tracked separately in
[#1213](https://github.com/schlessera/brain-kit/issues/1213).

All 144 turns completed: twelve natural fictional prompts, four arms, three
repetitions, concurrency one. Each arm starts nine of the thirty-six
prompt/repetition groups; three repetitions cannot balance four positions for
each individual prompt. The same owned project path was restored between
turns. There were no excluded turns, diagnostic-budget failures, missing usage,
model/account mismatches or reported subscription overage. All 144 observed
native child exits were code zero, and the controller awaited their exit.

The representative fixture uses all 31 canonical Odysseus corpus files,
their original configuration, pinned story date 2026-07-12, three unchanged
toy project procedures, twelve bundled CLI skills, eight real core MCP tools
and all eight conditional bridge tools. The actual index reports 25 documents,
25 chunks and zero embeddings. Bridge host responses for the harbour picker
and activity query are fictional controls. Listing all eight bridge schemas
does not establish behavior coverage for each bridge handler.

## Representative input budget

Five free `count_tokens` requests measured ordered cumulative marginals of
one actual native serialized request. They do not independently tokenize
fragments and add them. The [counting receipts](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/token-budget.json)
retain the observed request digest and cumulative counts.

| Input group | Marginal tokens |
| --- | ---: |
| Everything else, including server instructions | 8,760 |
| Built-in tools and shared search/placeholder definitions | 16,907 |
| Deferred core MCP tool names | 98 |
| Eager bridge definitions | 14,142 |
| Skill listing | 2,068 |
| **Total** | **41,975** |

The current baseline is already split: the public template's
[pinned MCP configuration](https://github.com/schlessera/brain-template/blob/e8504586a152a8e2a2090accb132841f96a877aa/.mcp.json)
does not set `alwaysLoad`. Actual CLI capture sees zero loaded core schemas
and eight deferred core names, alongside eight eager bridge schemas. The 98
tokens are the names, not a measurement of eight loaded core schemas. D44's
older bridge counts remain historical.

## Four arms and behavior

Baseline preserves that shipped split. Hint preserves the same surface and
adds relevance advice after the actual skill listing. Load-set eagerly loads
selected MCP tools, leaves other tools recoverable through actual ToolSearch,
and leaves rejected skills discoverable by name. Hard-prune removes rejected
MCP tools and skill entries. Native built-ins remain constant in every arm;
this is not a built-in tool pruning experiment.

Each routed arm made eighteen answered decisions and eighteen low-confidence
decisions that fell back to the full original surface. The table includes
both, matching fail-open behavior; it is not a table of thirty-six successfully
applied routing decisions per arm.

| Completed-case measure | Baseline | Hint | Load-set | Hard-prune |
| --- | ---: | ---: | ---: | ---: |
| Needed tool groups hit | 18/18 | 18/18 | 18/18 | 12/18 |
| Needed skill invoked | 9/9 | 9/9 | 9/9 | 9/9 |
| Wrong skill loads | 0/9 | 0/9 | 0/9 | 0/9 |
| Needless skill loads | 0/27 | 0/27 | 0/27 | 0/27 |
| Needless tool use in prose-only cases | 0/9 | 0/9 | 0/9 | 0/9 |
| Frozen bounded content checks | 36/36 | 36/36 | 35/36 | 33/36 |

Tools count only accepted results matched to their tool-use identifier; bridge
arguments must parse through the shipping contract. A Skill load counts an
actual successful `Skill` invocation, not a manual read of a skill file.
ToolSearch itself is discovery and does not fulfill a needed-tool group.

| Required operation, three repetitions per case | Baseline | Hint | Load-set | Hard-prune |
| --- | ---: | ---: | ---: | ---: |
| Quote card (`show_block`) | 3/3 | 3/3 | 3/3 | 3/3 |
| Comparison card (`show_block`) | 3/3 | 3/3 | 3/3 | 0/3 |
| Harbour picker (`ask_user`) | 3/3 | 3/3 | 3/3 | 0/3 |
| Activity query (`query_activity`) | 3/3 | 3/3 | 3/3 | 3/3 |
| Raft Markdown read (core or native reader) | 3/3 | 3/3 | 3/3 | 3/3 |
| Star-note retrieval (core or contained filesystem search) | 3/3 | 3/3 | 3/3 | 3/3 |

Hard-prune classified the comparison and harbour requests as needing no
tools on every repetition. Native ToolSearch could not recover the absent
tools, and the answers explicitly reported that the card or picker was
unavailable. Those are genuine false negatives despite fluent fallback prose.
The harbour content predicate only looked for “Ithaca,” so it passed those
three unsuccessful picker turns. The needed-tool column keeps that failure
visible.

The sole load-set content miss is a predicate false negative. Its final
rewrite was “Before departing, Odysseus should check at daybreak whether the
mast is sound.” The frozen regex accepts `light|dawn|daylight` but omits
`daybreak`. The literal 35/36 result remains; that sentence does not demonstrate
a semantic regression. The rewrite predicate also does not exhaustively test
the instruction to add no facts.
These two semantic-control limits are recorded in
[#1233](https://github.com/schlessera/brain-kit/issues/1233); the historical
literal scores and review digest remain unchanged.

The voyage and timber skill cases need notebook facts beyond the toy skill
body. Their skill metric intentionally measures invocation, while the content
metric checks those facts; no needed-reader rate is claimed for those cases.
A future hard-prune content miss there could reflect a pruned reader rather
than a failed Skill invocation. `Bash` appears as an alternate in the star
golden but is uniformly denied, so it cannot produce an accepted hit.

## Round-trip tokens and timing

All per-message token sums reconcile against final canonical native model
usage. Terminal cumulative `message_delta` output overrides provisional or
repeated assistant frames. Fresh input, cache reads and cache writes are
distinct columns; total input includes all three. Cache-write TTL receipts
fully price the recorded scored usage.

| Arm | Round trips | Fresh input | Cache reads | Cache writes | Output | Total input |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 89 | 178 | 3,702,752 | 123,372 | 16,560 | 3,826,302 |
| Hint | 89 | 178 | 3,754,156 | 83,263 | 16,954 | 3,837,597 |
| Load-set | 91 | 182 | 3,227,429 | 105,938 | 16,079 | 3,333,549 |
| Hard-prune | 88 | 176 | 3,325,791 | 94,319 | 16,504 | 3,420,286 |

Load-set used about 12.9% fewer total input tokens than baseline in this
sequence, with two additional round trips. This includes eighteen full-surface
fallbacks. Hint has no designed schema reduction; its observed cache-write
difference does not establish a causal cache improvement. One shared account,
prefix cache, fixed fixture path, query-specific identifiers and time context
make warm/cold or independent-arm cache claims unwarranted.

Times below are milliseconds, shown as minimum / median / maximum across the
thirty-six turns per arm. The summary artifact also keeps each prompt's
three-repetition spread. Timing starts after fixture and MCP preparation,
before routing and native spawn. First frame means a model stream frame;
first text is separate.

| Arm | First model frame | First text | Whole turn |
| --- | ---: | ---: | ---: |
| Baseline | 928 / 1,319 / 9,492 | 929 / 3,994 / 16,790 | 1,513 / 4,689 / 16,841 |
| Hint | 1,089 / 1,551 / 13,887 | 1,089 / 4,397 / 18,138 | 1,646 / 4,569 / 18,166 |
| Load-set | 1,040 / 1,432 / 6,037 | 1,040 / 4,634 / 13,488 | 1,768 / 4,664 / 13,530 |
| Hard-prune | 1,078 / 1,532 / 2,250 | 1,078 / 4,518 / 13,130 | 1,613 / 4,809 / 16,437 |

Jev duration was 222 / 283 / 705 ms for hint, 218 / 274 / 559 ms for
load-set and 218 / 260 / 675 ms for hard-prune. Actual native spawn was
initiated alongside routing, before its answer. Offline runtime controls also
prove the two-second timeout fallback. No live timeout occurred.

Same-case/repetition first-frame differences relative to baseline had medians
of +193 ms, +125 ms and +135 ms for hint, load-set and hard-prune. The maximum
differences were +12,429 ms, +4,637 ms and +869 ms. The first two exceed two
seconds even though their routers took only 261 ms and 238 ms. This run
therefore does not prove a two-second end-to-end first-frame overhead bound or
attribute those outliers to routing. A bounded classifier wait and observed
end-to-end latency are different evidence.

## Charges, diagnostics and controls

Jev made 149 physical direct-API attempts: 49 hint, 50 load-set, 50 hard-prune.
Every response retained its canonical model and input usage. At the
[published input price](https://docs.typesafe.ai/models) of $0.042 per million
tokens, the charge is $0.014046396: $0.004654818, $0.004680396 and $0.004711182
respectively. This is usage-derived published pricing, not a final account
statement. Output is free at that published rate. Counting requests used the
authorized free [token-counting endpoint](https://platform.claude.com/docs/en/build-with-claude/token-counting#pricing).

At [official Sonnet 5.5 rates](https://platform.claude.com/docs/en/models/sonnet-5-5/overview),
scored Claude API-price equivalents are $1.3999944 baseline, $1.2537792 hint,
$1.2303918 load-set and $1.2078262 hard-prune, totaling $5.0919916. Three
complementary reviews add $2.024732, including the failed initial review and
the approval of the earlier fixture representation. Their
[selected receipts](https://github.com/schlessera/brain-kit/blob/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07/reviews.json)
preserve those boundaries. Equivalent diagnostics are not additional
subscription billing; the final subscription bill remains unknown. All
inference used verified first-party OAuth, with API inference credentials
excluded and reported overage aborting admissions.

The initial review hit the SDK's $1 estimated cutoff despite an independently
derived $0.690898 equivalent. A later bounded review used a separate $3
operational cutoff. Every scored arm retained the same $1 SDK estimate cutoff,
14-turn bound, low effort and 180-second deadline, and none hit them. These
operational bounds do not replace the maintainer's $15 actual additional
charge reservation or $150 aggregate cap.

The first matrix launch failed before indexing, native spawn or provider
requests because the strict staging guard rejected contained emitter
symlinks. Only the owned fixture representation changed: emitted skills became
ordinary directories with identical bytes, rebuilt on every restore/prune.
Production emission stayed unchanged. The revised collector passed twenty
scripted cells through actual setup, indexing, parallel spawn/routing, claim,
tool/skill execution, scoring and drain in a network-isolated namespace with
cleared credentials. Those controls provide mechanics proof, not quality data.
Behavioral mutations remove materialization, actual core registration,
load-set metadata, hint placement, native skill overrides, read containment,
prompt gating, streaming decoding, EOF drain and terminal-output accounting;
each fails its named assertion before restoration.

## Reproduction

Recompute the public table without credentials or provider calls. The
artifacts moved to the [measurement archive](https://github.com/schlessera/brain-kit/tree/48227b09076b350d70d9d20b8492ffcfb5b95771/scripts/fixtures/turn-surface-live-2026-10-07)
([#1385](https://github.com/schlessera/brain-kit/issues/1385)); restore them at
their original paths first:

```sh
git fetch origin 48227b09076b350d70d9d20b8492ffcfb5b95771
git restore --source 48227b09076b350d70d9d20b8492ffcfb5b95771 -- scripts/fixtures/turn-surface-live-2026-10-07
bun scripts/measure-turn-surface-report.ts \
  --results scripts/fixtures/turn-surface-live-2026-10-07/results.json \
  --tokens scripts/fixtures/turn-surface-live-2026-10-07/token-budget.json \
  --out /tmp/turn-surface-summary.json
```

For a provider rerun, use the measured source commit and its frozen lockfile;
the manifest refuses source/runtime/catalogue drift. Make the archived
artifact directory available as `$SURFACE_EVIDENCE`, supply an authorized
`CLAUDE_CODE_OAUTH_TOKEN` and `TYPESAFE_API_KEY` through the environment, keep
API inference credentials absent, and reserve the subscription window. The
existing successful receipt gates this exact snapshot; changing its inputs
requires a fresh independent review and authorization within the standing
charge limits. One command reruns all four configurations:

```sh
BRAIN_LIVE_EVAL=587 bun scripts/measure-turn-surface-live.ts \
  --manifest "$SURFACE_EVIDENCE/manifest.json" \
  --review "$SURFACE_EVIDENCE/review.json" \
  --catalogue "$SURFACE_EVIDENCE/native-catalogue.json" \
  --out /tmp/turn-surface-results.json
```

The representative budget has its own single command, with only the authorized
counting API key present:

```sh
BRAIN_LIVE_EVAL=587 bun scripts/measure-turn-surface-tokens.ts \
  --out /tmp/turn-surface-token-budget.json
```

The production authority layer remains identical across arms. Additional
uniform measurement guards admit only contained reads, read-only core tools,
fictional bridge handlers, known Skills and ToolSearch, and deny shell,
writes, delegation, unknown tools and escaping paths. Actual initialization,
account selection and effective/policy settings are checked before releasing
the protected prompt, including every small-fast and subagent alias.

## Why the alternatives do not ship

Hard pruning repeats the same confident false-negative failures across all
three repetitions and loses required tool reachability. Hint adds work but
cannot improve the already perfect observed baseline call rates. Load-set
preserves reachability and lowers aggregate input in this sequence, but adds
round trips, does not improve median first-frame latency and relies on an
uncalibrated router that falls back for half the inputs. None establishes a
production advantage against its added latency, cache and classification
failure surface.

Twelve easy fictional prompts, three minimal procedures, a uniform instruction
to follow requested procedures and readable retrieval goldens do not establish
general routing quality. This decision preserves the current baseline; it
does not rule out a future independently reviewed comparison with broader
tasks, improved semantic controls and a supported runtime.
