---
"@schlessera/brain": minor
---

`brain skills lint` has a new warning, `manual-only-without-flag`. It fires when a skill's description says the skill is manual-only ("manual invocation only", "manual-only", "only when the user explicitly", "never invoke automatically") but its frontmatter lacks `disable-model-invocation: true`. Without the flag, Claude Code loads the description into every session. The message gives the description's estimated token cost and the fix.
