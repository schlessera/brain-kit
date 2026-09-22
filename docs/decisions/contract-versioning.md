# Contract versioning before 1.0

**Decided 2026-09-22 by the maintainer.** Binds every change to
[`docs/integration-contract.md`](../integration-contract.md).

## The decision

A change to the integration contract always needs a `CONTRACT:` commit prefix
and the contract doc updated in the same commit. Beyond that:

1. **An additive change ships in a minor.** A new `--json` field, a new optional
   input, a new MCP tool, or a `schema_version` bump for a migration that only
   adds (an index, a column). Nothing a consumer already reads changes.
2. **A breaking change also ships in a minor while the version is `0.x`**, but
   only after a maintainer ruling is recorded on its issue, with the `breaking`
   label and a changeset that names the break. A field removed, renamed or
   retyped, or a value whose meaning changes, is breaking.
3. **From 1.0, a breaking change needs a major version.** An additive one still
   ships in a minor.

## What it replaces

The contract doc said every contract change needed "a major version bump", and
`AGENTS.md`, `CONTRIBUTING.md` and the `contract` label said "a major-version
discussion". Three things showed the rule was not the one being followed:

- Additive changes were already merged with minor changesets, queued for
  0.37.0: `brain stats --json` gained its health and size sections (#94, #95),
  and `brain jobs scrape --json` gained `sources[].status` (#37).
- Under a lockstep `fixed` group at `0.x`, a literal major bump is `1.0.0`,
  which [ROADMAP.md](../../ROADMAP.md) and epic #56 reserve for the stability
  bar. The rule could not be followed without shipping 1.0 by accident.
- `docs/extending/README.md` already treated an experimental seam's breaking
  change as a minor-version event before 1.0. The contract and the seams were
  versioned by two different rules with no stated reason.

## Alternatives rejected

- **Every contract change is a major.** Correct after 1.0; before it, it either
  forces 1.0 early or leaves every contract PR waiting, which is what held #37's
  PR.
- **Rule per PR.** No written rule means each PR re-litigates it, and a reviewer
  cannot tell a deliberate exception from a mistake.

## What does not change

- The contract's scope. Anything not in `integration-contract.md` can still
  change without notice.
- Epic #56. 1.0 is still the point at which rule 2 stops being available.
