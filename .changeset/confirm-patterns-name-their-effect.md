---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-react": minor
---

A destructive-command approval card now says what the command will do.

- Added: each default confirm pattern carries an `effect` phrase ("delete a directory and everything inside it"). A `command` approval's reason is that phrase, and both approval cards show it.
- Changed: `DEFAULT_CONFIRM_BASH_PATTERNS` entries are `{ pattern, effect }`. `confirmBashPatterns` and `compileConfirmPatterns` accept that form or a bare regex source; a bare source keeps the old generic sentence.
