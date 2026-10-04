# Unkeyed canonical conflicts: candidates, judgments and authority

Source discovery for [#843](https://github.com/schlessera/brain-kit/issues/843),
under [#838](https://github.com/schlessera/brain-kit/issues/838)'s protocol,
on 2026-10-02 at main `88449438b5557df4ddf9c38445d2dffa36dac750`.
The private controls are report-only and make no paid requests. Production
commands, skills, audit totals and contracts are unchanged.

## Existing behavior

The skill's unkeyed pass reads configured canonical anchors, skips sources with
a `facts:` map, extracts short structured facts and searches eligible secondary
documents. It requires the same subject, a contradiction and a canonical update
at least seven days newer (`## Phase 2`,
`packages/core/skills/content-hygiene/SKILL.md:37-69`). These are agent instructions,
not an implemented unkeyed conflict detector or CLI repair handler.

Its separate replacement instruction requires a gap greater than thirty days,
a fragment of at most two lines and obvious contextual substitutability
(`## Phase 3`, `packages/core/skills/content-hygiene/SKILL.md:71-99`). Neither
high model confidence nor an old secondary timestamp establishes substitutability
or grants permission. This investigation proposes no unattended replacement.

Keyed fact drift already executes in code. It reads configured `taxonomy.facts`,
the source's frontmatter and regex captures; it excludes source/archived documents,
ignores captures touching code and respects each document's `facts_ignore` keys
(`findFactDrift`, `packages/core/src/lib/auditor.ts:412-470`). That path is not
replaced by this experiment. The existing hygiene reconciliation accepts extra
`{category, path, evidence, message}` candidates and owns their Markdown state
(`reconcile`, `packages/core/src/lib/hygiene.ts:704-725`).

A separate keyless source control found that keyed numeric comparison can collapse
two distinct quoted values beyond JavaScript's integer precision. The actual
detector returned zero drifts for canonical `9007199254740992` versus
`9007199254740993`, while `9007199254740994` returned one. This existing defect is
tracked in [#863](https://github.com/schlessera/brain-kit/issues/863); the private
exact-decimal control below does not fix keyed production detection.

## Private preparation

The draft extractor intentionally supports two narrow top-level forms:

```text
Odysseus | Role | navigator
Odysseus: Status = active
```

Fields are Role, Status, Date, Count and Employer. The complete raw files are
read before extraction; only short paragraph lines match. GFM fences, blockquotes,
inline code and HTML-like text are excluded. Core's existing frontmatter length
and GFM block parser supply offsets (`frontmatterLength`,
`packages/core/src/lib/document-parts.ts:74-83`; `topLevelBlocks`,
`packages/core/src/lib/document-parts.ts:125-135`). Offsets are JavaScript string
offsets into the exact raw file, not UTF-8 byte positions or inferred quotes.

Configured canonical paths, taxonomy exclusions and the configured inbox directory
are resolved through existing core helpers. Archived/historical metadata,
archive path segments, hygiene-log paths, unreadable/malformed sources and unknown
types stay out. The private control conservatively abstains on any `facts_ignore`
field; it does not define a production mapping for unkeyed exceptions. Literal
calendar `updated` dates must parse and match their original scalar, cannot be in
the future, and must establish the seven-day gap. YAML Date objects are normalized
without accepting a parser's rollover of an invalid date.

The fake judge receives both complete documents and exact candidate spans in both
orders. Same-subject judgments must affirm both orientations. For Role, Status
and Employer, contradiction must also affirm both. For literal Count and ISO Date,
code compares exact decimal strings/calendar dates; a wrong contradiction answer
cannot turn equivalent numbers into a conflict or suppress a literal difference.
Decimal normalization preserves values beyond JavaScript's integer precision.
Unsupported units, exponent notation and non-ISO date values remain manual.
These fake answer objects are a private control format, not a TypeSafe API schema.

Malformed, missing, throwing and unknown answers abstain. Extra output fields,
including replacement/authority/confidence claims, are refused by the strict
control schema. A valid but wrong semantic answer can still produce a wrong
report: scripted answers do not prove prompt-injection resistance or vendor
correctness. No classifier decides which file is canonical, dates, permission,
truth or a replacement operation. No thresholds are borrowed from
[deterministic sync](decisions/deterministic-sync.md) or D42.

Abstention or incomplete retrieval is not evidence that an existing conflict
disappeared. A future adapter must retain findings through the existing
failed-check reconciliation path rather than treating an empty candidate list
as successful clearance. A real log control retains an existing conflict after
an unknown answer by explicitly marking the check incomplete. This reuses
existing reconciliation; the prototype does not ship that semantic adapter.

Before emission, current file hashes, original raw hashes, exact slices and
membership in extracted spans are rechecked. Configured authority is rechecked
as well. Changed or invented evidence emits nothing. This is a snapshot check
in an isolated evaluation; it supplies neither a production lock nor a
cross-file transaction and cannot guarantee against a subsequent concurrent edit.

## Keyless controls and limitations

```sh
bun run test tests/canonical-conflict-eval.test.ts
bun scripts/evals/canonical-conflicts/run.ts
```

Twenty-one draft Odysseus pair cases cover paraphrase, different subjects,
changed roles/status, historical metadata and text, negation, numeric equivalence
and differences, dates, unset/keyed anchors, small/reversed recency gaps,
unknowns, malicious evidence/output, order disagreement, inbox and fenced text.
Three tuning cases use a pipe grammar; eighteen held-out cases use other groups
and the colon grammar or deliberately unsupported prose. Both splits share
Odysseus and the configured schema; they are not independently reviewed or a
complete held-out semantic benchmark. Live preparation must expand and freeze
independent document/entity/template groups before tuning.

On the draft labels, five of six semantic positive pairs are retrieved; one
known prose conflict is deliberately missed. This exposes the narrow grammar's
coverage ceiling, not a measured production retrieval recall. Control expectation
matches and scripted-call counts say nothing about live precision, coverage,
subgroup errors, calibration or total inference savings. Those metrics remain
null; adoption is unmeasured and replacement is not proposed.

Real tests carry emitted candidates into existing Markdown reconciliation,
read the persisted log, verify original content byte-for-byte and repeat without
duplicate entries or timestamp churn. Three separately restored mutations failed
the intended persisted-log assertions:

| Removed guard | Actual failing assertion |
| --- | --- |
| Same subject in both orientations | Expected no conflict log entry, received an open `conflict-profiles-record-d4e1`. |
| Seven-day recency | Expected no conflict log entry, received an open `conflict-profiles-record-8668`. |
| Exact/current evidence provenance | Expected no conflict log entry after the secondary fact changed, received an open `conflict-profiles-record-d4e1`. |

A fourth restored mutation removed the incomplete-check marker from the test
adapter. The retention assertion failed with one resolved finding instead of
zero. This demonstrates the existing reconciliation integration requirement,
not an automatic connection between the private judge and a production check.

These prove finding/log guards in the fixture runtime, not safe content-replacement
execution. There is no replacement writer to validate. Any later unattended
replacement evaluation needs its own real writer, wrong-target/content-loss veto,
authorization and recovery evidence.

## Identity and review boundaries

The candidate uses `category: conflict`, the secondary path and the canonical
fact text as stable evidence, matching the existing skill. Its ID comes from
`hygieneId` (`packages/core/src/lib/hygiene.ts:97-100`); no competing lifecycle
or disposition store is created. Full-file hashes expire an in-flight snapshot,
while an unrelated heading edit preserves freshly computed finding identity.
A changed secondary span retains that identity but changes a separate inspection
digest of the two facts and configured anchor.

That digest is not an approved production evidence fingerprint. The
[hygiene-review decision](decisions/hygiene-review.md) still binds #597's explicit
equivalence mappings, contributing provenance, severity/known-urgency ordering
and relevant-evidence invalidation. A future conflict adapter must specify which
authority, semantic spans, eligibility and source facts enter its fingerprint;
whole-document hashes, clock-only age and unrelated edits cannot reset a review
disposition. Relevant evidence changes may invalidate a disposition while keeping
the same stable finding. This experiment implements no dismissal, snooze,
Actions UI or repair authorization.

## Required comparison and decision

Before any live request, record authorized providers/accounts/exact models,
credential availability and total spend ceiling on #843. Independently review
ambiguous goldens. Freeze candidate extraction, questions, task gates and tuning
split; compare the current agent pass, deterministic baseline and proposed hybrid
on identical complete fixture brains. Measure retrieval misses independently of
judgment errors, conflict precision/recall, abstention/coverage and subgroup errors.
Record model/runtime/fixture/prompt identities, order consistency, repetitions,
all calls/tokens/cache, retries/fallback, billed/effective cost and p50/p95/spread
under #838. Verify model availability and pricing at run time. Calibrate task
thresholds on tuning data and freeze before held-out evaluation.

Recommendation for a first evaluation is report-only with no replacement effect.
It still needs a measured go/no-go; neither adoption nor rejection follows from
these controls. If accepted, file the smallest concrete CLI candidate/report
scope under #838, assess new CLI/JSON/frontmatter behavior against the
[integration contract](integration-contract.md), and keep review semantics/UI
under #597. Any fragment-replacement proposal is a separate, explicitly assessed
effect with zero wrong-replacement/content-loss tolerance and the full permission,
premise, post-check and recovery requirements. Add no generic classifier or
canonical-repair extension seam.
