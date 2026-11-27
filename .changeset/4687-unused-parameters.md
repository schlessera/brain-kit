---
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

Internal: the autonomous-envelope builders no longer take an `observe` argument nobody passed, and the Claude tool-availability check no longer takes the tool input and working directory it never read (#4687). No entry point exports these functions and behaviour is unchanged.
