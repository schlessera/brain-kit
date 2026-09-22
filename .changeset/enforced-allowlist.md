---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

A turn can declare `enforceAllowedTools`, and a tool its allowlist leaves out
is then no longer re-admitted without a decision. Two paths used to do that.
The Claude backend's input-rewrite hooks answered `permissionDecision: "allow"`
so their `updatedInput` would apply, which makes the runtime skip `canUseTool`
entirely — an rtk-rewritten shell command ran in a turn whose allowlist had no
`Bash` in it, with no card and no record. And the ws host answered from its
remembered "always allow" grants before any card existed, so a grant given
under a wide posture was honoured under a narrow one.

Under the declaration the rewrites still rewrite — `updatedInput` applies
without a decision attached, so the rewrite was never what the grant was for —
and the host neither reads nor writes its grant store for a tool outside the
turn's allowlist. Backends mark such requests `outsideEnforcedAllowlist` so the
host does not have to guess. A turn that declares nothing is unchanged, and
existing grants keep working on the postures that can honour them.
