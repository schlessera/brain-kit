---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

A turn can declare `enforceAllowedTools`, and a tool its allowlist leaves out
is then no longer re-admitted without a decision.

Several things used to re-admit it, which is the point rather than the number.
The Claude backend's input-rewrite hooks answered `permissionDecision: "allow"`
so their `updatedInput` would apply, which makes the runtime skip `canUseTool`
entirely — an rtk-rewritten shell command ran in a turn whose allowlist had no
`Bash` in it, with no card and no record. The ws host answered from its
remembered "always allow" grants before any card existed, so a grant given
under a wide posture was honoured under a narrow one. And the runtime admits
some calls on its own before the callback is reached at all — by the shape of a
shell command, by the tool being a built-in, or because a hook declared in the
project settings said so.

Under the declaration the rewrites still rewrite — `updatedInput` applies
without a decision attached, so the rewrite was never what the grant was for —
a PreToolUse hook answers "ask" for every off-list tool, which overrides the
runtime's own auto-approval, and the host neither answers from nor adds to its
grant store for a tool outside the turn's allowlist. Backends mark such
requests `outsideEnforcedAllowlist` so the host does not have to guess, and it
records both halves of the refusal — a grant it declines to apply, and an
"always allow" it declines to keep. A turn
that declares nothing is unchanged, and existing grants keep working on the
postures that can honour them.
