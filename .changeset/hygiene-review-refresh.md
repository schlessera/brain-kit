---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Add explicit human-started hygiene finding refresh. Refresh replaces an obsolete
Action with current CLI evidence and previews, retains a superseded receipt,
and refuses old confirmations without changing Markdown or review position.
The CLI supports read-only targeted `hygiene next --finding <id> --dry-run`.
