# Mandatory restricted-turn backend conformance

**Decided 2026-09-28 by the maintainer on
[#341](https://github.com/schlessera/brain-kit/issues/341#issuecomment-5866237390).**
Part of the [1.0 stability work](https://github.com/schlessera/brain-kit/issues/56).

## The decision

Every conforming backend handles `enforceAllowedTools` and `noGrantSurface`
when requested, or rejects an unsupported restricted turn with
`BackendRequestError` before acquiring a runtime, emitting frames or executing
tools. It must never silently ignore them. These remain optional per-turn
inputs; the mandatory baseline does not enable restrictions for ordinary chat
turns and does not freeze the rest of the experimental seam.

The existing permission semantics bind. Enforcement prevents runtime and
backend shortcuts from admitting an off-list tool without a permission
decision; the request marks `outsideEnforcedAllowlist` so remembered grants do
not bypass that decision. No-grant turns deny both tool grants and command
confirmations promptly, return the reason to the model and record a
`permission_denied` activity event without opening an unanswered card.
`noGrantSurface` without enforcement is invalid and rejects before work starts.
The [voice-permission record](voice-permission.md#the-fail-closed-primitive-and-how-it-was-reached)
explains why both fields and both request kinds exist.

## The executable baseline

The shared published suite exercises these restrictions for every backend
(`runBackendContract`, `packages/ui-sdk/src/testing/index.ts:183-291`). A
required runtime probe observes acquisition, attempted tools and the actual
tool-body effect (`PermissionProbe`, `packages/ui-sdk/src/testing/index.ts:57-66`).
Denial and approval use the same tool body: an allowing host must make the
effect observable, so an empty or permanently disabled script cannot prove
that denial prevented execution. A runtime-shortcut scenario tests the
off-list call a runtime would otherwise approve itself.

Safe rejection is a valid outcome only before acquisition, frames, permission
requests and effects. Both first-party adapters additionally demonstrate
actual enforcement. The Claude script drives its real SDK options and hooks
using the runtime precedence already measured in the repository. The pi script
uses the adapter's real per-session toolkit and production resource loader,
including the registered extension gate, then executes the real curated tool
when allowed. These keyless scripts do not replace the separate measurements
of an upstream runtime's permission precedence.

The descriptor suite parses a nonempty valid profile roster and resolves it
through `defineBackendModule`, preserving the declared profile ids under
default and disabled confirmation-pattern settings
(`runBackendModuleContract`, `packages/ui-sdk/src/testing/index.ts:114-151`).
It also checks typed invalid-JSON errors and occupied-id collisions.

## Alternatives rejected

- **Optional posture capability flags.** They would let conforming backends
  keep silently ignoring restrictions. The host needs a fail-closed baseline,
  not a second list of implementations a restricted posture cannot trust.
- **An optional harness declaration.** A skipped test cannot establish a
  backend's conformance. Runtime probes are required; a backend unable to
  enforce a restriction must demonstrate safe rejection.
- **Reject every restricted turn in first-party tests.** Safe rejection is
  useful for unsupported implementations, but does not prove that the shipped
  adapters' existing enforcement works.
- **Enable enforcement on every ordinary turn.** Mandatory support describes
  how a backend handles a requested restriction, not a new default posture.

## Compatibility

This tightens the published testing contract before 1.0. Existing third-party
backends may fail new cases and must supply the required permission probe.
It ships in a minor under [contract-versioning.md](contract-versioning.md),
with `contract` and `breaking` labels, a `CONTRACT:` commit and a changeset
naming the stricter requirements. The first-party runtime behavior and the
accepted wire shapes do not change.
