# Speaking lifecycle: source discovery and offline controls

This investigation for [#846](https://github.com/schlessera/brain-kit/issues/846)
examines deterministic outcome, delivery and closure updates. Source was inspected
at `f394c0f6aa17142e3b7b5781e2f7cb771ae935b9` on 2026-10-02. The private
evaluation uses disposable fictional brains. Proposed fields below exist only
in those fixtures; this investigation establishes no production schema or
classifier adoption policy.

## Existing authority and projections

| Current operation | Source | Structured data still needed |
| --- | --- | --- |
| Create a submission; update hub and conference index | `## Actions`, `packages/module-speaking/skills/new-submission/SKILL.md:19-64` | Stable submission, conference and talk identities and their relationships. |
| Record outcome in hub table/timeline and submission summary | `## Actions`, `packages/module-speaking/skills/submission-outcome/SKILL.md:18-49` | An authoritative outcome and dated history separate from document `status`. |
| Project mixed outcomes into conference/proposal registries and accepted work into focus | Same outcome actions | Structured dates, conditions, delivery and closure evidence; explicit managed regions in existing documents. |
| Record delivery, then archive after the conference | `## Actions`, `packages/module-speaking/skills/conference-aftermath/SKILL.md:21-71` | Delivery identity/date, explicit event closure and a complete archive manifest. |
| Render typed frontmatter columns with deterministic ordering | `renderRegistry`, `packages/core/src/lib/index-registry.ts:117-148` | Suitable already for IDs, outcomes, dates and conditions. Aggregation across submission records still requires domain code. |
| Preserve human prose around a generated region | `rewriteGeneratedRegion`, `packages/core/src/lib/generated-regions.ts:151-161` | An explicit migration must designate ownership of old handwritten tables. |
| Archive and adjust relevance while preserving other fields | `archiveDocument`, `packages/core/src/lib/archiver.ts:57-99` | Reuse this operation; direct status changes miss archive semantics. |

The current submission summary and table text mix presentation with state.
Neither a status word in prose nor the most recent decision is a safe source
for a mixed-conference aggregate. Active/archived document status has a different
meaning from accepted/rejected/waitlisted/backup. A rejection keeps the conference
active while other submissions or next steps remain live.

## Private deterministic design

The prototype proposes submission frontmatter `submission_id`, `conference_id`,
`talk_id`, `speaking_outcome`, `outcome_date`, `confirmation_deadline`,
`slides_deadline`, `speaking_conditions`, `delivered_on` and decision receipts.
Hub frontmatter proposes `conference_start`, `conference_end`, `conference_phase`
and a generated mixed `outcome_summary`. Existing hub `deadline` projects the
nearest recorded deadline for an accepted, undelivered active submission.
Talk documents provide a unique `talk_id`. These are experimental field names.

An explicit owner-confirmed input identifies the exact submission/conference,
outcome and date. Code validates unique identities, configured directories,
relationships and lifecycle dates before staging edits. Missing, ambiguous,
archived or unconfirmed targets refuse the entire plan. Proposed deadlines are
accepted only as valid date-only values present in exact labelled source lines;
"soon" never becomes a date. Conditions remain explicit owner input.

The submission record is authoritative. The hub table, conference index,
proposal registry, delivery registry and designated focus region are projections.
Backup followed by acceptance retains both dated outcomes. Withdrawal removes
accepted work from focus. Delivery requires acceptance and a date within the
event interval; it adds one delivery row per conference/talk/date and removes
that task from focus, while leaving documents active. Explicit confirmation
that the event is over allows closure at or after its recorded end date.

Planning runs the real core archive helper on a disposable copy, then pins its
wall-clock `updated` value to the fixture date. Closure archives the identified
hub and submission records and verifies relevance demotion. This bounded control
does not enumerate every possible conference document or perform production
reindexing. It preserves other conferences, talk content, abstracts, human prose
outside managed regions and travel records.

The private writer reused from the mechanical-hygiene evaluation rechecks every
captured Markdown input's bytes, mtime and regular contained path before writing.
A changed read-only evidence file vetoes a nonempty batch. Dry-run preserves
bytes and mtimes. Repeating each decision at its own stage writes nothing;
replaying an entire historical sequence is not an idempotent current-state sync.

This writer has no durable multi-file transaction. It attempts rollback after
synchronous failure; concurrent changes between preflight and replacement,
process death, interrupted rollback and newly added files/configuration still
require production lock/recovery design. The scalar history and last-decision
receipt are controls, not a durable event log. Deadline completion, same-day
corrections, late delivery after closure and complete conference archive manifests
need explicit design before a production implementation.

## Classifier boundary

Draft questions expose outcome choices accepted/rejected/waitlisted/backup/unclear,
conference and submission shortlists with `none`, and the untrusted email with
candidate identities. Code checks that all returned choices agree with the
separately confirmed explicit input and each other. Invalid, missing, low-confidence,
unclear or no-match responses abstain. Classification never supplies deadlines,
archive authorization or prose changes.

The scripted hybrid controls supply known choices; their confidence floor of
0.9 is only a fault-injection parameter. It is not a calibrated threshold.
They do not measure JEV accuracy or establish prompt-injection resistance.
Even a confident wrong answer consistent with a wrongly confirmed input can
target the wrong real submission; this risk vetoes unattended adoption.

This boundary follows an inference from TypeSafe's [atomic-judgment guidance](https://docs.typesafe.ai/introduction)
and [model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13), checked
2026-10-02: code must enforce relationships and dates. Its documented
[confidence](https://docs.typesafe.ai/confidence) measures concentration among
answers, not correctness. Independent target/outcome answers still require
cross-checking and abstention.

## Offline evidence

Run without network or keys:

```sh
bun run test tests/speaking-lifecycle-eval.test.ts
bun scripts/evals/speaking-lifecycle/run.ts
bun run typecheck
bun run lint
```

The draft fixture SHA-256, including concrete input/expected bytes and email labels,
is `6aac09713c9fa05209675189b16f29a09bd64dcc8b7e46793cd3af49bc0a8a1c`.
The generated draft classifier request SHA-256 is
`48932a43337478f3bd35c3035afcf238aaaaf1268c0ae33a2ff27c22f8446bc8`.
There are 21 workflow cases: four tuning controls and 17 draft held-out controls.
The latter change directories, document names, titles and talk identities but
share the identity vocabulary and table template. Ten additional draft emails
cover negation/minimal pairs, backup, conditions without a date, unknown and
ambiguous targets, long irrelevant text and instruction injection. These labels
have not had independent golden review or representative held-out separation.

| Observed outcome | Explicit deterministic input | Scripted hybrid control |
| --- | --- | --- |
| Exact expected all-layer file bytes | 21/21 | 21/21 |
| Dry-run byte/mtime diffs | 0 | 0 |
| Immediate repeat-decision byte/mtime diffs | 0 | 0 |
| Untouched-file mtime churn | 0 | 0 |
| Inference calls | 0 | 0 |
| Actual agent/JEV target and outcome precision, cost and savings | Unmeasured | Unmeasured |

On Bun 1.3.14, the two-decision mixed workflow over 13 source documents took
13.86/14.93 ms p50/p95 with explicit input, and 15.72/18.21 ms with scripted
choices. Three fresh-brain samples per arm exclude fixture creation and include
capture, validation, staging, projection and application. Raw samples are
13.86472, 13.05188, 14.92658 ms and 15.71914, 13.66071, 18.20693 ms.
The nearest-rank p95 is the maximum of three samples, not a stable tail estimate.
This measures local code, not agent work or model latency/cache behavior.

Six restored mutations fail at the intended runtime assertion: omit proposal
projection (exact proposal bytes); remove target relationship validation (unchanged
submission bytes); remove exact deadline-source validation (unchanged submission
bytes); remove event-completion validation (active submission bytes); remove
delivery deduplication (expected one row, received two); and ignore stale preflight
(complete changed-evidence snapshot). Each mutated program loads and runs.
The suite also exercises missing/unclear answers, invalid source dates including
a body spoof, duplicate identities, malformed/unmanaged regions and archived targets.

## Recommendation and eventual adoption evidence

Continue evaluating explicit deterministic lifecycle operations. Do not adopt
unattended classification from these results. There is no measured agent baseline,
JEV run or comparative cost/work reduction, so the live go/no-go remains open.
The eventual comparison must use identical reviewed inputs across today's actual
agent skill, explicit code and code plus actual JEV. Freeze prompts, model/runtime
versions, labels and document/entity/template splits before tuning. Record all
calls, input/output/cache tokens, retries/fallbacks, billed/effective cost, and
end-to-end p50/p95, including larger candidate states and ambiguous cases.

Predeclared gates are zero wrong-target/deadline/permission/content-loss errors,
100% accepted all-layer diffs, correct mixed histories and lifecycle timing,
preserved dry-run/repeat behavior and abstention on ambiguous cases. Any wrong-target
edit vetoes unattended adoption. Precision/coverage and confidence cutoffs require
reviewed live evidence; comparative efficiency must improve without worse outcomes.

A minimal future implementation should keep authority in submission Markdown,
add validated IDs and structured lifecycle evidence, migrate only explicitly
approved generated regions, and preserve existing summaries/prose for compatibility.
Missing or ambiguous historical data should remain unknown for owner review;
no wholesale rewrite or inferred deadline is justified. New CLI JSON/frontmatter
semantics would require a `CONTRACT:` commit, same-commit contract documentation
and minor changeset. Changed existing semantics require compatibility review and
a maintainer ruling if breaking. No provider, generic seam or new default is proposed.

Travel lifecycle and linked-journey sync remain owned by
[#569](https://github.com/schlessera/brain-kit/issues/569); its photo/route operations
and canonical formats already have separate owners. Speaking may offer that
workflow and preserve journey links. Travel archive evidence must be obtained by
that workflow before closing a journey, rather than treating a conference outcome
as proof. Retrospectives, takeaways, resubmission discussion and publishing advice
remain skill judgments. Live access/provider/account/model, independent golden
review and an explicit total spend ceiling must be recorded on #846 before any
paid comparison, as required by [#838](https://github.com/schlessera/brain-kit/issues/838).
