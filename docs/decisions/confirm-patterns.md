# Reject an entirely invalid confirmation policy

The maintainer's [2026-09-29 ruling on #251](https://github.com/schlessera/brain-kit/issues/251#issuecomment-5895623801)
chooses rejection during initialization for a nonempty confirmation-pattern
list whose entries cannot compile. Previously both backend constructors
accepted such a list as an empty policy, so a regex typo disabled confirmation.

The rule lives in the shared helper (`compileConfirmPatterns`,
`packages/ui-sdk/src/server/confirm-patterns.ts:91-128`), which both
constructors call before creating their runtime. It also covers programmatic
consumers of the helper. The error names `confirmBashPatterns` and
`BRAIN_UI_CONFIRM_BASH`, includes the invalid sources and compiler diagnostics,
and tells the caller to repair them or intentionally use `[]`.

An explicit empty list remains the opt-out. Missing configuration retains the
shipped defaults. A mixed list keeps valid regexes, matching order and effects,
and reports each invalid entry through the existing callback.

Falling back to defaults for an entirely invalid regex list was rejected:
defaults cannot express the caller's intended commands, and an initialization
failure makes the configuration mistake visible before a turn can run. Skipping
every entry was rejected because it makes a typo equivalent to the intentional
empty-list opt-out. Rejecting every mixed list would remove valid customization
without being necessary to prevent the empty-policy failure.

The server's existing malformed-JSON and structural-entry fallback is outside
this ruling. A valid JSON regex list reaches the same backend compiler as direct
constructor options. This tightens initialization behavior before 1.0 and ships
as a minor with the break named in the changeset and integration contract.

Keyless regression tests exercise the compiler, real Claude and pi constructors
with scripted runtime probes, and the server registry with both real backend
modules. Removing the shared rejection makes the compiler return `[]`, lets the
constructors reach their runtimes, and lets the registry initialize; the named
tests fail on those behavior assertions rather than on module loading.
