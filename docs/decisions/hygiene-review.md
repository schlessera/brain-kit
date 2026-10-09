# Decision — deterministic hygiene review and durable dispositions

The maintainer settled three policies on #597 on **2026-10-01**:
[ordering A](https://github.com/schlessera/brain-kit/issues/597#issuecomment-5936196109),
[canonical identity A](https://github.com/schlessera/brain-kit/issues/597#issuecomment-5936732700)
and [evidence invalidation A](https://github.com/schlessera/brain-kit/issues/597#issuecomment-5937198015).
They bind selection, reconciliation and dismissal/snooze in human-triggered
asynchronous hygiene review. This record explains the approved policy. The
identity, fingerprint and disposition definitions that implement it are in
[What the implementation defines](#what-the-implementation-defines) (#1024);
selection and the review interface are not built yet.

The [shared Queue/Actions decision](async-collaboration.md) continues to govern
durable Action identity, validated effects, authorization, idempotency and
recovery. Hygiene review consumes that lifecycle without replacing #51's complete
autonomous scope or its enablement gates. These rules select hygiene findings
within a review; they do not redefine general autonomous Queue scheduling.

## Why a review needs these rules

Validation and audit can describe the same defect through different sources.
Showing both as separate review items makes the owner answer twice. A queue
ordered primarily by category can offer an informational marker before a more
severe eligible problem. A dismissal that reconciliation immediately reopens,
or a snooze reset by an unrelated edit, makes the owner's decision temporary.

Reuse the existing markdown log and deterministic CLI operations. A candidate
already carries category, path and stable evidence (`HygieneCandidate`,
`packages/core/src/lib/hygiene.ts:61-77`), and its ID derives from those fields
(`hygieneId`, `packages/core/src/lib/hygiene.ts:172-175`). Those primitives do not
by themselves supply validation-to-hygiene equivalence, priority selection or
review dispositions. The existing CLI exposes reconciliation and listing
(`hygieneCommand`, `packages/core/src/cli/commands/hygiene.ts:153-155`).

## Selection: severity and known urgency, then age and identity

Among eligible findings, source severity and explicitly known urgency determine
priority before age. Within equal priority, choose the oldest finding; stable
finding identity breaks the remaining tie. The review must explain the selection.

[The audit-marker decision](audit-markers.md) keeps errors and warnings in
must-fix totals, and infos in informational totals. TODO/VERIFY markers remain
informational; review ordering must not silently promote them into defects.
More severe eligible findings can keep lower-severity work waiting. Category
precedence is not the primary ordering rule.

An implementation must publish deterministic mappings for each source's severity,
known urgency and missing inputs. An absent urgency value remains unknown; no
model guesses it, and no undocumented default turns it into a known measurement.
This ruling does not choose numeric weights, category rankings or the exact
missing-input mapping. Tests must exercise those mappings and the equal-priority,
equal-age and missing-urgency cases.

Eligibility excludes genuinely resolved findings, unchanged dismissed findings
and snoozes whose due time has not arrived, subject to the invalidation policy
below. For unchanged semantic evidence, source-order changes, reconciliation and
restart must preserve the same finding identity.

## Identity: one problem, contributing sources, one disposition

Equivalent validation and hygiene reports become one canonical finding identified
by **category, path and stable evidence**. Keep each contributing source's
provenance, show the problem once and attach one durable disposition to it.

Equivalence requires explicit deterministic mappings between source findings.
Matching a path, similar prose or a model's impression is insufficient. A broken
link and a missing required field in the same document remain separate problems.
Two different broken targets also remain separate unless a documented equivalence
rule establishes that they report the same underlying defect.

Canonicalization must be independent of source enumeration order. Reconciliation
and restart must preserve the finding and its disposition, rather than minting
duplicate findings or Actions. Implementation evidence must include both equivalent
reports with nonempty provenance and distinct problems on the same path.

## Dismissal and snooze: preserve the decision until relevant change

Dismissal means the owner declines review of the current finding/evidence. It
survives reconciliation of the unchanged problem. Snooze records a visible due
time: an unchanged finding becomes eligible when that time arrives.

Either disposition becomes invalid when deterministic evidence shows a change
in the finding's relevant evidence, source severity or explicitly known urgency.
Such a change can make a finding eligible before its old snooze due time.
Unrelated document edits, presentation changes and the passage of time used only
to calculate age preserve the disposition. Reaching the recorded snooze due time
is eligibility returning on schedule, not evidence invalidation.

Define a category-specific **evidence fingerprint** separately from canonical
stable identity. Identity answers which problem the record names; the fingerprint
answers whether the premise for its disposition still holds. Source adapters
must specify what evidence enters each fingerprint and what is excluded. A
whole-document hash is not a substitute for that definition. A relevant change
may also change the stable evidence that names a finding; the implementation must
handle that relationship explicitly, without requiring every content revision
to become a new identity or carry forward an obsolete disposition.

For example, Odysseus has a broken wiki-link in `journeys/return-to-ithaca.md`.
The examples below bind the required behavior, not a chosen storage schema,
serialized fingerprint format or complete equivalence map:

| Observation | Review consequence |
| --- | --- |
| Validation and hygiene both report that same unresolved target | One canonical finding with both sources retained and one disposition. |
| Odysseus dismisses it; an unrelated heading elsewhere in the document changes | Preserve the dismissal; unchanged relevant evidence does not re-enter review. |
| The broken-link target changes to another unresolved target | The prior disposition no longer suppresses the changed problem. |
| Its source severity or explicitly known urgency changes | Invalidate the disposition deterministically, even if its path is unchanged. |
| Odysseus snoozes it; only its age increases before the due time | Preserve the snooze until due. |
| Its relevant evidence stays unchanged and the snooze becomes due | Make the finding eligible again on schedule. |
| Its target changes before the snooze is due | Permit review of the changed problem before that previous due time. |
| The document also has a missing required field | Keep that distinct finding and its disposition separate. |

## What the implementation defines

#1024 fills in what the policy above leaves to the implementation: the
equivalence map, the fingerprints and the storage. The `brain hygiene` JSON
shapes are in [the integration contract](../integration-contract.md#hygiene-review-data-additive-1024).

**Equivalence map.** Each `brain validate` rule becomes a candidate with a
category and ID evidence (`VALIDATION_JOIN`,
`packages/core/src/lib/hygiene.ts:190-203`). Validation gives the join a
structured detail, so the message is never read (`export interface ValidationDetail`,
`packages/core/src/lib/validate.ts:43-51`). Candidates are one finding exactly
when category, path and evidence agree, and the join does not depend on their
order (`canonicalFindings`, `packages/core/src/lib/hygiene.ts:265-314`).

| Validation rule | Category | ID evidence | Joins |
| --- | --- | --- | --- |
| `link-unresolved` | `broken-link` | the target as written | audit's `broken-link`, the one cross-source equivalence |
| `required-missing` (`title`, `type`, `created`, `updated`, `tags`), `type-invalid` | `required-field` | the field name | nothing else |
| `field-invalid` (`status`, `relevance`, `generated_from`, `verification`, `supersedes`) | `invalid-field` | the field name | nothing else |
| `tag-format`, `tag-alias`, `tag-vocabulary` | `tag` | the tag | each other, on one tag |
| `frontmatter-missing`, `frontmatter-invalid` | `frontmatter` | none | each other |
| `archived-primary` | `field-conflict` | `status/relevance` | nothing else |
| `supersedes-unresolved` | `broken-supersedes` | the target | nothing else |
| `supersedes-cycle` | `supersedes-cycle` | the cycle's members | nothing else |

Every audit, module and `--extra` category keeps its existing evidence rule.
Each finding records its contributing sources, never an empty list:
`validation` with the rule name, `audit` with the category, `module` with the
module name, `hygiene` for silent edits and index table lag, and `skill` for
`--extra`. Its severity is the most severe source's. Urgency is known only when
a source states it; otherwise it stays unknown.

**Evidence fingerprints.** A fingerprint is 12 hex digits of SHA-1 over the
category and a hash of each field below (`FINGERPRINT_FIELDS`,
`packages/core/src/lib/hygiene.ts:237-241`). Line numbers, messages, other
document content and age are never in it.

| Category | Fingerprint fields |
| --- | --- |
| `broken-link` | target as written; every link token naming that target, as written (`[[target\|label]]`); severity; urgency |
| `required-field` | field; its raw value (`absent` when missing); the rule it breaks; severity; urgency |
| any other | ID evidence; the validation rules reporting it (empty otherwise); severity; urgency |

Severity is `unknown` when no source gives one, and urgency is `unknown` when
none states one. The log records each field's hash beside the fingerprint, so
an invalidation can name the fields that changed.

**Storage and invalidation.** Dispositions live in markdown only: dismissed
entries in `context/hygiene/dismissed.md`, snoozed ones in `snoozed.md`. Each
records its time and the fingerprint it applied to. `until:` takes an ISO
date-time or a date; a date is due at the start of that UTC day, as before
(`function dueAt`, `packages/core/src/lib/hygiene.ts:834-844`). A recorded
fingerprint that no longer matches reopens the finding at once, with an
`invalidated:` receipt naming the changed fields and the disposition's date.
A snooze that comes due reopens it with no receipt.

When the change also changes the ID (a broken link's target is part of its
identity), the new finding carries the receipt only when the pairing is
unambiguous. In one run, exactly one disposition in force with that category
and path stops being detected, and exactly one new finding with them appears
(`if (prior.length === 1 && siblings.length === 1)`,
`packages/core/src/lib/hygiene.ts:1350`). Otherwise the new finding opens
without one. Either way the old disposition does not suppress it. Entries
moved by hand carry no fingerprint, so they keep their earlier behaviour.

## A disposition is not a repair or an authority grant

Dismiss and Snooze do not change the document, acknowledge a successful repair
or hide unresolved validation errors. Normal validation output and exit status
continue to report them. A failed or unavailable check cannot establish that a
problem was repaired. Resolve requires the approved bounded effect, current
permission, premise revalidation and a real post-apply check before success.

Do not implement dismissal by marking a still-detected finding resolved: existing
reconciliation reopens such an entry (`const prev = field(entry, "resolved-by")`,
`packages/core/src/lib/hygiene.ts:1324-1327`). Keep review disposition distinct from
actual check success and from notification acknowledgement.

Markdown remains authoritative for findings, dispositions and confirmed content
changes. The UI server's shared operational store owns review/Action execution
state; disposable `brain.db` is a projection, never their authoritative store.
Deterministic selection and writes belong in CLI operations with `--json`, not
SKILL.md, a second server queue or a React state machine.

Waiting for a decision retains no live agent turn or approval promise. Repeated
start/resume returns the pending item; pause preserves it without a disposition.
Leaving, disconnecting or an arbitrary timeout cannot apply a repair. Shared
principal authorization, path containment, locks, idempotency and recovery still
bind concurrent devices, stale evidence and interrupted effects.

## Alternatives rejected

- **Category-first ordering.** It can place a less severe eligible category ahead
  of a more severe problem. The chosen order uses source severity and known
  urgency before age, with stable identity providing deterministic ties.
- **One finding and disposition per source.** Equivalent audit and validation
  reports would ask twice and could disagree about dismissal or snooze. Explicit
  canonical equivalence retains provenance without duplicating the decision.
- **Fuzzy equivalence or invented urgency.** Similar text is not proof of one
  defect, and missing urgency is not permission for a model to manufacture it.
  Deterministic mappings keep distinct problems and unknown inputs visible.
- **Invalidate on any document change.** Unrelated heading/prose edits would
  repeat dismissed prompts and interrupt snoozes. Category-relevant evidence
  preserves the decision while allowing genuinely changed problems to return.
- **Treat dismissal as repair, or put the authoritative record in `brain.db`.**
  The first conceals still-failing checks; the second loses decisions on reindex.
  Separate review dispositions from detection and operational Action execution.

## Evidence required of an implementation

Use deterministic, keyless fixtures from the [Odysseus world](example-corpus.md).
Exercise the real selection, reconciliation, markdown writes and restart paths
with nonempty equivalent and distinct findings. Prove source-order independence,
retained provenance, tie-breaks and missing inputs, every invalidating and
non-invalidating example above, and unchanged snoozes returning when due.
Meaningful guard mutations must fail the intended identity, selection or
invalidation assertion, rather than an earlier parse/load error.

Interaction design must make evidence, priority reasons, effects, due times and
stale/failure states understandable under D36–D38 in [the design-kit record](design-kit.md).
This record chooses no card layout or initial repair-handler set. New CLI/HTTP
schemas and frontmatter/disposition semantics require their own assessment under
[the integration contract](../integration-contract.md), with contract updates
and package changesets when implemented. These policies authorize no unspecified
breaking change and do not establish completion of either tracking epic.
