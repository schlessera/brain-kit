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

## Wire protocol classification — 2026-09-28

The [maintainer's ruling on #343 question 5](https://github.com/schlessera/brain-kit/issues/343#issuecomment-5865905459)
classifies the client/server wire protocol as a **machine compatibility
contract now**. The protocol header already calls it that
(`COMPATIBILITY CONTRACT`, `packages/ui-sdk/src/protocol.ts:5-8`). Its frames,
validation policies and documented behavior follow the versioning rules above:
additions ship in minors; pre-1.0 breaks ship in minors only after a prior
maintainer ruling, with the `breaking` label and a changeset naming the break;
from 1.0, breaks require a major. Contract changes require `CONTRACT:` and a
same-commit integration-contract update.

The protocol is distinct from the experimental extension interfaces. A backend
implements the experimental `AgentBackend` seam and speaks the wire contract;
shipping both in `@schlessera/brain-ui-sdk` does not give them the same stability
classification. This ruling records the current boundary. It does not freeze
experimental interfaces immediately or schedule 1.0.

[Revision negotiation](../integration-contract.md#revision-negotiation) selects
which connection rules apply. It does not replace semantic versioning
or waive a documented compatibility guarantee. For example, requiring a reply
field from a previously tolerated client can be breaking even when the protocol
revision is incremented. The existing promises still bind: no hello means rev 2,
the host does not require `client_hello`, legacy clients keep the documented
tolerance, and an unknown declared revision is held to the newest rules the
host knows. These specific guarantees do not create a new promise to support
every past revision forever.

Two alternatives were rejected:

- **Treat the protocol as an experimental seam because of its package.** This
  would exempt client/server compatibility promises which already govern every
  backend, and contradict the explicitly non-pluggable protocol boundary.
- **Use a revision bump as permission to break compatibility.** A connection
  handshake determines applicable rules, not release versioning. Removing a
  documented guarantee still needs the breaking-contract process.

## Supported input classification — 2026-09-28

The scope sentence above predates the [question 8 ruling](https://github.com/schlessera/brain-kit/issues/343#issuecomment-5866106215).
The [supported-input decision](supported-inputs.md) clarifies that deliberately
supported brain config, environment inputs, per-module JSON settings and canonical
module formats are covered through the integration contract's delegated owner
references. Their meaning, validation, precedence, defaults and migration promises
bind changes even when the complete field reference lives in a module README.
Implementation details remain internal; the versioning rules above are unchanged.
