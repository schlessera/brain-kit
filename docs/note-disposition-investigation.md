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

Do not adopt an unattended hybrid on these controls. Its precision, escalation,
retention, malformed-operation rate, model work saved, tokens, cost and latency
remain unmeasured. The offline report prints those live metrics as null.

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
