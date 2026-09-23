---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

An approval that comes back with an edited input is re-checked before it runs, on both backends.

- Added: `checkEditedApproval` in `@schlessera/brain-ui-sdk/server`.
- Changed (pi): an edit that needs a confirmation the card did not show (another confirm pattern, another archived document) is refused instead of applied.
- Changed (Claude): an edited confirmation that passes the re-check is applied instead of refused, as `updatedInput` with no `permissionDecision`. `canUseTool` re-checks edits too, and the rtk rewrite leaves a confirmed command alone.
