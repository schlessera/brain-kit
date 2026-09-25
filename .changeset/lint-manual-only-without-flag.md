---
"@schlessera/brain": minor
---

`brain skills lint` has a new warning, `manual-only-without-flag`. It fires when a clause of a skill's description states that the skill is manual-only ("Manual invocation only", "Manual-only", "Use only when the user explicitly…", "Never invoke automatically") but its frontmatter lacks `disable-model-invocation: true`. Quoted text, negations ("not manual-only") and limits on a single operation ("delete files only when the user explicitly asks") do not count. Without the flag, Claude Code loads the description into every session. The message gives the description's estimated token cost and the fix.
