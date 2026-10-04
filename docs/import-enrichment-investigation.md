# Import enrichment: source discovery and offline controls

This investigation for [#850](https://github.com/schlessera/brain-kit/issues/850)
examines the optional enrichment stage of `brain-import`. Source was inspected
at `7a355226c9a00a1ffb8bfc20f0023e50a5c8d65b` on 2026-10-02. The private
evaluation uses fictional temporary brains and scripted completion providers.
It adds no production command, changes no import skill or cache contract, and
does not establish a measured model go/no-go.

## Existing ownership

| Operation | Source | Consequence |
| --- | --- | --- |
| Mechanical stamping | `importCommand`, `packages/core/src/cli/commands/import.ts:26-80` | `--stamp` supplies inbox metadata and skips files starting with a frontmatter delimiter. It performs no classification or summary generation. Its existing outer-whitespace normalization is outside this investigation. |
| Approved folder mapping | `## Stage 2`, `packages/core/skills/brain-import/SKILL.md:50-56` | The owner approves the structure before moves. The prototype accepts exact approved paths; it never copies, moves or remaps files. |
| Optional type/tags/summary and import manifest | `## Stage 3`, `packages/core/skills/brain-import/SKILL.md:58-65` | These are agent instructions. There is no shipped Stage 3 executor or `.import-manifest.jsonl` implementation to benchmark as a CLI baseline. |
| Context and asset result caches | `chunkContextKey`, `packages/core/src/lib/indexer/caches.ts:29-38`; `assetCacheKey`, `packages/core/src/lib/indexer/caches.ts:113-116` | Keys identify generated derivatives. They do not prove that metadata at a particular imported path was successfully written. Existing keys do not contain this prototype's model/configuration identity. |
| Cached context generation | `generateChunkContexts`, `packages/core/src/lib/indexer/contexts.ts:36-58` | Index-time chunk context is separate from writing an imported document's frontmatter summary. |
| Preserving frontmatter edits | `editFrontmatter`, `packages/core/src/lib/frontmatter-edit.ts:216-295` | Reuse surgical edits. Unsupported syntax refuses a write rather than falling back to whole-document serialization. |
| Conditional source replacement | `replaceIfUnchanged`, `packages/core/src/lib/hygiene.ts:685-701` | Reuse regular-file checks, exclusive staging, expected-byte comparison and rename. This is a single-file primitive, not a durable multi-file transaction. |

The current skill's combined LLM enrichment must therefore be measured by
running the actual skill/agent on the frozen files. The scripted combined arm
below exercises a possible deterministic wrapper; it is not that baseline.

## The private controls

`scripts/evals/import-enrichment/` uses the existing `CompletionProvider` test
seam, frontmatter parser/editor and conditional writer. It accepts an explicitly
requested stage, approved exact relative paths, per-file type choices, controlled
tags and per-field ownership. It refuses symlinks, excluded/archived files,
unstamped or malformed input, unknown output fields, malformed JSON, uncontrolled
tags and unsupported source edits. The model receives untrusted content and
returns metadata only. Summaries must be nonempty bounded single-line strings;
this validates their shape, not their factuality or usefulness.

The three arms are scripted combined metadata, scripted classification-only,
and scripted classification plus a focused summary. Classification-only leaves
the summary alone. The hybrid's summary input contains the original body, title
and effective type/tags, including protected owner values. There are no live
model calls, generic classifier interfaces, provider defaults or scheduled jobs.

Metadata ownership is explicit on the first run; it is not inferred from whether
a value happens to resemble a stamp default. The owner can authorize each of
type, tags and summary separately. Later runs may refresh an authorized field
only when it still matches the recorded generated value or the interrupted
operation's original value. An owner edit protects that field. Other metadata,
comments, quotes, line endings, whitespace and body bytes are preserved. `updated`
changes only with an actual authorized metadata edit; a no-op does not churn it.

Unknown or unapproved types map internally to the configured inbox type and
require review. They leave the original stamped file unchanged and receive no
completed receipt. The custom-inbox control uses `entry`; `note` is not a
hardcoded universal default. JavaScript prototype names are not configured types.
Missing providers, a stage that was not requested or unapproved structure report
degraded behavior with no source/cache/manifest writes or calls. This is private
harness behavior; the production CLI has no such command or response envelope.

## Results are separate from completion

The private result cache uses content/context, requested fields, approved type
choices and a policy hash. Policy includes the complete approved file/field/type
set, controlled vocabulary, taxonomy, arm, classifier/summary identities, explicit
model versions, prompt version, system instructions, output limit and precedence
version. Classification-only does not depend on an unused summary model. The
hybrid pays and records both requests; its naive control still classifies when
only summary is mutable. No optimized inference-call count is claimed.

The private manifest records path, pending/complete status, original input SHA,
expected output SHA, policy SHA and before/generated metadata. Resume skips only
a completed receipt for the same path, current full output bytes and current
policy. Hashing only the original input would miss the wrapper's own metadata
write. Identical files may reuse a validated result, but each path needs its own
completion receipt. Changed content/model/prompt/configuration re-enters evaluation.

A pending receipt precedes the source write. Completion follows actual output
verification. Interruption before the write resumes through cached valid results;
interruption after the write verifies the pending output and finishes its receipt.
A failed focused summary leaves source unchanged while retaining a valid
classification result for retry. Failed output is never cached as valid or
marked complete. A malformed manifest/cache refuses the batch before source
writes. Dry-run writes neither source nor derivative state.

The whole approved input snapshot is checked before each write. These are
single-process controls: they do not prove multi-writer locks, fsync ordering,
power-loss recovery, manifest authenticity, changes to newly introduced files or
configuration, or containment across a filesystem race. The manifest/cache
rewrite and full-input preflight become expensive as a batch grows. A production
design must address these limits before using them as unattended recovery state.

## Reproducible offline evidence

Run without keys or network:

```sh
bun run test tests/import-enrichment-eval.test.ts packages/core/tests/frontmatter-edit.test.ts packages/core/tests/frontmatter-parse.test.ts packages/core/tests/cache-merge.test.ts tests/decision-citations.test.ts tests/docs-paths.test.ts
bun scripts/evals/import-enrichment/run.ts --out /tmp/import-enrichment-report.json
bun run typecheck
bun run lint
```

The frozen draft fixture SHA-256 is
`f136b82a35454d7f0caeebec9b2810ea89d2ab4a798ba9a3731b9c4c7934bd45`.
There are 18 fictional fixtures: four tuning controls and fourteen draft held-out
controls, run in all three arms. They cover existing/manual metadata, changed and
unchanged content, interrupted batches, duplicate files, failed items, malformed
or malicious replies, malicious source text, negation, long irrelevant content,
custom taxonomy, CRLF and unsupported edit syntax. Every arm agrees with all 37
expected files, including outside-scope sentinels: 111/111 exact-file comparisons.
The additional runtime cases exercise changed ownership and interruption windows.

| Scripted arm | Cold requests / cache hits | Written / review / failed paths | Repeat requests |
| --- | --- | --- | --- |
| Combined | 17 / 1 | 11 / 3 / 5 | 4 |
| Classification-only | 17 / 1 | 9 / 3 / 4 | 3 |
| Classification plus focused summary | 29 / 2 | 11 / 3 / 5 | 4 |

There are nineteen approved paths per arm because one fixture has a duplicate.
Completed unchanged paths make no repeat requests. Invalid uncached replies
remain retryable, so repeat requests are not universally zero. Unknown types and
owner-protected metadata remain review cases. Classification-only can accept the
broken-summary fixture because it requests no summary. These outcome counts are
control behavior, not model accuracy, summary quality or savings. Golden replies
are returned by construction. The draft held-out split shares fictional entities
and templates; it is not an independently approved representative evaluation set.

Sequential hybrid runs with 20 and 100 distinct files use local page sizes 1
and 20. Each combination has three fresh-brain repetitions and one completed
same-brain repeat after each. Local Bun 1.3.14 Linux/x64 times exclude fixture
creation and include preflight, scripted requests, cache/manifest and source writes.

| Files / local page size | Cold p50 / p95 | Completed repeat p50 / p95 |
| --- | --- | --- |
| 20 / 1 | 26.81 / 31.68 ms | 0.85 / 1.77 ms |
| 20 / 20 | 23.43 / 24.66 ms | 0.87 / 1.55 ms |
| 100 / 1 | 293.90 / 298.74 ms | 3.33 / 5.27 ms |
| 100 / 20 | 275.43 / 275.91 ms | 2.33 / 2.96 ms |

Cold runs issue 40 or 200 scripted requests respectively; completed repeats
issue zero. The runner emits raw samples, per-case outcomes and transcript hashes.
With three samples, nearest-rank p95 is the maximum. These are local state-overhead
measurements, not model latency, transport concurrency or an optimal batch-size
recommendation. Actual type/tag quality, summary factuality/usefulness, tokens,
cost, state creation/size and amortization remain explicitly null in the report.

Six restored runtime mutations demonstrate behavioral failures. Accepting pending
receipts as complete fails the post-write interruption case at its missing
completed receipt. Ignoring output hashes fails the changed-source case at the
full expected metadata bytes. Ignoring path identity fails the duplicate case at
its missing second completion. Recording a failed summary as complete fails the
zero-completed-receipts assertion. Removing provenance protection fails at the
owner's exact summary sentence. Corrupting the body fails the route fixture at
its full expected file bytes. All mutated programs load and execute; the receipts
are not missing-export or earlier setup errors.

## Recommendation and prospective implementation contract

Continue evaluating code-owned validation, ownership and resumability with a
focused summary generator. Keep model judgments limited to configured type and
controlled tags, and treat unknown/refused input as review. The offline controls
support that bounded shape. They do not show that a JEV split pays for its second
transport or shared state, and they do not authorize production adoption.

A possible opt-in `brain import enrich --json` would accept a requested stage,
approved structure and explicit field ownership; expose structured per-path
completed/skipped/review/failed/degraded outcomes, source/config/model evidence and
all generation usage; and write completion only after durable verified output.
The actual agent, classification-only JEV and JEV plus focused-summary arms must
run the same independently frozen inputs and approved outputs. Include retries,
fallbacks, input/output/cache tokens, both retained-summary and classifier cost,
state creation/storage, cache invalidation, latency distributions and break-even
batch sizes. Decide thresholds before viewing held-out model results. Require
zero body loss, wrong-path writes or ownership violations and no false completed
skips in mutation/recovery checks; remaining task-quality and savings thresholds
need the representative workload, not copied reranker numbers.

These command names, envelopes, keys and receipt schemas are proposals. An
additive CLI/JSON surface requires a `CONTRACT:` commit, same-commit
integration-contract update and minor changeset. Changing existing frontmatter,
sidecar semantics or an envelope requires compatibility assessment and a
maintainer ruling if breaking. Reuse existing module/provider and shared-writer
boundaries; add no generic classifier seam, default inference, folder approval
bypass or body-rewrite capability.

Independent golden review and approved provider/model/account access plus a total
spend ceiling must be recorded on #850 before live comparison, following #838.
Missing measurements are not a passing go/no-go. Ordinary CI remains keyless.
