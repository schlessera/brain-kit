# Audit markers are informational, and counts are of findings (2026-09-30)

`brain audit` used to report one issue per `[TODO: …]` or `[VERIFY: …]`
marker, with TODO as `info` and VERIFY as a `warning`. A research file that
flags every claim it has not checked yet could then carry more warnings than
the rest of the brain together, and `brain maintain`'s daily count moved with
note-taking habits rather than with anything being wrong. #394 asked what a
marker is worth in those totals.

**Decision (the maintainer's ruling on #394, option A): one `todo` and one
`verify` finding per document, both `info`.** Each carries `count` and the
first three markers as `examples`, in source order. Severity stays the only
classification: must-fix means errors plus warnings, informational means
infos, and `brain audit` and `brain maintain` report both totals beside the
severity counts, computed by one function (`auditTotals`,
`packages/core/src/lib/auditor.ts:635-640`).

`brain briefing` shows that must-fix total in Upkeep even without hygiene logs.
It uses the same current audit pipeline, including enabled modules' hygiene
checks, and leaves informational findings out of the count.

## Why a VERIFY marker is informational

A marker is the author's note that a claim has not been checked. It shows no
defect: the claim may well be right, and the audit has no way to tell. The
must-fix half of the report is for what the audit can demonstrate, such as a
derivative older than its source, a stale focus document, a restated fact
that disagrees with its canonical value, or a link to nothing. Counting
"not yet checked" as must-fix trains a reader to skim past the warnings, and
then the real ones are skimmed too. A marker stays visible, as an `info`
finding with its count and examples, and `brain hygiene` logs it like any
other finding.

## Why counts are of findings, not markers

A document with forty markers needs one decision: check it, or leave it for
later. One finding per document and kind is that decision, and the `count` in
it says how big the job is. Counting markers instead let a single file
outweigh every other signal in the totals. The hygiene log follows the same
unit: a `todo` or `verify` entry's ID no longer includes the marker text
(`candidateFromAudit`), so adding or resolving a marker keeps the entry
rather than opening a new one.

## `verification: unverified`

Some documents are unverified as a whole: a research dump, an import, notes
from a call. Marking every sentence is noise, so the frontmatter can say it
once. Such a document gets exactly one `verify` finding, whatever inline
markers it also has. The declaration is stored in the index (schema 15,
`documents.verification`) so the audit reads it the way it reads every other
field.

There is deliberately no `verified` value. Absence does not mean verified, and
nothing records who checked what or when. A verified state would need a
workflow (who may set it, what happens when the document changes after) that
nobody has asked for. `brain validate` warns on any value other than
`unverified`, so `verification: verified` is flagged as a typo-shaped claim
rather than silently read as one.

## Broken links reuse the indexer's resolution

The same change added `broken-link` warnings to the audit. They come from the
`links` rows the indexer wrote with no target (`findBrokenLinks`,
`packages/core/src/lib/auditor.ts:607-619`), and the indexer resolves each
link with the resolver and alias fallback `brain validate` uses
(`function rebuildLinks`, `packages/core/src/lib/indexer/persist.ts:293-313`).
The message comes from one describer that both commands call
(`createUnresolvedLinkDescriber`,
`packages/core/src/lib/indexer/links.ts:99-111`). A second resolver in the
auditor would have been a second answer to "is this link broken", and the two
would drift. `brain stats` already counts the same rows as `brokenLinks`.

## Alternatives that lost

- **Keep per-marker findings, add an `actionable` boolean.** The ruling
  rejected a second axis. Two classifications that can disagree (a `warning`
  that is not actionable) would need rules for every consumer that sorts or
  counts, and severity already carries the distinction.
- **Keep VERIFY as a warning, grouped.** Grouping alone shrinks the numbers
  but still counts "not yet checked" as a defect in the must-fix total.
- **One marker finding per document, both kinds together.** A document with
  both would need two severities or one message mixing two jobs. Two
  findings keep each one about one thing, and `todo` and `verify` keep the
  categories consumers already filter on.
- **Read `verification` from the file at audit time.** It would need the brain
  root on every call and a second frontmatter parse beside the indexer's, and
  an index-only audit (no root) would miss it. A nullable column is additive
  and fills on the next incremental index, since the migration clears the
  content hashes.

## What was measured

The fixture corpus (`packages/core/fixtures/corpus/`), indexed and audited on
2026-09-30. Before: 0 errors, 18 warnings, 4 infos, with the one VERIFY marker
among the warnings. After: 0 errors, 19 warnings, 5 infos, so 19 must-fix and
5 informational. The VERIFY finding moved to the infos, and two new
`broken-link` warnings appeared: the two `[[does-not-exist]]` links that
`brain validate` already reported and `brain stats` already counted.

The change is breaking for a consumer that counted `todo` or `verify` issues
as markers, or treated a `verify` issue as must-fix. The migration notes are in
`docs/integration-contract.md`, under `AuditIssue`.
