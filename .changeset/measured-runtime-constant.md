---
"@schlessera/brain-backend-claude": minor
---

`MEASURED_RUNTIME` is now exported: the Claude Code / Agent SDK pair the
backend's permission design was last measured against. A keyless test fails
when the installed SDK is not that pair, and
`scripts/measure-claude-runtime.ts` in the repository re-measures every
behaviour the backend relies on, against a scripted loopback model, before the
constant moves.
