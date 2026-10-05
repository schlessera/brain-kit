# Supported inputs have semantic compatibility

**Decided 2026-09-28 by the maintainer**, in
[#343 question 8](https://github.com/schlessera/brain-kit/issues/343#issuecomment-5866106215),
recorded through [#542](https://github.com/schlessera/brain-kit/issues/542).

## Decision

Protect deliberately supported user-facing inputs: brain configuration,
documented environment settings, per-module JSON settings and canonical module
content. Their accepted representation, meaning, units, validation, precedence,
defaults and migration/preservation rules are compatibility promises. Keep
implementation details internal. The [shared inventory](../supported-inputs.md)
defines coverage and delegates field references to their owners; the integration
contract includes those references rather than requiring every field there.

The existing [versioning rules](contract-versioning.md) apply. This ruling does
not freeze every export or experimental extension interface, schedule 1.0 or
grant cleanup an exception to existing promises. Supported-input breaks need
the existing prior ruling/breaking-label/changeset process before 1.0 and a major
from 1.0. Classify changes before implementation and provide an explicit migration
when a supported source or its meaning changes.

Defaults may evolve where a deliberately curated owner policy says they do, such
as [jobs board defaults](jobs-board-defaults.md). That is a specific policy,
not permission to change every default without compatibility review. Explicit
user choices retain their documented precedence and validation.

## Why the boundary includes semantics

An unchanged key can break a brain if its units or priority change. A compatible
schema alone cannot prove compatible behavior. Core's loader prefers TypeScript
over JSON and rejects an invalid selected config rather than falling back
(`loadUserConfig`, `packages/core/src/lib/config.ts:590-628`). Module settings
merge own object keys recursively, while arrays/scalars/null replace
(`mergeModuleSettings`, `packages/core/src/lib/module-settings-source.ts:10-18`).
Those are source-selection promises, not incidental implementation choices.

The shared settings path delivered by #528 validates the merged domain input
with the original manifest schema. Its writer checks source revision before
validation/replacement (`saveModuleSettings`,
`packages/core/src/lib/module-settings.ts:151-163`). Ordinary saves preserve
TypeScript logic and unrelated work; migrations explicitly preserve source
representations and canonical prose. An automatic normalized rewrite would
violate that boundary even if the next parsed score happened to match.

Environment meanings and exported descriptor shapes are distinct. #534 owns
public export curation. Dynamically selected credential names and filtered
subprocess forwarding must still be described according to their actual readers;
transporting an ambient variable does not make its meaning a product API.

Storage classification also needs evidence. `brain.db` is reconstructible, but
manual jobs review writes status, review time and notes to the jobs database
(`setReviewStatus`, `packages/module-jobs/src/review.ts:59-76`). Re-scraping cannot
reconstruct those decisions. An internal schema is not permission to discard
state. Existing file-layer/query promises remain binding, including for derived
data; an unclassified module file cannot be presumed disposable.

## Alternatives rejected

- **Freeze every implementation detail.** This would turn cache layouts,
  internal storage and ambient SDK inputs into accidental public formats.
- **Protect field names only.** Units, omission behavior, validation and source
  precedence can break users without renaming a key.
- **Give cleanup or all default changes an exemption.** That defeats existing
  promises and the prior-ruling requirement. Only explicit owner policies make
  a default deliberately evolvable.
- **Maintain a separate compatibility policy per module.** Module owners need
  domain field references, but one shared policy prevents inconsistent release
  and preservation obligations.
- **Treat every database as disposable or every stored schema as public.**
  Reconstructibility and compatibility are different questions. Preserve manual
  state without promising an internal SQL layout to independent consumers.

The ruling assigns compatibility cleanup to scoped work in the 1.0 epic. The
issue tracker carries that work; this record carries the boundary it must obey.
