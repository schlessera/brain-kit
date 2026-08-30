---
"@schlessera/brain-ui-server": patch
---

Skill installs read `BRAIN_UI_SKILLS_GITHUB_TOKEN` first, falling back to
`GITHUB_TOKEN` — the deployment-wide pattern is `<specialized>_GITHUB_TOKEN`
with a generic fallback, so a narrowly-scoped sync token and a read-only
skills token can coexist.
