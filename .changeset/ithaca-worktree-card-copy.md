---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": patch
---

`HygieneCard` accepts optional caller copy: `stateText` replaces the wording of any state, including the fixed outcome, and `busyLabel` replaces the applying label, as inert text; omitting them keeps every file default. The hygiene review uses them for a managed-worktree finding, so its card describes the removal or the check instead of a file edit: a finding with no repair offers "Check again" and says a worktree verified clean and unused may be reclaimed automatically, a confirmed removal reads "Worktree removed", another cleared finding reads "No longer needs review", and an uncertain reply reads "The outcome wasn't confirmed. Check again."
