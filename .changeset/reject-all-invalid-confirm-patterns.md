---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

Pre-1.0 breaking tightening: nonempty `confirmBashPatterns` / `BRAIN_UI_CONFIRM_BASH`
lists with no valid regex now fail backend initialization instead of silently
disabling confirmation. Repair the reported invalid entries, or explicitly set
`[]` to disable confirmation. Missing configuration still uses defaults; mixed
lists keep valid patterns and effects while reporting invalid entries. Malformed
JSON and structurally unusable environment values retain their existing fallback.
