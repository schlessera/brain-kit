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
is `8fbfafbcae0e5545d302ad117c7d9b3a326330d41d638b015a4d993d03a5a56e`.
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
13.67/16.43 ms p50/p95 with explicit input, and 15.81/16.37 ms with scripted
choices. Three fresh-brain samples per arm exclude fixture creation and include
capture, validation, staging, projection and application. Raw samples are
13.66609, 13.63529, 16.42837 ms and 16.37395, 13.69710, 15.80609 ms.
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

## Fresh source-grounded preparation (2026-10-08)

The later scoped harness uses Bun 1.4.2, SDK 0.3.293 and native CLI 2.1.293.
These are a fresh instrument; the earlier SDK 283 freeze and absent uncommitted
correction files do not verify these bytes. The original 21 workflows and ten
draft emails remain unchanged regression controls.

The new author-provisional corpus has nineteen complete fictional brains, three
tuning and sixteen held out. Assembly, submission, talk and message identities
are disjoint. Expected states are authored separately from the planner and
materialized through the historical fixture-side literal table compositor.
Shared projection grammar, recurring world vocabulary and sparse tuning remain
limits; identity separation alone does not establish independent semantic
coverage. The cases include separate mixed decisions, backup-to-acceptance,
literal conditions and deadlines, revision pending decision, unknown/ambiguous
targets, quoted injection, withdrawal, delivery, explicit closure and replay.
Review on 2026-10-09 added the held-out outcomes that were missing: two plain
rejections and a negated acceptance (`not rejected; it is accepted`), one of
which names the target only by its document title rather than its slug, so
target resolution is no longer pure identifier matching. Every other source
still names the slug verbatim; that remains a generalisation limit. The same
review removed an arm-dependent expected state: the mixed-date case is graded
as a supported acceptance in every arm, and the bounded parser's abstention
there is scored as coverage loss rather than encoded into the golden.
Every source brain retains the full message, unrelated submissions, original
abstracts, talk notes, travel record, persisted config and binary sentinel.

Real `initContext` loads the persisted fixture config and the actual speaking
module declaration through a contained fixture wrapper referencing the frozen
runtime. Its custom tablet type and speaking exclusion contribution are checked.
No captured in-memory taxonomy substitutes for that config. Each structured
operation performs a real plan/write/dry-run/replay, compared against complete
expected file bytes. Closure replay refuses already archived inputs without
writing; it is not a successful new closure transition.

The bounded prospective classifier request receives complete candidate source
documents and the untrusted message, without split or expected labels. Both
selected-choice probability and confidence must clear a tuning-only floor;
an uncalibrated floor stays null. Only literal labelled decision dates,
confirmation/slides deadlines and conditions have extraction authority. An
additional unparsed prose/ISO date or condition causes abstention even alongside
supported fields. This deliberately trades coverage for an auditable boundary;
it is not a general natural-language extraction solution. Explicit
accepted-with-condition and requested revision before a future decision remain
distinct experimental cases, not a new production policy.

Every classifier proposal is unconfirmed. A separate owner's confirmation must
bind the entire exact payload hash before the real writer can run. A confident
wrong target can still be proposed by an inaccurate classifier; the comparison's
independent source-supported target grade and destructive-error veto must detect
that. Confirmation is counted as human work, not supplied by a model answer.

A full descendant observer records regular binary bytes, membership, modes,
contained symlink targets and nanosecond modification times before applying the
existing experimental writer. Changed evidence/config/new files and even a
same-byte one-nanosecond touch veto a nonempty batch. This is a preflight control,
not an atomic transaction or protection against a concurrent edit after the
snapshot. Root-directory metadata is outside this observer. Production locking,
complete conference archive manifests, durable history and crash recovery remain
the earlier design limits.

Injected offline transport controls execute the actual core Jev client and
retain literal physical request/response bytes before decoding, including binary
HTTP errors and malformed answers. Nonzero output usage is retained even though
the pinned documented input-only price makes output free. Cache usage and actual
invoice charges remain null when not reported. Unknown physical usage/model
stops subsequent dispatch. These controls have no live entry point and supply no
Jev quality or billing result.

The prospective comparison uses the current installed outcome/aftermath skills,
explicit owner inputs and Jev proposals plus exact confirmation/code. Current
skill output is graded semantically across affected layers; its layout must not
be forced into the candidate's private field/region representation. The core
runner's omitted permission mode selects native auto: #1275 records why complete
auxiliary-call accounting is required before admitting that baseline. No manual
mode is substituted. The approved models and actual-charge caps remain recorded
on #846/#838; a quota hold does not remove review or accounting prerequisites.


## Complete task and native preparation

The nineteen task brains are now concretely materialized at 3, 32 and 128
complete candidate documents. Added candidates are unchanged neutral submissions
in the existing secondary assembly. Historical acceptance/backup records form
the same task-before state in every arm; replaying those setup decisions is
excluded from task work. The older sequence regressions remain unchanged.
Candidate/context token capacity and retrieval throughput are still unmeasured.

Task facts are independent of candidate parsing. Hermes's mixed-date source
supports acceptance; its unrelated return date supplies no submission deadline.
The bounded hybrid parser safely abstains, which is fallback and coverage loss.
The current skill may record that acceptance using its existing summary, tables
and timelines. A private generated region or frontmatter field is not required
for semantic success. All author-provisional facts still require complementary
review, including their fixture-world assumptions and shared representation.

The new collector has no live entry. It executes complete real setup/index,
owner-confirmed code and the actual core Jev client with injected responses.
It retains whole failed/partial after trees, literal physical attempts, unknown
usage and invoices. A missing native/physical result stops admission; a model
proposal refusal is separately counted as abstention. Immediate archived closure
replay safely refuses without writing, rather than producing a second closure.
Offline elapsed times include setup and controls and are not model performance.

The isolated native controls run the actual core subscription CLI route on
SDK 0.3.293 / CLI 2.1.293. No permission mode is substituted: initialization
reports auto. Actual skill/submission reads and forbidden writes exercise its
real tool execution. A full 32-candidate native collector control preserves
all files and reconciles every terminal physical token counter with final
canonical Sonnet 5.5 model usage. Raw stdin/stdout/stderr, exact request/response
bytes, errors, nullable cache/usage, EOF, consumer cancellation and group drain
are preserved. Refused local HTTP attempts are retained separately from
forwarded calls. Known price subtotals do not turn missing usage or invoices
into zero. Frame/assistant/prompt/tool and physical first-byte observations use
real monotonic clocks.

An actual Bash control reproduces [#1275](https://github.com/schlessera/brain-kit/issues/1275):
the native auto classifier attempts a local Sonnet 5 request despite Sonnet 5.5
aliases. The relay refuses it before forwarding; the command remains denied
and the whole fixture unchanged. This is an offline negative control, with
no real provider request or classifier usage/billing claim. Direct shipped
`brain config check`, `read` and three archive commands separately preserve
source bytes and archive semantics; they do not establish a successful native
agent baseline. Live current-agent scoring remains refused until the actual
auxiliary route, model, usage and permission policy are verified.

Only the brain CLI child uses the July 12 fixture clock. Native authentication,
provider clocks, lifecycle deadlines, performance and physical file mtimes
remain real. No writer timestamp is normalized. These outcome controls do not
use wall-clock file age as repair-quality credit.

Grading treats an unchanged brain on a source that requires clarification as
the completed task for every arm, and any unsafe effect (wrong target, content
loss, unsourced deadline, early archive, unexpected file) as a failed task even
when no annotation exists; only a safe, unannotated result stays null. Earlier
drafts scored both as null, which would have hidden the issue's destructive
veto behind a missing annotation and denied credit for correct abstention.
Current semantic grading requires an independently supplied annotation bound to
the complete source, task facts, rubric and before/after trees. Each field needs
content citations. Missing annotations produce null quality; matching a model's
own output never supplies approval. Existing ownership metadata, abstracts,
talks, unrelated documents and full binary/member/mode/mtime effects remain an
independent veto. Whole-file archive scope and production transaction/locking
limits still apply. The synthetic annotation controls prove binding and veto
mechanics, not annotator correctness or authorship.

The source freeze binds all seventeen workspace source/manifests, complete
installed JavaScript dependencies and link/mode metadata, outside-hardlink
refusal, owned scripts/tests and exact Bun/SDK/native bytes. General OS libraries
and the kernel remain outside this byte closure. Complete case/source review
packets partition without truncation; their byte ceiling is an operational
bound, not a claimed model context limit. Actual no-tools review admission
reparses collected raw prompt/auth/model/usage/text/EOF/runtime artifacts. An
actual scripted APPROVED receipt remains ineligible even if metadata flags say
otherwise. This is not an invoice or cryptographic artifact-owner attestation.

Nine additional restored mutations fail at the intended runtime assertions:
full-tree prewrite veto (protocol complete becomes true after a changed binary),
outer unknown-use stop (one injected dispatch becomes twenty-four), refused
request capture (one literal attempt becomes zero), streaming UTF-8 (π becomes
replacement characters), final unterminated result (result text disappears),
owned forced termination (actual drained becomes false), terminal physical/native
usage reconciliation (inflated final output no longer throws), added owner
metadata (unauthorized ownership no longer vetoes), and actual scripted review
admission (the native control throws because its fake APPROVED was admitted).
These are additional to the earlier independent deterministic-effect controls.

There is still no complementary semantic approval, actual classifier comparison,
calibrated floor, measured quality/latency/savings or adoption result. The global
Claude hold and fresh root accounting/window admission remain required, together
with resolution of #1275 for current-agent scoring. Original empirical criteria
remain open.


The fresh model-visible corpus uses neutral secondary/distractor identities and
source titles. Case/split labels remain solely private scorer/review metadata.
An actual materialization/request failing-first found those labels in emitted
files; all 57 complete disk states and prospective Jev requests now exclude them.
The newly authored sources use the established cast. Delivery is explicitly
remote and does not relocate Odysseus from Ogygia. Shared world vocabulary is
still a generalization limit, and the original regressions are unchanged.
The fixture CLI read policy checks contained operands and rejects root/output
configuration overrides; an actual native denied outside-sentinel control
proves that boundary while preserving auto policy.


## Atomic archive directory effects

The maintainer ruling on [#1450](https://github.com/schlessera/brain-kit/issues/1450)
qualifies the private effect guard after production archive adopted atomic
staging and replacement. Direct archive, native archive and full grading permit
only an incidental `mtimeNs` change on the exact parent of a performed authorized
source replacement. The replacement must match independently expected resulting
bytes and mode. A potential target, an arbitrary changed file or alternative
observed content cannot authorize directory metadata. Directory kind, mode and
complete descendant membership remain invariant; unrelated timestamp changes,
links, source loss and leftover temporary members remain violations.

Complete before/after snapshots retain the raw parent timestamp change. No
normalization or generic directory exception is used. Original independent
semantic review, source-supported task facts, layouts, disposable-cache bounds
and accounting criteria remain binding. The additional actual native archive
control is required in both keyless packet preparation and paid proof admission.
This compatibility rule supplies no inference, semantic approval or adoption.


The same ruling explicitly qualifies the newly required native archive cache
control: only the existing regular `brain.db`, `brain.db-wal` and `brain.db-shm`
files may change disposable bytes and timestamps. Kind, mode and membership
remain invariant. Direct/full/native guards use this exact bounded rule; cache
changes never license directory metadata. Other native modes remain unchanged.
