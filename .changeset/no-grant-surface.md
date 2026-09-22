---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

A turn can declare `noGrantSurface`, and a permission request it cannot put to
anyone is then denied instead of parked. `enforceAllowedTools` removed the ways
a tool got admitted without a decision; what it left was the decision itself —
an off-posture tool raises an approval card, and in a turn nobody is looking at
(a spoken one, an unattended one) that is a card nobody can answer, held until
the turn budget expires.

Under the declaration both backends refuse the request where it is raised, with
a message that names the tool and is written to be read aloud, and report it on
the activity side channel so the record shows a denied span rather than a call
that errored. Both request kinds are covered, including the confirm-pattern
`command` request a destructive shell command raises for an allowlisted `Bash`
— on the Claude backend that one never reaches `canUseTool` at all. The mask
editor, which opens a window and then blocks on a region someone has to paint,
is withheld from such a turn rather than offered and blocked on.

The `ask` the Claude backend's enforcement hook answers is unchanged: it is
what beats the runtime's own shortcuts, and this changes the decision it
forces, not the ask. A turn that declares nothing is unchanged, and so is one
that declares only `enforceAllowedTools`.
